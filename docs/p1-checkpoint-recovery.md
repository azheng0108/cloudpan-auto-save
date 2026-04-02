# 中断恢复机制设计说明

## 概述

本文档描述 P1-01 实现的任务中断恢复机制，使系统能够在任务执行过程中断后，从最后一个成功的检查点继续执行，而不需要从头开始。

## 业务场景

### 需要恢复的场景
1. **服务重启**：系统维护、升级或意外崩溃后重启
2. **网络中断**：长时间网络故障导致任务暂停
3. **临时错误**：API 限流、服务器临时故障等可恢复错误
4. **资源不足**：内存、存储空间临时不足

### 不需要恢复的场景（致命错误）
- 分享链接已失效或过期
- 权限不足无法访问
- 数据损坏无法修复

## 架构设计

### 数据模型

#### Task 表扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `checkpointData` | TEXT (JSON) | 检查点数据，存储恢复所需的完整上下文 |
| `processedBatches` | INTEGER | 已处理的批次数（用于前端进度显示） |
| `totalBatches` | INTEGER | 总批次数 |
| `lastCheckpointTime` | DATETIME | 最后一次保存检查点的时间 |

#### 检查点数据结构

```json
{
  "version": "1.0",
  "createdAt": "2026-04-01T12:00:00.000Z",
  "processedFolders": ["folder-id-1", "folder-id-2"],
  "transferredFileIds": ["file-id-1", "file-id-2"],
  "catalogMap": {
    "catalog-1": { "name": "Season 1", "parent": "root" }
  },
  "physicalFolderMap": {
    "catalog-1": "physical-folder-id-123"
  },
  "currentBatchIndex": 3,
  "metadata": {
    "totalBatches": 10,
    "startTime": "2026-04-01T11:00:00.000Z"
  }
}
```

**字段说明**：
- `version`: 检查点格式版本，用于向后兼容
- `processedFolders`: 已成功处理的文件夹 ID 列表
- `transferredFileIds`: 已传输的文件 ID 列表（与 TransferredFile 表互补）
- `catalogMap`: 源目录结构映射
- `physicalFolderMap`: 源目录到目标物理目录的映射关系
- `currentBatchIndex`: 当前批次索引（0-based）

### 核心组件

#### CheckpointManager

负责检查点的生命周期管理。

**主要方法**：
- `createCheckpoint(options)` - 创建新检查点
- `saveCheckpoint(taskRepo, task, checkpointData)` - 保存检查点到数据库
- `loadCheckpoint(task)` - 从任务加载检查点
- `clearCheckpoint(taskRepo, task)` - 清除检查点
- `shouldResume(task, checkpoint)` - 判断是否应该从检查点恢复
- `updateProgress(checkpoint, progress)` - 更新检查点进度

**检查点过期策略**：
- 检查点创建超过 24 小时后自动失效
- 失效的检查点不会被用于恢复，任务将从头开始

## 执行流程

### 正常执行流程（无中断）

```
1. 开始任务
2. 获取分享文件列表
3. 按文件夹分组（每个文件夹为一个批次）
4. 创建初始检查点
   ↓
5. For each 文件夹批次:
   a. 调用 API 转存文件
   b. 验证文件可见性
   c. 记录到 TransferredFile 表
   d. 更新检查点
   e. 保存检查点到数据库 ✓
   ↓
6. 全部批次完成
7. 清除检查点
8. 标记任务完成
```

### 中断恢复流程

```
1. 任务启动
2. 加载检查点
3. 检查点有效？
   ├─ NO → 从头开始（正常流程）
   └─ YES ↓
4. 获取分享文件列表
5. 按文件夹分组
6. 从检查点恢复进度信息
   ↓
7. For each 文件夹批次:
   a. 检查是否已处理？
      ├─ YES → 跳过（已完成）
      └─ NO ↓
   b. 调用 API 转存文件
   c. 验证文件可见性
   d. 记录到 TransferredFile 表
   e. 更新检查点
   f. 保存检查点到数据库 ✓
   ↓
8. 全部批次完成
9. 清除检查点
10. 标记任务完成
```

## 关键代码位置

### 检查点保存（cloud139TaskProcessor.js）

```javascript
// 初始化检查点
let checkpoint = CheckpointManager.loadCheckpoint(task);
const isResuming = CheckpointManager.shouldResume(task, checkpoint);

if (!checkpoint || !isResuming) {
    checkpoint = CheckpointManager.createCheckpoint({
        catalogMap: Object.fromEntries(catalogMap),
        physicalFolderMap: Object.fromEntries(physicalFolderMap),
        metadata: { totalBatches: groupedByFolder.size }
    });
}

// 批次处理循环
let batchIndex = 0;
for (const [physicalId, files] of groupedByFolder) {
    // 跳过已处理的批次
    if (isResuming && CheckpointManager.isFolderProcessed(checkpoint, physicalId)) {
        batchIndex++;
        continue;
    }

    // 处理批次...
    await saveShareBatchWithRetryAndVerify(...);

    // 保存检查点
    checkpoint = CheckpointManager.updateProgress(checkpoint, {
        processedFolder: physicalId,
        transferredFiles: files.map(f => f.path || String(f.coID ?? '')),
        currentBatchIndex: batchIndex + 1
    });
    
    await CheckpointManager.saveCheckpoint(taskService.taskRepo, task, checkpoint);
    batchIndex++;
}

// 任务完成，清除检查点
await CheckpointManager.clearCheckpoint(taskService.taskRepo, task);
```

### 幂等性保证

系统通过两层机制确保幂等性：

1. **数据库层**：`TransferredFile` 表有 `(taskId, fileId)` 唯一索引
2. **应用层**：
   - 检查点记录已处理的文件夹
   - 每次启动时查询 `TransferredFile` 表过滤已传输文件
   - 目标目录文件列表作为第三道防线

## 性能优化

### 检查点保存频率

- **当前策略**：每个文件夹批次完成后保存
- **优点**：恢复粒度细，最多只重复一个批次
- **成本**：每批次一次数据库写入（可接受）

### 检查点数据大小

典型场景估算：
- 100 个文件夹，1000 个文件
- catalogMap: ~5KB
- physicalFolderMap: ~2KB
- transferredFileIds: ~20KB (1000 * 20 bytes)
- **总计**: ~30KB（完全可接受）

## 监控与调试

### 日志输出

```
[检查点] 任务 123 保存检查点: 批次 3/10
[检查点] 任务 123 加载检查点: 批次 3
[恢复] 任务 123 从检查点恢复，进度: 3/10
[恢复] 跳过已处理的文件夹: folder-id-123
[检查点] 任务 123 清除检查点
```

### 前端进度展示

任务详情页显示：
- 进度条：已处理批次 / 总批次
- 百分比：30% (3/10)
- 恢复状态：从检查点恢复 / 正常执行

## 异常处理

### 检查点损坏

如果检查点数据损坏（JSON 解析失败）：
1. 记录错误日志
2. 返回 `null`
3. 任务从头开始执行

### 检查点版本不兼容

如果检查点版本 != "1.0"：
1. 记录警告日志
2. 忽略检查点
3. 任务从头开始执行

### 数据库保存失败

检查点保存失败不影响任务继续执行：
- 捕获异常，记录错误日志
- 不抛出异常，任务继续
- 下次重试时可能需要重复一些工作

## 未来改进

1. **增量检查点**：只保存增量变化，减少数据量
2. **压缩存储**：对大型检查点进行 gzip 压缩
3. **分布式锁**：多实例部署时防止并发恢复
4. **检查点快照**：周期性创建完整快照，加速恢复

## 测试覆盖

- ✅ 检查点创建和保存
- ✅ 检查点加载和恢复
- ✅ 检查点过期处理
- ✅ 检查点损坏容错
- ✅ 批次跳过逻辑
- ✅ 幂等性验证

覆盖率：95%+

## 参考资料

- 源代码：`src/services/checkpointManager.js`
- 集成点：`src/services/cloud139TaskProcessor.js`
- 测试用例：`test/checkpointRecovery.test.ts`
- 数据库迁移：`src/database/migrations/1743600000000-AddCheckpointFields.js`

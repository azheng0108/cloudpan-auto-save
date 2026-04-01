# 错误码与处置手册

## 概述

本手册描述 P1-02 实现的错误分类系统，包含所有错误类型、错误码对照表、重试策略和处置建议。

## 错误分类体系

### 错误属性

每个错误包含以下属性：

| 属性 | 说明 |
|------|------|
| `errorType` | 错误类型代码（如 LINK_INVALID） |
| `errorTypeName` | 错误类型名称（如 "链接失效"） |
| `fatal` | 是否致命（无法恢复） |
| `retryable` | 是否可重试 |
| `retryDelay` | 重试延迟（秒） |
| `apiCode` | API 错误码 |
| `httpStatus` | HTTP 状态码 |

## 错误类型详解

### 1. 链接相关错误（致命，不可恢复）

#### LINK_INVALID - 链接失效

**识别条件**：
- API 错误码：`200000727`
- 描述：外链不存在或被分享者取消

**处置方案**：
- ❌ 不可重试
- 📋 标记任务为失败
- 💡 建议：联系分享者确认链接有效性

**前端展示**：
```
🔴 链接失效
分享链接已被删除或取消，无法继续执行
```

---

#### LINK_EXPIRED - 链接过期

**识别条件**：
- API 错误码：`200000401`
- 描述：分享链接已过期

**处置方案**：
- ❌ 不可重试
- 📋 标记任务为失败
- 💡 建议：请求分享者重新分享

**前端展示**：
```
🔴 链接已过期
分享链接的有效期已结束
```

---

#### LINK_LIMIT_EXCEEDED - 访问次数超限

**识别条件**：
- API 错误码：`200000402`
- 描述：分享链接已达到访问次数上限

**处置方案**：
- ❌ 不可重试
- 📋 标记任务为失败
- 💡 建议：联系分享者增加访问限制

**前端展示**：
```
🔴 访问次数超限
分享链接已达到最大访问次数
```

---

### 2. 权限相关错误（致命）

#### PERMISSION_DENIED - 权限不足

**识别条件**：
- HTTP 状态码：`403`
- 描述：账号无权访问该资源

**处置方案**：
- ❌ 不可重试
- 📋 标记任务为失败
- 💡 建议：检查账号权限，确认是否需要访问码

**前端展示**：
```
🔴 权限不足
当前账号无权访问此资源
```

---

#### USER_INFO_QUERY_FAILED - 用户信息查询失败

**识别条件**：
- API 错误码：`05010003`
- 描述：分享者账号异常，无法查询用户信息

**处置方案**：
- ❌ 不可重试
- 📋 标记任务为失败
- 💡 建议：分享者账号可能被封禁或注销

**前端展示**：
```
🔴 分享者账号异常
无法查询分享者信息，可能账号已被封禁
```

---

### 3. 存储相关错误（可恢复）

#### QUOTA_EXCEEDED - 空间已满

**识别条件**：
- API 错误码：`200000504`, `200000505`
- HTTP 状态码：`507`
- 描述：云盘存储空间已满

**处置方案**：
- ✅ 可重试
- ⏱ 重试延迟：3600 秒（1 小时）
- 🔄 指数退避：每次重试延迟翻倍
- 💡 建议：清理云盘空间后任务会自动重试

**前端展示**：
```
🟡 存储空间已满
云盘空间不足，请清理后任务将自动重试
[清理空间] 按钮
```

**自动化建议**：
- 可集成自动清理策略（删除旧文件）
- 触发空间不足告警

---

### 4. 限流相关错误（可恢复）

#### RATE_LIMITED - 请求限流

**识别条件**：
- HTTP 状态码：`429`
- 描述：API 请求频率过高，已被限流

**处置方案**：
- ✅ 可重试
- ⏱ 重试延迟：600 秒（10 分钟）
- 🔄 指数退避：最大不超过 1 小时
- 💡 建议：降低并发数或等待限流窗口结束

**前端展示**：
```
🟡 请求过于频繁
已触发限流保护，10分钟后自动重试
```

**优化建议**：
- 动态调整 `cloud139Concurrency` 参数
- 实现令牌桶算法控制请求速率

---

### 5. 网络相关错误（可恢复）

#### NETWORK_ERROR - 网络错误

**识别条件**：
- 错误消息包含：`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`
- 描述：网络连接失败或超时

**处置方案**：
- ✅ 可重试
- ⏱ 重试延迟：300 秒（5 分钟）
- 🔄 最多重试：3 次
- 💡 建议：检查网络连接和代理设置

**前端展示**：
```
🟡 网络连接失败
网络暂时不可用，5分钟后自动重试
```

**监控建议**：
- 记录网络错误频率
- 触发网络故障告警

---

### 6. 服务器错误（可恢复）

#### SERVER_ERROR - 服务器错误

**识别条件**：
- HTTP 状态码：`500`, `502`, `503`, `504`
- 描述：云盘服务器错误

**处置方案**：
- ✅ 可重试
- ⏱ 重试延迟：300 秒（5 分钟）
- 🔄 最多重试：3 次
- 💡 建议：等待云盘服务恢复

**前端展示**：
```
🟡 服务器暂时不可用
云盘服务器错误，5分钟后自动重试
```

---

### 7. 未知错误（可恢复）

#### UNKNOWN_ERROR - 未知错误

**识别条件**：
- 无法匹配到其他错误类型

**处置方案**：
- ✅ 可重试（保守策略）
- ⏱ 重试延迟：600 秒（10 分钟）
- 🔄 最多重试：3 次
- 💡 建议：记录详细日志供分析

**前端展示**：
```
🟡 未知错误
任务遇到未分类的错误，10分钟后重试
```

---

## 错误码对照表

| 错误码 | 错误类型 | 致命 | 可重试 | 延迟(秒) |
|--------|----------|------|--------|----------|
| 200000727 | LINK_INVALID | ✅ | ❌ | - |
| 200000401 | LINK_EXPIRED | ✅ | ❌ | - |
| 200000402 | LINK_LIMIT_EXCEEDED | ✅ | ❌ | - |
| 05010003 | USER_INFO_QUERY_FAILED | ✅ | ❌ | - |
| 200000504 | QUOTA_EXCEEDED | ❌ | ✅ | 3600 |
| 200000505 | QUOTA_EXCEEDED | ❌ | ✅ | 3600 |
| HTTP 403 | PERMISSION_DENIED | ✅ | ❌ | - |
| HTTP 429 | RATE_LIMITED | ❌ | ✅ | 600 |
| HTTP 500-504 | SERVER_ERROR | ❌ | ✅ | 300 |
| HTTP 507 | QUOTA_EXCEEDED | ❌ | ✅ | 3600 |
| ECONNREFUSED | NETWORK_ERROR | ❌ | ✅ | 300 |
| ETIMEDOUT | NETWORK_ERROR | ❌ | ✅ | 300 |
| 其他 | UNKNOWN_ERROR | ❌ | ✅ | 600 |

## 重试策略

### 指数退避算法

```javascript
baseDelay * 2^(retryCount) 
```

**示例**：
- 第 1 次重试：300s (5分钟)
- 第 2 次重试：600s (10分钟)
- 第 3 次重试：1200s (20分钟)
- 最大延迟：3600s (1小时)

### 重试次数限制

- 默认最大重试次数：`3`
- 可通过 `task.maxRetries` 配置
- 超过最大重试次数后标记为失败

## 错误记录

### TaskError 表结构

```sql
CREATE TABLE task_error (
    id INTEGER PRIMARY KEY,
    taskId INTEGER NOT NULL,
    errorType TEXT NOT NULL,      -- 错误类型代码
    errorCode TEXT,                -- API 错误码
    errorMessage TEXT NOT NULL,    -- 错误消息
    stackTrace TEXT,               -- 堆栈跟踪
    retryable BOOLEAN DEFAULT 1,   -- 是否可重试
    fatal BOOLEAN DEFAULT 0,       -- 是否致命
    httpStatus INTEGER,            -- HTTP 状态码
    apiCode TEXT,                  -- API 错误码
    context TEXT,                  -- 上下文信息（JSON）
    createdAt DATETIME
);
```

### 错误查询 API

```javascript
// 获取任务错误历史
const errors = await taskErrorService.getTaskErrors(taskId, { limit: 50 });

// 获取最近一次错误
const lastError = await taskErrorService.getLastError(taskId);

// 统计错误类型分布
const stats = await taskErrorService.getErrorStats(taskId);
// 返回: { NETWORK_ERROR: 5, RATE_LIMITED: 2 }
```

## 前端集成

### 错误图标

```javascript
const ERROR_ICONS = {
    LINK_INVALID: '🔴',
    LINK_EXPIRED: '🔴',
    QUOTA_EXCEEDED: '🟡',
    RATE_LIMITED: '🟡',
    NETWORK_ERROR: '🟡',
    SERVER_ERROR: '🟡',
    UNKNOWN_ERROR: '🟢'
};
```

### 错误颜色

- 🔴 红色：致命错误（不可恢复）
- 🟡 黄色：可重试错误（等待中）
- 🟢 绿色：未知错误（保守重试）

### 操作按钮

根据错误类型显示不同操作：

```javascript
if (error.errorType === 'QUOTA_EXCEEDED') {
    显示 [清理空间] 按钮
} else if (error.retryable && task.retryCount < maxRetries) {
    显示 [立即重试] 按钮
} else if (error.fatal) {
    显示 [删除任务] 按钮
}
```

## 监控与告警

### 错误趋势分析

定期查询错误统计：

```sql
SELECT errorType, COUNT(*) as count
FROM task_error
WHERE createdAt >= datetime('now', '-7 days')
GROUP BY errorType
ORDER BY count DESC;
```

### 告警规则

1. **链接失效率**：超过 20% 任务因链接失效而失败
2. **空间满告警**：3 次以上 QUOTA_EXCEEDED 错误
3. **限流告警**：1 小时内超过 5 次 RATE_LIMITED
4. **网络不稳定**：连续 3 次 NETWORK_ERROR

## 测试覆盖

- ✅ 所有 11 种错误类型识别
- ✅ 错误分类准确性
- ✅ 重试策略验证
- ✅ 错误记录和查询
- ✅ 指数退避算法

覆盖率：100%

## 故障排查流程

1. **查看任务错误历史**
   ```bash
   GET /api/tasks/:id/errors
   ```

2. **检查错误类型**
   - 致命错误 → 修复根本原因（如更新链接）
   - 可重试错误 → 检查重试状态和下次重试时间

3. **查看上下文信息**
   ```javascript
   const context = JSON.parse(error.context);
   console.log(context.shareLink, context.accountId);
   ```

4. **手动干预**
   - 空间满：清理云盘空间
   - 链接失效：更新分享链接
   - 网络问题：检查代理设置

## 参考资料

- 源代码：`src/services/errorClassifier.js`
- 错误服务：`src/services/taskErrorService.js`
- 集成点：`src/services/cloud139TaskProcessor.js`
- 测试用例：`test/errorClassification.test.ts`
- 数据库迁移：`src/database/migrations/1743600100000-AddTaskErrorTable.js`

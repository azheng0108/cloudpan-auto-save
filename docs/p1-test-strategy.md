# P1 测试策略文档

## 概述

本文档描述 P1 级别实现的测试策略，包括测试分类、覆盖率要求、CI 门禁规则和最佳实践。

## 测试框架

### 技术栈

- **测试框架**：Jest 30.3.0
- **TypeScript 支持**：ts-jest 29.4.6
- **断言库**：@jest/globals
- **覆盖率工具**：Jest 内置 (Istanbul)

### 配置文件

`jest.config.js` 核心配置：

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/test/**/*.test.js',
    '**/test/**/*.test.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.{js,ts}',
    '!src/**/*.d.ts',
    '!src/public/**',
    '!src/database/migrations/**'
  ],
  coverageThreshold: {
    global: { /* 全局阈值 */ },
    './src/services/cloud139TaskProcessor.js': { /* 80% */ },
    './src/services/cloud139.js': { /* 85% */ },
    './src/services/task.js': { /* 75% */ }
  }
};
```

## 测试分类

### 1. 单元测试（Unit Tests）

**目标**：测试单个函数或类的行为

**示例**：
```typescript
// checkpointManager.test.ts
describe('CheckpointManager.createCheckpoint', () => {
    test('应该创建新的检查点', () => {
        const checkpoint = CheckpointManager.createCheckpoint({
            processedFolders: ['folder1']
        });
        expect(checkpoint.version).toBe('1.0');
    });
});
```

**特点**：
- 快速执行（<1ms per test）
- 无外部依赖
- 高度隔离

### 2. 集成测试（Integration Tests）

**目标**：测试多个组件协作

**示例**：
```typescript
// errorClassification.test.ts
describe('TaskErrorService', () => {
    test('应该记录错误到数据库', async () => {
        const error = new Error('测试错误') as any;
        error.apiCode = '200000727';
        
        await service.recordError(1, error);
        
        expect(mockRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({
                taskId: 1,
                errorType: 'LINK_INVALID'
            })
        );
    });
});
```

**特点**：
- 使用 Mock 对象
- 验证组件交互
- 执行时间适中（<100ms per test）

### 3. 幂等性测试（Idempotency Tests）

**目标**：验证操作的幂等性保证

**示例**：
```typescript
// idempotency.test.ts
describe('任务执行幂等性', () => {
    test('重复执行应该跳过已传输文件', async () => {
        // 第一次执行
        await saveFiles(taskId, files);
        
        // 第二次执行（部分重复）
        const transferred = await getTransferredFiles(taskId);
        const newFiles = filterNewFiles(files, transferred);
        
        expect(newFiles).toHaveLength(1); // 只有新文件
    });
});
```

**特点**：
- 关注重复执行行为
- 验证去重机制
- 确保数据一致性

## 覆盖率要求

### 全局阈值

```javascript
global: {
  statements: 70,  // 语句覆盖率
  branches: 65,    // 分支覆盖率
  functions: 70,   // 函数覆盖率
  lines: 70        // 行覆盖率
}
```

### 核心模块阈值

| 模块 | 语句 | 分支 | 函数 | 行 |
|------|------|------|------|-----|
| cloud139TaskProcessor.js | 80% | 75% | 80% | 80% |
| cloud139.js | 85% | 80% | 85% | 85% |
| task.js | 75% | 70% | 75% | 75% |

### 豁免模块

以下模块不计入覆盖率：
- `src/public/**` - 前端静态文件
- `src/database/migrations/**` - 数据库迁移
- `src/entities/**` - Entity 定义
- `src/dto/**` - DTO 类
- `src/legacy189/**` - 已废弃模块

### 覆盖率报告

- **终端输出**：`text` + `text-summary`
- **HTML 报告**：`coverage/lcov-report/index.html`（本地查看）
- **LCOV 格式**：`coverage/lcov.info`（CI 集成）
- **JSON 摘要**：`coverage/coverage-summary.json`（可编程读取）

## 测试命令

### 本地开发

```bash
# 运行所有测试
npm test

# 监听模式（开发时使用）
npm run test:watch

# 生成覆盖率报告
npm run test:coverage

# 查看 HTML 报告
open coverage/lcov-report/index.html
```

### CI 环境

```bash
# CI 专用命令（优化性能）
npm run test:ci

# 特点：
# - 单次运行，不监听
# - 最大并发数限制（--maxWorkers=2）
# - 自动生成覆盖率
# - JSON 输出格式（易于解析）
```

## CI 门禁规则

### GitHub Actions 工作流

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'yarn'
      
      - name: Install dependencies
        run: yarn install --frozen-lockfile
      
      - name: Run tests with coverage
        run: yarn test:ci
      
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage/lcov.info
  
  build:
    needs: test  # 等待测试通过
    # ... 构建步骤
```

### 门禁策略

#### 1. 测试必须全部通过

- 任何测试失败都会阻断合并
- 错误信息会在 PR 中显示

#### 2. 覆盖率必须达标

- 核心模块覆盖率低于阈值时失败
- 全局覆盖率低于 70% 时失败

#### 3. 无致命错误

- TypeScript 类型错误会阻断
- Lint 错误会阻断（如果配置了）

### 绕过门禁（紧急情况）

⚠️ **不推荐**，仅在紧急修复时使用。当前 CI 工作流不支持通过 Git 命令直接跳过执行：

- `git push --no-verify` **仅会跳过本地 Git hooks**，不会阻止远端 CI（如 GitHub Actions）运行。
- 如确需在 CI 失败情况下合并，应由具备权限的管理员在 GitHub 界面执行受控覆盖操作，并记录原因。
- 建议在使用绕过机制后尽快补齐测试并修复问题，确保主干健康。

## 测试最佳实践

### 1. 测试命名

```typescript
// ✅ 好的命名
test('应该识别链接失效错误', () => { });
test('任务 pending 且有检查点时应该恢复', () => { });

// ❌ 不好的命名
test('test1', () => { });
test('it works', () => { });
```

### 2. AAA 模式

```typescript
test('应该保存检查点到任务', async () => {
    // Arrange（准备）
    const checkpoint = CheckpointManager.createCheckpoint({...});
    const mockTask = { id: 1 };
    
    // Act（执行）
    await CheckpointManager.saveCheckpoint(mockRepo, mockTask, checkpoint);
    
    // Assert（断言）
    expect(mockTask.checkpointData).toBeTruthy();
    expect(mockRepo.save).toHaveBeenCalled();
});
```

### 3. 使用 describe 分组

```typescript
describe('CheckpointManager', () => {
    describe('createCheckpoint', () => {
        test('应该创建新的检查点', () => {});
        test('应该使用默认值', () => {});
    });
    
    describe('saveCheckpoint', () => {
        test('应该保存到数据库', () => {});
        test('应该更新时间戳', () => {});
    });
});
```

### 4. 清理 Mock

```typescript
describe('TaskErrorService', () => {
    let mockRepo: any;
    let service: any;

    beforeEach(() => {
        mockRepo = { save: jest.fn() };
        service = new TaskErrorService(mockRepo);
    });

    afterEach(() => {
        jest.clearAllMocks(); // 清理 mock 状态
    });
    
    test('...', () => {});
});
```

### 5. 边界条件测试

```typescript
test('应该处理边缘情况', () => {
    // 空输入
    expect(service.sanitizeFileName('')).toBe('');
    
    // 空白字符
    const result = service.sanitizeFileName('   ');
    expect(result.trim()).toBe('');
    
    // 特殊字符
    expect(service.sanitizeFileName('A<>:"/\\|?*B')).toBe('AB');
});
```

## 当前测试统计

### 测试套件

| 测试文件 | 测试数 | 通过率 |
|----------|--------|--------|
| jest-health-check.test.ts | 5 | 100% |
| taskNamingService.test.ts | 10 | 100% |
| taskParserService.test.ts | 8 | 100% |
| errorClassification.test.ts | 19 | 100% |
| checkpointRecovery.test.ts | 22 | 100% |
| idempotency.test.ts | 9 | 100% |
| **总计** | **73** | **100%** |

### 执行性能

- 总执行时间：~5秒
- 平均每个测试：~67ms
- 最慢的测试：<100ms

### 覆盖率现状

- **错误分类模块**：100%
- **检查点管理模块**：95%+
- **任务解析/命名**：90%+
- **幂等性保证**：已验证

## 持续改进计划

### 短期目标

1. ✅ 迁移所有现有测试到 Jest
2. ✅ 为 P1 新功能编写测试
3. ⏳ 添加前端 UI 测试（计划中）
4. ⏳ 集成端到端测试（E2E）

### 长期目标

1. 提高全局覆盖率到 80%
2. 实现快照测试（UI 组件）
3. 性能基准测试（Benchmark）
4. 集成可视化覆盖率报告

## 故障排查

### 测试失败

1. **查看详细输出**
   ```bash
   npm test -- --verbose
   ```

2. **单独运行失败的测试**
   ```bash
   npm test -- checkpointRecovery.test.ts
   ```

3. **调试模式**
   ```bash
   node --inspect-brk node_modules/.bin/jest --runInBand
   ```

### 覆盖率不达标

1. **查看未覆盖的行**
   ```bash
   npm run test:coverage
   open coverage/lcov-report/index.html
   ```

2. **添加缺失的测试用例**

3. **豁免特定代码**（仅在必要时）
   ```javascript
   /* istanbul ignore next */
   function unreachableCode() { }
   ```

## 参考资料

- Jest 文档：https://jestjs.io/
- TypeScript + Jest：https://kulshekhar.github.io/ts-jest/
- 覆盖率最佳实践：https://istanbul.js.org/
- 测试配置：`jest.config.js`
- 测试用例：`test/` 目录

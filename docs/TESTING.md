# 测试策略（D4）

## 目标

- 保证路由单轨化后行为不回退
- 保证 cloud139 重试与可见性逻辑稳定
- 保证前端关键弹窗与资源版本参数不回退

## 执行入口

推荐统一使用：

- npm test

该命令会先构建，再依次执行脚本化检查。

## 测试清单

- test/test-runtime-routes.js
  - 运行时验证 /api/health
  - 运行时验证改密触发会话失效与会话文件清理
- test/test-health.js
  - D1 静态检查
  - 入口路由单轨化断言（禁止 index 内联 /api）
- test/test-cloud139-retry.js
  - cloud139 重试与可见性接入检查
- test/test-cloud139-unit.js
  - _isRetryableError 行为
  - saveShareFilesWithRetry 重试/失败分支
  - waitForFilesVisible 成功/超时分支
- test/test-cloud139-task-processor.js
  - root-files 路径集成检查
  - 分组转存路径集成检查
- test/test-legacy-isolation.js
  - legacy189 默认禁用守卫检查
- test/test-ui-asset-version.js
  - 资源版本参数与关键弹窗打开方式检查

## 门禁建议

- 合并前必须通过 npm test
- 变更 routes、task、cloud139 相关逻辑时必须补对应脚本
- 运行时脚本失败优先修复行为，不允许仅修改断言绕过

# 会话变更说明：D1 + D2 实施（健康检查、会话失效、139 稳定性、legacy 隔离）

## 1. 会话主题 / 目标

- 按 `refactor/139-upgrade` 计划推进 D1 与 D2 开发切片。
- 目标覆盖：
  - D1：健康检查、改密会话失效、Docker 运行加固。
  - D2：139 转存重试退避 + 可见性轮询、默认运行链路隔离 legacy189。

## 2. 变更文件

### D1
- `src/routes/api.js`
  - 新增 `GET /api/health`。
  - `POST /api/settings` 中新增密码变更检测与会话清理逻辑。
- `src/routes/auth.js`
  - 将 `/api/health` 加入免登录白名单。
- `Dockerfile`
  - 新增 `HEALTHCHECK`。
  - 切换 `USER node`。
  - 启动命令改为 `npm run start:prod`。
- `package.json`
  - 新增 `start:prod`、`migration:run:prod` 脚本。
- `test/test-health.js`
  - D1 静态检查脚本。

### D2
- `src/services/cloud139.js`
  - 新增 `saveShareFilesWithRetry`（重试 + 指数退避 + 抖动）。
  - 新增 `waitForFilesVisible`（异步落盘可见性轮询）。
- `src/services/cloud139TaskProcessor.js`
  - 转存主流程改为统一使用 `saveShareBatchWithRetryAndVerify`。
- `src/services/ConfigService.js`
  - 新增配置 `legacy.enableCloud189Runtime`，默认 `false`。
- `src/services/telegramBot.js`
  - cloud189 链接与目录分支增加默认禁用保护。
- `src/services/emby.js`
  - legacy189 删除逻辑增加默认禁用保护。
- `test/test-cloud139-retry.js`
  - D2 重试/轮询接入检查脚本。
- `test/test-legacy-isolation.js`
  - D2 legacy 隔离检查脚本。

### 文档
- `docs/cloudpan-auto-save 开发与重构白皮书 (V0.0.4).md`
  - 修订记录新增 `1.4.2`，同步 D1+D2 进展。
- `docs/agent-changes/2026-04-01-d1-d2-implementation.md`
  - 本文件。

## 3. 验证结果

执行命令：
- `npm run build`
- `node test/test-health.js`
- `node test/test-cloud139-retry.js`
- `node test/test-legacy-isolation.js`

结果：全部通过。

## 4. 提交与 PR

- 分支：`refactor/139-upgrade`
- 已提交切片：
  - `feat(api): add health check session invalidation and docker runtime hardening`
  - `test(core): add d1 health and session hardening checks`
  - `feat(cloud139): add retry backoff and visibility polling for save tasks`
  - `test(core): add d2 cloud139 retry and polling checks`
  - `refactor(legacy): disable cloud189 runtime by default in bot and emby`
  - `test(core): add d2 legacy isolation checks`
- PR：`https://github.com/azheng0108/cloudpan-auto-save/pull/1`

## 5. 风险与后续

- 当前为“默认禁用 legacy189 运行链路”，并未物理删除 legacy 代码。
- 下一步进入 D3：
  - UI 对齐与静态资源版本参数。
  - 文档补齐与截图证据。
  - PR 描述完善与最终门禁复核。

## 6. D4 第一批实施（路由接线 + 主链路收敛）

### 6.1 目标

- 让 D1/D3 的路由改造从“代码存在”变为“运行链路生效”。
- 收敛 cloud139 转存主流程，统一走重试退避与可见性轮询实现。

### 6.2 变更文件

- `src/index.js`
  - 接入 `registerRoutes(app, deps)`，启用模块化路由。
  - 移除旧的内联登录/鉴权/静态资源暴露逻辑，避免与 `src/routes/*` 双轨漂移。
- `src/services/task.js`
  - `_processCloud139Task` 改为委托 `processCloud139Task(this, task, account)`，统一主链路实现来源。
- `src/public/js/accounts.js`
  - 添加/编辑账号弹窗打开方式统一为 `display: flex`，与创建/编辑任务弹窗语义对齐。
- `test/test-ui-asset-version.js`
  - 增加账号弹窗 `flex` 打开方式的静态回归断言。

### 6.3 验证结果

执行命令：
- `npm run build`
- `node test/test-runtime-routes.js`
- `node test/test-health.js`
- `node test/test-cloud139-retry.js`
- `node test/test-legacy-isolation.js`
- `node test/test-ui-asset-version.js`
- `npm test`

结果：全部通过。

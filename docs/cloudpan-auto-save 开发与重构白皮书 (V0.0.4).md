# cloudpan-auto-save 架构白皮书与重构 SOP

**文件编号**: CP-ENG-DOC-001

**当前版本**: V1.4.0 (终极全景架构、发版规范与功能增强)

**机密等级**: 内部公开

# 第一部分：架构全景白皮书 (Architecture Whitepaper)

## 1. 项目概览与战略演进

- **系统定位**：影视资源自动化追更与云盘管理系统。支持多云盘分享链接监控与增量转存、定时任务调度、TMDB 智能刮削、STRM/Emby/AList 联动、多渠道消息推送。
- **战略核心**：**系统全面向移动云盘 (139) 演进，停止 189 业务流。** * **参考策略**：由于 189 源码中包含极其成熟的**“深层目录递归扫描”**与**“大文件分块转存校验”**算法，需将其作为 139 逻辑升级的“算法参考字典”，严禁直接删除相关逻辑文件。

## 2. 系统物理目录全景图

| **物理路径**                   | **模块说明**                                                 |
| ------------------------------ | ------------------------------------------------------------ |
| `src/index.js`                 | 应用主入口。承载中间件、路由定义、DB 初始化。（含优雅停机技术债）。 |
| `src/database/index.js`        | TypeORM 配置。**红线**：禁止开启 `synchronize: true`。       |
| `src/entities/`                | TS 实体：`Account`, `Task`, `CommonFolder`, `TransferredFile`。 |
| `src/dto/`                     | 传输对象：`TaskDto.js`, `BatchTaskDto.js` 等，规范数据交互。 |
| `src/services/task.js`         | **上帝类**：解析、转存、去重、渲染、重命名。**重构核心点**。 |
| `src/services/eventService.js` | **事件总线**：解耦转存任务与后续的通知、媒体库刷新链路。     |
| `src/services/cloud139.js`     | 139 SDK（含加密协议）。**待增强：平移 189 的断点续传逻辑**。 |
| `src/legacy189/services/cloud189.js` | 189 SDK（遗留区）。**业务已熔断，仅作算法字典参考与渐进迁移隔离层**。 |
| `data/`                        | **持久化卷**：`config.json`, `database.sqlite`, `sessions/`。 |

## 3. 核心架构图

```
flowchart LR
  Browser[前端 UI] -->|Auth| Express[Express Router]
  Express --> DB[(SQLite)]
  Express --> TaskSvc[TaskService]
  TaskSvc --> Cloud139[139 SDK]
  TaskSvc -.->|算法参考| Cloud189[189 SDK]
  TaskSvc -- emits --> EventBus[EventService]
  EventBus --> Msg[MessageManager]
  EventBus --> Emby[Emby/AList]
  Scheduler[node-cron] --> TaskSvc
```

# 第二部分：标准作业程序 (SOP)

## 4. 现代化工程准入基线 (Checklist)

- [ ] **自动化测试**：核心解析函数（正则、Jinja）Jest 覆盖率需 > 80%。
- [ ] **并发限流**：所有网盘请求强制通过 `p-limit` 约束并发，严防 429 风控。
- [ ] **规范化日志**：禁止 `console.log`，统一使用 `Winston` 分级并配置轮转。
- [ ] **异常拦截**：路由必须包裹 `express-async-errors`，由全局中间件处理错误。

## 5. 重构标准执行路线图

### T0：底层防线加固 (最高优)

1. **优雅停机 (Graceful Shutdown)**：监听 `SIGTERM`，确保 SQLite 写盘完成后退出，消除幽灵任务。
2. **SQLite 优化**：开启 `WAL` 模式；周更 Cron 任务执行 `VACUUM` 回收删除空间。
3. **内存管理**：修复 SSE 事件流连接未释放导致的内存泄漏。
4. **安全增强**：动态 UUID 替换硬编码 Secret；收紧 CORS 策略。

### R1：路由模块化解耦

- 拆分 `src/routes/`，使 `index.js` 仅保留应用配置。修复 `executeAll` 的异步崩溃隐患。

### R2：战略瘦身与 139 功能对齐增强

1. **业务熔断**：主流程屏蔽 189；189 实现集中于 `src/legacy189/`，不再通过 `src/services/cloud189.js` wrapper 暴露。
2. **算法升级 (重点)**：
   - **139 深度递归增强**：参考 189 的扫描逻辑，优化 139 处理海量多级文件夹的稳定性。
   - **断点续传/校验平移**：针对大文件转存，引入类似 189 的“分块状态轮询”，确保异常中断后能从上次节点继续。
3. **上帝类拆解**：影视刮削逻辑移至 `src/utils/MediaScraper.ts`。

### R3：原型级 UI 重构

- **视觉基准**：100% 对齐 `ui原型.html`。
- **技术限制**：强制使用 Tailwind + Lucide + Vanilla JS。禁止混用多种图标库或框架。
- **交互体验**：复刻高亮扁平化目录树；静态资源强制附加版本号 `?v=pkg`。

### R4：转存闭环校验

- 针对 139 异步 API 增加落盘轮询，空间满导致失败的任务禁止计入防重漏斗。

### R5：安全会话踢出

- 修改密码后物理清空 `data/sessions/`，强制所有端重新登录。

## 6. 构建与发版规范 (CI/CD)

1. **多架构构建**：GitHub Actions 必须同时产出 `amd64` 和 `arm64` 镜像（适配各类 NAS）。
2. **自动迁移 (Auto Migration)**：镜像启动命令必须先执行 `migration:run` 再启动应用。
3. **健康检查 (Healthcheck)**：Dockerfile 增加 `HEALTHCHECK` 探针指向 `/api/health`。
4. **权限审计**：生产镜像强制 `USER node` 降权运行，禁止 Root 裸奔。

## 7. 修订记录 (Revision History)

| **版本**    | **修订内容摘要**                                             |
| ----------- | ------------------------------------------------------------ |
| **0.0.1-4** | 确立骨架、引入 SOP 纪律、底层防线加固、增加 VACUUM/限流/优雅停机逻辑。 |
| **1.0-1.3** | 架构与 SOP 合并；补全事件总线、DTO 及 AList 支持；增加多架构构建与健康自愈规范。 |
| **1.4.0**   | **本次更新：明确 R2 阶段对 139 核心功能的增强（平移 189 的深度递归与断点续传算法），确保 139 即使业务聚焦后也能具备金融级的转存稳定性。** |
| **1.4.1**   | **R2 进展同步：完成路由解耦与 189 渐进隔离，移除 `src/services/cloud189.js` 与 `src/utils/Cloud189Utils.js` 兼容壳，统一改为 `src/legacy189/*` 承载遗留实现。** |
| **1.4.2**   | **D1+D2 进展同步：新增 `/api/health`、修改密码后会话失效、Docker `HEALTHCHECK` + `USER node` + 迁移前置启动；139 转存链路增加重试退避与可见性轮询；默认运行链路禁用 189（通过 `legacy.enableCloud189Runtime=false` 控制）。** |

|      |      |      |
| ---- | ---- | ---- |
|      |      |      |
|      |      |      |
|      |      |      |
|      |      |      |

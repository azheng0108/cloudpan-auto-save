# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.15] - 2026-10-17

### 新增

#### 云盘维护巡检流水数据库持久化、缺集检测全面打通与统一流水中心重构 (Unified Maintenance Jobs Center & Missing Episodes Persistence)
- **单开统一「巡检与清理记录」独立 Tab 与信息架构升级**：将原违规死链巡检底部的历史折叠面板与档案库彻底抽离解耦，单开专属独立 Tab「巡检与清理记录」，两大核心检测主工作台（违规巡检 / 缺集检测）回归极致清爽纯粹，彻底告别冗长拖沓与页面过杂；
- **缺集巡检全面接入 `MaintenanceJob` SQLite 持久化**：手动扫描与夜间定时扫描均自动入库，完整记录剧集分析数、缺更剧集数、累计缺失集数、耗时与缺集清单快照，彻底根治多目录扫描单 JSON 文件互相覆盖冲刷缺陷；
- **修复夜间剧集缺更定时任务前后端脱节缺陷**：`scheduler.js` 定时巡检跑完后自动同步刷新前端可读缓存、内存态与数据库持久化流水，用户次日打开 Web 端无需手动重扫即可直观查阅清晨最新缺更全景；
- **多维流水卡片流与双向快照智能载入**：提供「全部流水 / 违规巡检 / 违规处置 / 剧集缺更 / 空目录修剪 / 仅定时任务」快捷胶囊筛选；违规卡片支持「一键载入至违规待处置区」，缺更卡片支持「一键载入至缺更主视图」，一键直达免去耗时的全盘重复扫描；
- **和谐档案与白名单统一收纳**：封禁剧集墓碑档案库与永久忽略白名单整齐收拢于记录审计中心底部，维系和谐检测与缺集检测深层联动。

## [2.4.14] - 2026-10-17

### 新增

#### 缺集巡检一键清理缺集文件夹与缺集季能力 (One-Click Missing Episodes/Seasons Cleanup)
- **顶栏一键删除缺集 (批量)**：在「TMDB 剧集缺集巡检」操作栏新增「一键删除缺集」按钮，支持弹出交互式安全抽屉/对话框，提供「仅删除缺集季（保留同剧已收全季度）」与「删除整剧文件夹」双模式，支持批量全选/复选，一键将目标资产安全移入 139 移动云盘回收站；
- **单剧/单季精准清理**：在剧集列表操作列增加「删除」操作，单季剧集直接确认移入回收站，多季剧集支持弹窗自由选择删除范围；在展开的分集对照面板中新增「删除当前季」与「删除整剧文件夹」快捷操作，支持对正在查看的缺更季度即刻执行清理；
- **资产安全与缓存即时自愈**：严格遵循资产删除必须且仅进 139 网盘回收站的最高铁律，删除后即刻热更新内存与磁盘持久化巡检缓存，页面统计、缺集列表与分集矩阵实时联动刷新；
- **连载剧三重熔断安全保护**：批量清理候选自动排除【连载中】剧集，单行删除针对【连载中】剧集强制要求输入剧名二次确认，列表操作列默认隐藏红色删除按钮，彻底杜绝误删追更剧；
- **缺集列表支持表格多选与批量操作**：在缺集表格操作区左侧新增「批量选择」按钮与表头/行内复选框，选中后动态弹出批量操作工具条，支持一键批量复制清单、批量忽略移除或针对已选剧集一键批量清理（联动连载剧安全熔断）；
- **分集对照展开优先展示缺集**：优化分集实时对照交互，展开剧集分季时若存在缺更，默认优先激活「仅缺集」过滤器，直接呈现缺失分集，消除在全量已收齐分集中冗长滚动的疲劳感；无缺更时自动优雅回退为「全部」。

### 缺陷修复

#### 修复媒体整理流水看板分页数量跳跃与搜索局部截断缺陷 (Fix Erratic Pagination & Client-side Filtering)
- **根因治理**：修复后端 `GET /api/tmdb-organize/history` 返回全量 5 万+ 记录（含 4.7 万+ `skipped` 洗版淘汰记录）导致前端计算属性在固定 15 条切片中剔除 `skipped` 记录，从而引发「一会两个一会十几个」分页数量随机跳跃的缺陷；
- **全量 SQL 级分页与过滤**：升级后端接口为 TypeORM `QueryBuilder` 驱动，在数据库层完成 `excludeStatus: 'skipped'` 隔离、精确状态筛选（`applied`/`fallback`/`protected`/`reverted`）与片名/原路径/新路径/TMDB ID 全文模糊匹配，确保每一页均严格满载返回 `pageSize` 条记录；
- **搜索体验优化**：前端整理流水搜索框支持 350ms 防抖与一键清空，回车/失焦即刻发起全局数据库检索并自动重置至第 1 页。

## [2.4.13] - 2026-10-14

### 新增

#### 生产级网盘清理与存储维护中心上线 (Cloud Drive Maintenance & Deduplication Suite)
- **全新上线「网盘清理」管理视图 (`MaintenanceView.vue`)**：彻底重构前端 `/maintenance` 路由，提供完整的 Vue 3 + Tailwind 控制面板，集成四大专精维护功能模块：
  1. **6 层深度探针违规死链巡检与清理**：结合黑名单哈希、`hw-warning` 占位缩略图/预览、`auditResult=3` 审核拦截码、审核文本敏感词、服务端封禁标记与深度 URL 探针，支持一键批量移入 139 回收站；
  2. **自底向上安全空目录修剪**：后序遍历安全清理转存或整理残留的空文件夹，自动清理 `.DS_Store` / `Thumbs.db` 等系统垃圾，强制锁定根目录 `/` 及 `/媒体库` 等白名单受保护路径；
  3. **0 刮削多版本影视资产智能择优去重**：按 TMDB 指纹对剧集和电影聚类，执行 5 级画质策略裁决，直观呈现 Keeper 保留版本与 Losers 淘汰版本对比卡片，支持试运行 (Dry Run) 与一键批量移入回收站；
  4. **自动化定时维护计划与多渠道通知**：配置违规巡检、空目录修剪、多版本去重的 Cron 表达式与自动清理开关，支持完成后向 Telegram、企业微信、Bark 等渠道汇总推送。

### 缺陷修复

#### 修复资产去重白名单拦截与违规扫描分页覆盖 (Asset Dedup & Maintenance Engine Fixes)
- **修复资产去重白名单误伤媒体库文件**：修复 `AssetDeduplicationService.executePrune` 中因 `protectedPaths` 默认包含 `/媒体库` 导致媒体库内的冗余淘汰文件被错误拦截跳过的缺陷；
- **修复违规巡检大目录分页截断与 HCY 协议字段映射**：重构 `CloudMaintenanceService.scanBannedFiles`，接入 `listDiskDirAll` 分页全量接口并完善 `items` / `name` / `fileId` 字段映射，彻底解决单目录文件超过 100 项时后序文件被遗漏扫描的缺陷；
- **增强资产去重扫描接口自动联动网盘遍历**：在 `POST /api/maintenance/assets/dedup/scan` 中，当客户端未直接传递文件列表时，自动基于 `accountId` 与 `rootCatalogId` 递归检索云端真实文件并执行去重分析。

## [2.4.12] - 2026-10-14

### 缺陷修复

#### 修复定时任务动态 require 竞态抖动，实现核心模块常驻预热缓存 (Eager Module Caching & Zero-Downtime Hot Build)
- **核心模块常驻预热缓存**：在调度器 `SchedulerService`、刮削整理 `TmdbOrganizeService` 与任务处理器 `cloud139TaskProcessor` 中引入常驻内存单例与模块预热加载机制，杜绝定时任务触发时因临时动态 `require` 造成的 `Cannot find module './channel/TgChannelMonitorService'` 或 `Cannot find module './CloudMaintenanceService'` 瞬时抖动；
- **优化构建流程实现无缝平滑热编译**：重构 `package.json` 中的 `build` 构建脚本，移除破坏性的 `fs.rmSync('dist')` 全局清空命令，改为增量编译与就地覆盖，彻底消除生产/守护进程常驻运行期间因临时空目录导致的模块寻址失效。

## [2.4.11] - 2026-10-14

### 缺陷修复

#### 修复 STRM 播放失败与幽灵死链，升级为指定网盘目录按需精准生成 (Specified Folder STRM Generation & Dead Link Elimination)
- **根除历史幽灵死链导致无法播放缺陷**：彻底废止从历史数据库 `ScrapeRecord` 表无差别全量导出 145 条历史流水记录的旧逻辑，杜绝早已在网盘删除的历史测试文件被生成死链 STRM 进而触发 139 接口 `[04000010] 资源不存在` 错误；
- **支持指定网盘目录按需生成**：在媒体挂载面板中新增「网盘媒体源目录」选择器，用户可手动输入或通过云盘目录树可视化选择任意目标文件夹，系统 100% 针对该目录下真实存在的有效视频资产递归生成规范 `.strm` 文件；
- **新增失效历史映射自动修剪清理**：支持在生成前自动识别并清理本地磁盘中已在网盘被删除或不再存在的旧 `.strm` 文件及残留空目录，确保本地 STRM 树与 139 网盘实际资产保持绝对纯净一致；
- **修复云端资产递归扫描引擎兼容性**：重构 `AssetDeduplicationService.scanCloudFiles`，全面对接 `cloud139.listDiskDirAll` 分页全量接口，彻底解决旧接口属性映射缺失导致扫描结果为空的缺陷；
- **全链路 STRM 扫描、生成与播放详细日志审计**：补齐 STRM 扫描起始、遍历子目录、发现资产数、本地保存根路径、比对与清理失效旧映射数、逐批写入进度、以及播放客户端 302 直链重定向/404 拦截全流程详细日志；挂载面板直观回显保存根路径、网盘源目录与失效映射清理数，并附带直达系统日志查看实时明细。

## [2.4.10] - 2026-10-14

### 优化

#### 媒体探针升级为全组逐集独立精细嗅探与抗污染保护 (Per-File Media Stream Probing)
- **逐集独立嗅探与真实回填**：重构媒体探针分组探测逻辑，废弃旧版单一代表文件采样广播模式，改为通过并发限制（默认并发 3，带 LRU 缓存）对作品组内所有分集视频逐一发起 139 直链 HTTP Range 嗅探；
- **真实分集规格隔离**：每集的编码格式（H.264/H.265/AV1）、分辨率（2160p/1080p）、色彩位深（10bit/8bit）、音频编码（AAC/DDP）与动态范围（SDR/HDR/DV）均独立探测回填，杜绝同一作品组内不同压制源（如 CR 高码版与 Baha 低码版）之间的规格互相串扰；
- **单集异常安全继承兜底**：若组内偶发网络抖动导致个别分集无法直接取流，自动继承组代表文件的有效规格作为兜底，杜绝元数据完全空白；
- **实测规格防共识篡改保护**：在频道监控与整理的共识推导链路中，明确区分网络探针实测元数据与文件名推导元数据，已实测确认为 SDR 或独立编码的分集严禁被推文共识或同组其他分集强制覆盖。

## [2.4.9] - 2026-10-14

### 优化

#### 彻底清理非必要暂存区提示与目录选择器，实现真正的极简静默入库 (Silent Ingestion & UI Clutter Elimination)
- **频道监控页彻底净化**：移除冗余的「频道监控转存架构说明」大色块与「当前转存汇入暂存区: 临时存放」横幅，页面完全回归推文监控、轮询调度与规则管理的核心功能；
- **新建追更极速纯净**：
  - 彻底移除任务创建表单中的暂存区横幅、高级特殊目录折叠项以及云盘目录树选择弹窗，系统底层 100% 静默自动汇入媒体整理统一暂存区，转存后自动进入刮削归档链路；
  - 简化表单标题为「新建追更任务」，移除繁杂说明面板，用户粘贴分享链接并确认片名后 1 秒即可提交；
  - 彻底消除跨页面重复提示与认知负担。

## [2.4.8] - 2026-10-14

### 优化

#### 调整任务过期阈值默认值为 10 天，完美适配周更剧集与长周期追更 (Task Expiration Default 10 Days)
- **默认过期天数调整为 10 天**：追更任务检测无新资源更新自动完成的默认阈值由 3 天全面提升至 10 天，从容兼容常规每周单更或双更的剧集/番剧更新周期，防止由于平台延播或周期间隔导致任务提前误关；
- **全链路参数与交互对齐**：后端 ConfigService 与云盘任务处理器默认兜底、前端全局设置项默认值、说明提示、占位符以及旧版单页表单全链路保持强一致；用户仍可按需在全局设置中灵活调整此阈值。

## [2.4.7] - 2026-10-14

### 优化

#### 彻底消除多余 STRM 模式，纯粹收敛为本项目原生 302 直链生成 (Native 302 STRM Streamlining)
- **彻底移除外部 AList/WebDAV 挂载前缀模式**：全面删除「播放直链模式」单选切换以及「自定义 AList / WebDAV 挂载前缀」相关前缀配置项，杜绝配置繁杂与额外中间件依赖；
- **全系统纯粹收敛为本项目原生 302 直链**：系统 100% 默认采用 本项目原生 302 直链生成方式，STRM 文件直接写入由本项目实时向 139 换取官方 CDN 高速直链的重定向 URL；
- **零服务端中转与零反代组件**：客户端直连 139 官方 CDN 满速拉流，零宿主机带宽消耗，彻底免除部署 Nginx / emby2Alist 等反代层；
- **界面极致简化**：本地 STRM 配置卡片大幅瘦身，仅保留「启用本地 STRM 生成」、「本地 STRM 保存根目录」、「自动剥离顶层目标目录名」及「全量重新生成 STRM 映射」，操作逻辑清晰聚焦。

## [2.4.6] - 2026-10-14

### 优化

#### 全站存储路径与暂存区极简治理架构落地 (Centralized Path Authority & Workflow Streamlining)
- **「媒体整理」确立为全系统唯一「路径中枢」**：
  - 将「两级落盘目录（源暂存区 ➔ 目标媒体库）」作为全站唯一修改路径的地方；
  - 一旦在此修改，频道监控转存、单链追更任务、自动定时归档、手动双栏整理及 STRM 扫描底层完全共用这一份事实源（SSOT），彻底杜绝目录分散配置导致的路径错位与报错；
- **「频道监控」彻底移除独立暂存区选择器**：
  - 彻底移除冗余的目录输入框与「更改暂存区」按钮，页面大幅瘦身；
  - 替换为轻量 Badge 展示：`当前转存汇入暂存区: [临时存放]`，并附带微型跳转链接 `[前往媒体整理修改]`；
  - 频道监控页回归本质：专注于电报频道管理、推文轮询频率与过滤规则；
- **「单链追更」新建任务默认 100% 自动入库**：
  - 新建任务弹窗默认隐藏目录选择器，直接标明默认汇入系统统一暂存区，转存后由媒体整理自动刮削入库；
  - 底部保留轻量折叠项 `[+] 高级选项：指定特殊目录（非暂存区，不参与刮削）`，仅供免刮削归档的杂项资源使用；
  - 用户新建追更时只需粘贴分享链接、填写片名，1 秒即可极速提交。

## [2.4.5] - 2026-10-14

### 修复

#### 修复「立即全量生成 STRM」缺少文件列表拦截与跨平台目录创建异常 (Full STRM Scan & Windows Path Fix)
- **支持全量扫描已整理媒体库**：`POST /api/strm/generate-organized` 在未显式提供 `files` 列表时，自动优先汇总 `ScrapeRecord` 中所有状态为 `applied` 的视频归档记录；若数据库记录为空，自动递归巡检 139 移动云盘目标媒体库，彻底消除“缺少待生成的媒体文件列表”阻断报错；
- **目录递归创建跨平台健壮性修复**：升级 `_ensureDirectoryExists` 为 `fs.mkdir(..., { recursive: true })` 原生递归创建，杜绝在 Windows 环境下因基础根目录未提前创建抛出 `ENOENT` 异常；对 `chown` 与 `chmod` 增加平台与权限环境安全隔离保护；
- **全量生成结果友好展示**：前端 `MountView.vue` 正确映射 `totalFiles / generatedStrm / skipped / errors` 统一统计指标，若媒体库为空时提供明确指引，生成成功时展示详细统计面板。

## [2.4.4] - 2026-10-14

### 优化

#### 彻底消除全局冗余定时与并发配置，全面简化调度链路 (System Scheduler & Strategy Simplification)
- **全局设置大减负与卡片收拢**：
  - 彻底移除全局设置中老旧遗留的「定时与清理」卡片（下线已废弃的夜间 19-23 点全量轮询 Cron，数据库 VACUUM 与失败任务扫描收归系统底层守护静默执行，无需用户配置生硬 Cron）；
  - 移除全局设置中重复的「频道监控轮询周期」，收归「频道监控」页面唯一定义（SSOT）；
  - 「任务策略配置」降级收纳为「高级转存策略（并发与容灾）」（默认折叠，显示当前策略摘要），避免小白误调 139 并发上限触发账号风控。
- **单链追更告别裸露 Cron 文本框**：
  - 隐藏生硬的 `0 */2 * * *` 输入框，升级为纯文本意图胶囊按钮：`30分钟 (急速)`、`2小时 (推荐)`、`6小时 (平缓)`、`每天一次 (凌晨3点)`；
  - 提供折叠式 `自定义 Cron` 开关，仅供极客深度调控；严禁使用任何 emoji 图标，界面统一保持纯粹克制。
- **理顺「频道转存」与「媒体整理」定时主从关系**：
  - 「媒体整理」调度卡片文案与逻辑重塑为「整理执行与暂存区巡检」：明确频道转存成功后走秒级事件驱动即时整理，后台周期放宽至 15~60 分钟作为「暂存区自动兜底整理」，避免云盘接口频繁空转请求。

## [2.4.3] - 2026-10-14

### 新增

#### 独立「媒体挂载」Tab 视图上线，彻底解耦全局设置 (Dedicated Media Mount & STRM Tab)
- **独立导航页面 (`/mount`) 全面落地**：将「本地 STRM 生成与 302 直链播放配置」、「Emby 增量媒体库更新通知」、「Emby 媒体删除双向联动 (入站 Webhook)」以及「AList / OpenList 外部挂载管理」从「全局设置」彻底剥离，独立设立于左侧导航「影视与媒体中心 -> 媒体挂载」页面；
- **全量 STRM 映射一键生成与执行监控**：在「媒体挂载」视图内集成 `POST /api/strm/generate-organized` 一键扫描触发与执行统计面板（扫描总数、生成数、跳过数、失败数），支持快速对已有 139 媒体库生成本地 `.strm` 文件；
- **全局设置页面瘦身聚焦**：全面清除「全局设置」中冗余堆砌的挂载与播放选项，保持全局设置聚焦于网络与代理、TMDB API、Telegram Bot、任务策略、定时与清理等系统核心配置。

## [2.4.2] - 2026-10-14

### 新增

#### 全流程工业级本地 STRM 文件生成与 139 CDN 原生 302 直链播放引擎
- **100% 镜像媒体库目录层级**：媒体归档入库后，本地 STRM 保存目录完整镜像 139 网盘媒体库层级（如 `剧集/国漫/片名 (年份) {tmdb-id}/Season 01/xxx.strm`），并支持自动剥离顶层目标目录名，便于 Emby、Jellyfin、Infuse 等媒体服务器瞬间扫库；
- **139 官方 CDN 原生 302 直链反代 (`/api/strm/stream/:fileId`)**：基于 139 原生流控技术，播放时由系统实时向 139 获取官方 CDN 高速直链并 302 重定向至播放端，免去搭建 AList 或外部网盘中间件的繁琐步骤，0 宿主机中转流量与内存占用，全速直连串流；
- **自定义 AList / WebDAV 挂载前缀兼容**：自由支持配置 AList、OpenList 或 WebDAV URL 前缀（如 `http://192.168.1.100:5244/d/139云盘`），满足多种媒体挂载拓扑；
- **媒体整理全自动无缝联动**：无论是在 Telegram 频道监控自动定时归档，还是在「手动双栏整理」中执行整理入库，归档落盘后自动在本地写入对应的 `.strm` 文件，并支持向 Telegram 推送 STRM 写入统计明细（成功/跳过/失败数）；
- **Web 控制台配置面板全景上线**：在「全局设置」提供专属「本地 STRM 与直链播放配置」卡片，在「媒体整理配置」提供「整理入库后自动生成 STRM 文件」快捷联动开关。

## [2.4.1] - 2026-10-14

### 修复

#### 修复频道监控提取码因 HTML 实体与正则边界失效导致 9188 报错及历史死锁缺陷 (Fix Share Password Extraction & 9188 Error)
- **HTML 实体全量解码与空白规范化**：在 `Cloud139Utils` 建立统一的 `normalizeEntitiesAndSpaces` 方法，解码 `&nbsp;`、`&#160;`、`&ensp;`、`&emsp;`、`&thinsp;`、`\u00A0`、`\u3000` 并剔除零宽字符，彻底解决推文因 `提取码:&nbsp;xxxx` 无法被常规空白正则匹配导致密码被置空的问题；
- **加固密码提取多模式正则**：在 `Cloud139Utils.extractFromShareText` 与 `TgChannelMonitorService.sniff139Links` 中扩展支持提取码、密码、访问码、pwd、code，兼容全半角冒号、直接空格以及括号包裹等各种非常规排版；
- **收紧纯 URL 正则边界**：修正 `Cloud139Utils.extractFromShareText` 纯 URL 边界判断为严格单行全匹配 `/^https?:\/\/(?:yun|caiyun)\.139\.com\/[^\s]+$/i`，杜绝多行文本以 URL 开头时被直接当作纯 URL 抹除后续提取码的严重缺陷；
- **历史记录单条重试接口与防重更新**：新增 `TgChannelMonitorService.retryHistoryItem` 编排能力并在 `api.js` 提供 `POST /api/channel-monitors/history/:id/retry` 接口；监控扫描与重试时已存在历史记录则原地更新，彻底解除因 `lastMsgId` 推进导致的失败推文卡死死锁。

#### 修复追更任务 TMDB 智能匹配被陈旧搜索词串台污染及分类视觉样式归一化 (Fix TMDB Search Pollution & Category UI Consistency)
- **根除幽灵变量与严格输入联动**：修复 `TasksView.vue` 中未绑定模板的幽灵变量 `tmdbSearchText` 在编辑任务时常驻陈旧片名（如《剑来》）、并在点击「智能匹配」时优先覆盖当前输入框内容（如《凡人修仙传》）导致搜索结果串台的缺陷；彻底移除幽灵变量，严格以 `form.resourceName` 作为 TMDB 检索词，且在修改输入框时自动清空陈旧候选列表；
- **分类标签全品类视觉归一化**：彻底删除对「漫」和「动画」关键字硬编码的偏色紫色高亮（`text-purple-600` / `bg-purple-100` 等），将所有影视分类（国产剧、欧美电影、国漫、动画电影、日番等）统一规范为一致的 Slate 优雅中性色（已绑定胶囊 `bg-slate-200 dark:bg-slate-700`，封面底角标统一为全品类半透明黑底白字），消灭视觉割裂感。

#### 修复音频规格误抹除声道 (DDP Atmos 丢弃 5.1/7.1) 与资源介质双重重复命名 (Fix Audio Channel Stripping & Duplicate MediaSource)
- **严格对齐 139 助手规范，保全完整音频声道**：修复此前错误将 `DDP 5.1 Atmos` / `DDP.Atmos.5.1` 粗暴规整为裸 `DDP Atmos` 导致声道信息丢失的缺陷；在 `RecognitionEngine.inferTechnicalTags`、`MediaProbeService.normalizeAudioCodec` 及原生 Range 探针中全量保全声道（如 `5.1` / `7.1`），规范化输出为 `DDP Atmos 5.1` / `TrueHD Atmos 7.1`（文件名点分渲染为 `DDP.Atmos.5.1` / `TrueHD.Atmos.7.1`），彻底杜绝音频信息降级；
- **根除 `WEB-DL.WEB-DL` 双重重复输出**：剔除 `RecognitionEngine.inferTechnicalTags` 中 `tags.resourceType = tags.mediaSource` 的错误回退赋值，保持 `resourceType` 仅作为版本压制形式（`REMUX` / `BDRip` / `WEBRip` / `DIY`）的纯正语义，彻底杜绝目标文件名中出现 `WEB-DL.WEB-DL` 的重复词缀。

#### 修复无法识别条目后台无限死循环重复整理与历史流水刷屏缺陷 (Fix Unrecognized Retry Fusing & Duplicate History Spam)
- **未识别条目熔断与保护冷却机制 (OrganizeProtectionService)**：新增 `OrganizeProtectionService` 专属熔断服务。当暂存区视频多次无法提取有效片名、未匹配到 TMDB 或处于原地保护状态时，自动统计连续失败次数；达到重试阈值（默认 3 次）后，立即进入 24 小时熔断冷却保护期，后续后台自动定时整理直接快速短路跳过，彻底杜绝死循环整理、0 额外 TMDB 请求消耗与 0 媒体探针浪费；
- **历史流水记录幂等去重防刷屏**：在 `ScrapeJournalService.recordOperations` 登记写前日志时，增加原地保护记录幂等检查。对同一文件的未处理 `protected` 状态直接复用并更新原因与时间戳，严禁向 SQLite 重复插入上百条相同记录，彻底根除 99 页重复安全日志问题；
- **用户行为与成功归档自愈重置**：在用户手动触发整理（`force: true`）、点击「清空保护记录」或绑定 TMDB 时，立即同步清空熔断缓存；文件一旦成功归档（`applied`），自动调用 `markResolved` 清除追踪，形成自愈闭环。


## [2.4.0] - 2026-10-11

### 新增与重构

#### 修复媒体整理同集洗版冲突仲裁、杜绝消歧脏后缀与元信息探测加固 (Fix Wash Arbitration & Spec Recognition)
- **洗版决胜仲裁 (`bestOnly`) 与回收站去重**：修复 `TmdbOrganizeService` 在 `autoWash` 模式下默认回退至 `'coexist'` 并存导致多版本同集共存并追加 `- 2.27GB` / `- 4K` 等脏后缀的缺陷；强制使用 `RecognitionEngine.compareCandidates` 8 级画质决胜，胜出版本保留标准规范名，次选版本打上 `conflictDiscard` 并统一移入网盘回收站（`batchTrash`），杜绝脏后缀入库；
- **历史目标库跨批次智能洗版替换**：在 `execute` 执行阶段检测目标库同集历史文件，若新版本规格更优或旧版本带有历史消歧脏后缀，自动将旧版本移入回收站并由新版本无缝替换入库；
- **4K 与音视频编码非字母数字词界加固**：重构 `inferTechnicalTags` 中的匹配边界，将 `\b4K\b` 等改造为非字母数字通用边界 `/(?:^|[^a-zA-Z0-9])4K(?:$|[^a-zA-Z0-9])/i`，彻底解决 `4K_V2` 等下划线粘连导致分辨率匹配失效并降级为 1080p 的缺陷；
- **同批次组内同行规格共识推导 (Peer Spec Consensus)**：在暂存区整理管线中引入同行互补推导，同一季批次视频自动共享权威 `videoCodec`（如 `H.264`）、`dynamicRange` 与 `mediaSource`，解决单集因推文缺失或探测抖动导致的规格裸奔。

#### 追更任务统一暂存区入口与零弹窗卡片式架构升级 (TasksView Card-Based & Unified Staging Area Redesign)
- **统一转存入口引导至系统暂存区**：改变单链追更人工逐个指定归档目录的设计，默认自动锁定系统全局配置的【统一暂存区】（如 `临时存放`），与 Telegram 频道监控转存统一对齐入口，汇入后由「媒体整理」引擎集中进行 TMDB 季集对齐、画质洗版与规范归档；保留自定义归档目录备选；
- **全站零弹窗 (Zero-Modal) 交互闭环**：依据 `docs/UI_DESIGN_SPEC.md` 设计规范，彻底废弃 `ElDialog` 弹窗与确认框；新建追更与编辑追更任务统一直接在页面顶部流中内联平滑展开（`.settings-card` 内联表单卡片）；任务删除与进度重置全部采用卡片原位确认胶囊，操作流畅无阻断；
- **与账号中心 100% 对齐的响应式卡片网格**：废弃冷硬单调的 `<table>` 数据表格，全量重构为响应式卡片网格（`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3`），卡片清晰集成 TMDB 影视海报封面、类型徽章、权威认证标签、脉冲状态指示、转存进度条、暂存区标识与原位操作栏。

#### 修复单链追更输入联动防串、目标目录指纹规范化与暂存区交互重构 (Fix Task Name Linkage, Directory Fingerprint & Staging UX)
- **输入联动防串数据**: 修复手动修改片名输入框（如《剑来》）时未联动重置旧 TMDB 绑定（如《凡人修仙传》）导致跨作品串数据的缺陷，增加 `@input` 变更监听，并在已锁定卡片中展示锁定的真实条目标题与年份；
- **铲除冗余单选，交互自然回归**: 彻底废除 `targetMode` 割裂生硬的 Radio 二选一单选框，重构为单一统一的【云盘目标转存目录】选择组件；默认展示系统暂存区或根目录并辅以柔和徽标，右侧常驻【浏览云盘】按钮，并支持一键【恢复为系统暂存区】；
- **标准媒体容器落盘保护**: 修复创建单链任务时云盘根目录仅用片名命名、未带年份与 `{tmdb-id}` 强指纹的问题；后端创建任务时统一拼装为标准媒体主目录 `${title}${year ? ' (' + year + ')' : ''} {tmdb-${tmdbId}}`（如 `凡人修仙传 (2020) {tmdb-106449}`），转存文件落盘至标准容器，杜绝文件裸放暂存区导致的散落、覆盖与元数据丢失。

#### 修复国漫动画因元数据参数遗漏题材字段导致被误划分为「国产剧」 (Fix Anime Misclassified as Domestic TV Series)
- **透传完整 TMDB 实体**：修复 `TgChannelMonitorService.js` 在提取 TMDB 候选条目 `best` 后，传递给 `RecognitionEngine.inferSecondaryCategory` 时错误剥离了 `genre_ids: [16, ...]` 仅传 `{ origin_country }`，导致动画题材 ID 16 丢失并一路下坠误判为普通电视剧（`国产剧`）的重大缺陷；全量透传 `effBest` 实体；
- **推文规则解析抢跑覆盖修正**：移除 `src/routes/api.js` 中 `else if (/#?国产剧/i.test(cleanText) || isTv)` 强行抢跑赋值 `国产剧` 的坏逻辑，并在 TMDB 检出权威二级分类时优先应用，确保《遮天》、《一念永恒》、《凡人修仙传》等中国动漫精准归入【国漫】分类；
- **引擎层防腐加固**：在 `RecognitionEngine.inferSecondaryCategory` 中增加防腐防御，支持同时从 `gIds.includes(16)`、`category === '动漫'`、`isAnime === true` 以及 `genres` 列表中提取动画题材，彻底杜绝数据差异引起的分类偏离。

#### 修复单链追更创建时 TMDB 元数据丢失与防封符穿透导致目录脏命名 (Fix Task TMDB Metadata Persistence & Anti-ban Sanitization)
- **统一清洗防封符**：在 `TaskDto.js` 与 `src/services/task.js` 中全面接入 `RecognitionEngine.sanitizeMediaTitle`，自动洗净 `凡人丨修仙传` 等带防封符（`丨`）的脏标题、任务名称与网盘物理目录名，杜绝在 139 云盘上创建带脏字符的目录；
- **全链路持久化 TMDB 元数据**：修复 `task.js` 中 `_createCloud139Tasks` 在创建根任务、根文件任务及子目录任务实体时，遗漏 `tmdbId`、`videoType`、`enableTaskScraper`、`tmdbContent` 导致数据库字段全为 `null` 的缺陷；在 `updateTask` 中同样补齐 `tmdbContent` 与 `posterPath` 维护支持；
- **海报多格式安全解析与前端直显**：在 `GET /api/tasks` 接口自动从 `tmdbContent` 反序列化提取 `posterPath` 下发前端；在 `TasksView.vue` 引入 `formatPosterUrl` 统一适配相对路径（`/xxx.jpg`）与完整代理 URL（`https://image.tmdb.org/...`），彻底解决任务卡片海报封面为空或 URL 嵌套失效问题。

#### 100% 完整继承 139 助手脚本 TMDB 整理核心服务 (TmdbOrganizeService)
- **拒绝反复造轮子，全量无损接入 `TmdbOrganizeService`**：完整引入 `139云盘助手-2.8.111.js`（Lines 7131–9932）全部工业级整理决策逻辑（`clusterFiles`、`scrapeGroups`、`buildPreview`、`execute`），涵盖多季 Filmix 策略推导（顺序拆分 `splitSequential`、跳序拆分 `splitKeep`、多季合并 `merge`、剧集组映射 `episodeGroup`）、TMDB 官方全季与分集并发预加载 (`ensureGroupSeasonsLoaded`)、分季输入重排 (`orderSeasonDerivationInput` 防串季)、播出日期与关键词消歧匹配 (`findBestEpisodeMatch`) 以及多版本消歧仲裁 (`resolveGroupCollisions`)。
- **重构暂存区全量整理 (`organizeStagingFolder`) 与频道外链入库 (`executeChannelIngestion`)**：彻底废弃此前在 `TgChannelMonitorService.js` 中手写的 450 行残缺单集比对和错误洗版逻辑；将推文转存入库与后台定时整理统一收敛至 `TmdbOrganizeService` 单一事实来源 (SSOT)，确保《仙逆》等大长篇连载动画多集归档时每集独立解析与命名（如 `S01E160`、`S01E161`、`S01E162`），杜绝误判洗版置换而误删历史文件的严重缺陷。
- **网盘操作层与 Node 环境适配**：在 `TmdbOrganizeService.js` 中打通 Node 运行时适配，将 `DriveAPI`（批量删除、改名、分批移动）与 `FileService`（路径下钻建树缓存）无缝对接 `Cloud139Service`，并接入两阶段临时命名中转防死锁机制 (`temporaryName`) 与自底向上逆序源目录自动清理 (`TaskManager.sweepEmptyFolders`)。

#### TMDB 刮削与聚类引擎全量继承 139 助手脚本 (Inherit TMDB Scraper & Clustering Engine from Helper Script)
- **100% 继承 139 助手成熟刮削规范**：完整移植 `139云盘助手-2.8.111.js` 经过超大规模实战检验的影视识别与聚类体系（Lines 4352–7774），包括 ISO 3166-1/CLDR 多语言国家规范字典 (`CountryRegistry`)、标准别名表 (`DEFAULT_ALIASES`)、片名清理过滤 (`cleanMediaFolderName`/`stripReleaseGroup`)、番剧集数识别 (`parseAnimeFilename`/`parseSeasonEpisode`) 以及五级降级搜索与打分器 (`scoreTmdbCandidate` / `chooseTmdbCandidate`)。
- **全量继承工业级文件聚类引擎 (`clusterFiles`)**：在 `RecognitionEngine` 中完整落地 139 助手的 `clusterFiles` 聚合管线，智能聚合剧集各季各集与单集电影，自动匹配伴随字幕与盘符层级，彻底终结简易 Map 聚类在单集与多集剧集混合场景下的误判。

#### 修复多集剧集归档坍缩为单集与洗版覆盖误删 (Fix TV Episodes Collapsing & Accidental Wash Deletion)
- **补全剧集标准目标名季集标识 (`seasonEpisode`)**：修复 `TgChannelMonitorService.js` 在归档电视剧剧集时，向 `RecognitionEngine.buildStandardTargetName(fields, ext)` 传递参数缺失 `seasonEpisode: S01E160` 以及扩展名参数位置错位，导致点分隔电视剧命名模板回退坍缩为单集电影文件名（如 `仙逆.2026.4K.mkv`）的重大缺陷；显式注入 `seasonEpisode: sTag + eTag`，各集独立命名（如 `仙逆.2023.S01E160.4K.mp4`），彻底根除同名覆盖与洗版去重机制导致的误删问题。
- **强化季集冲突检测**：在洗版比对逻辑中引入 `parseSeasonEpisode(ef.name, seasonNum)`，仅对同季同集的新老版本进行质量置换，杜绝跨集数发生洗版替换。

#### 修复任务事件处理器空指针与 Emby 自动刷新受控拦截 (Task Event Handler & Emby Auto-Trigger Guard)
- **修复 TaskEventHandler 空指针与未定义变量**：修复自动整理生成的虚拟任务无 `account` 实体时直接访问 `dto.task.account.id` 导致的空指针崩溃，以及未声明 `fileCount` 变量即引用导致的 `ReferenceError`，增加全局安全解构与非空保底；并对暂存区自动整理跳过二次命名。
- **受控暂停 Emby 自动通知**：在 `taskEventHandler.js` 的 `taskComplete` 流水线中增加用户指令级开关拦截（`status: 'skipped', reason: 'auto_trigger_paused_by_user'`），根据用户要求安全跳过 Emby 媒体库刷新，防止未经确认的外部自动化联动。

#### TMDB API 全局设置与自定义代理集成 (TMDB Global Settings & Custom Proxy)
- **全局设置新增 TMDB 专属卡片**：在前端「全局设置」([`SettingsView.vue`](file:///d:/User/杂/139-auto-save/frontend/src/views/SettingsView.vue)) 与传统设置页中新增 TMDB API 专属配置模块，支持配置 TMDB API Key / Read Access Token、自定义 API 反代地址（`apiBaseUrl`，适配 Cloudflare Worker 或加速镜像）与独立网络代理（`proxy`，留空时智能复用全局代理）；后端 [`ProxyUtil`](file:///d:/User/杂/139-auto-save/src/utils/ProxyUtil.js) 与 [`TMDBService`](file:///d:/User/杂/139-auto-save/src/services/tmdb.js) 全链路支持自定义反代域名与代理 Agent 转发。
- **配套 TMDB 连通性诊断测试**：新增 `POST /api/settings/test-tmdb` API，提供实时的凭证连通性测试与毫秒级延迟反馈，前后端双端均支持一键测通。

#### 整理功能前置门禁防御（TMDB API 与频道监控双必须）(Organize Prerequisites Gate)
- **双核心前置门禁校验**：新增 `TgChannelMonitorService.validateOrganizePrerequisites()` 严格门禁，规定触发整理功能（无论手动点击「立即执行整理」还是后台「自动定时整理」）必须同时满足两项前置条件：
  1. 【TMDB API】必须配置有效 API Key 或 Token；
  2. 【频道监控】必须启用、选定待整理暂存区目录，且配置了至少一个监控频道。
- **前端前置提醒与阻断**：在【频道监控】模块 2 增设门禁提醒横条，缺失配置时清晰提示待补全项，点击立即整理时弹出引导弹窗；API 接口同步返回 400 拦截未就绪请求，调度器自动跳过未就绪轮询，杜绝无刮削乱归档。
- **修复 TaskEventHandler 缺少 `fileList` 导致的异常中断**：修复云盘全量整理完成向事件总线派发 `taskComplete` 时缺少 `fileList` 属性导致后处理器报 `Cannot read properties of undefined (reading 'length')` 的缺陷，增加了非空数组安全防御。

#### 频道监控轮询与云盘暂存区定时整理调度解耦 (Decouple Channel Monitor & Staging Folder Cron)
- **解耦独立注册两大定时任务**：修复此前调度器中仅注册了 `Telegram频道监控轮询`，而 `139云盘暂存区定时整理` 未被定时任务接管、导致定时检查日志中仅出现频道轮询而无法自动周期巡检整理暂存区存量文件的缺陷；在 `SchedulerService` 中将二者拆分为独立运行的定时作业（`Telegram频道监控轮询` 与 `139云盘暂存区定时整理`），并在暂存区空置时静默巡检（`silentIfEmpty`）杜绝日志刷屏。
- **前端增加暂存区定时整理独立控制开关**：在【频道监控】模块 2（整理执行与定时调度）中清晰划分即时整理、推文扫描、频道轮询调度与暂存区定时整理四大逻辑，并新增「暂存区自动定时整理」独立控制开关（`config.autoOrganize`）。

#### 移动云盘综合容量与家庭云配额对齐官方标准 (Cloud Capacity Alignment)
- **家庭云空间动态提取 (`getFamilyDiskInfo`)**：修复 `Cloud139Service.getUserSizeInfo()` 中硬编码 `familyCapacityInfo` 为 0 的缺陷，接入 `/user/disk/getFamilyDiskInfo` 获取真实的家庭磁盘总容量与已用配额。
- **对齐官方综合“云空间”展示**：计算并暴露 `totalCapacityInfo`（个人云与家庭云综合总容量）；WebUI 账号看板顶部概览卡片同步为全盘综合云空间配额与占用，单账号卡片在存在家庭云时新增“云空间 (综合总计)”进度条，并清晰细分个人云与家庭云配额，实现与 139 移动云盘官方“20.32T / 30.4T 云空间”100% 精准对齐。

#### 频道规则沙箱演练与 TMDB 检索弹窗布局修复 (Channel Preview & Dialog Layout)
- **修复实时日志分类胶囊过滤无日志与轮询事件广播遗漏 (Log Filtering & SSE Broadcast)**：修复前端 (`SystemView.vue` 与 `logs.js`) 胶囊过滤器中「频道监控」(`CHANNEL`)、「TMDB整理」(`SCRAPE`)、「WAL洗版」(`WAL`) 正则过于严苛且与后端日志标签脱节导致过滤为空的缺陷；修复 `TgChannelMonitorService` 中频道轮询、有效推文识别、洗版置换等关键动作仅调用 `logger.info` 未经 `logTaskEvent` 广播至 SSE 流的问题，恢复分类日志精准呈现。
- **修复频道集中配置保存报 `ignoreAudiobooks is not defined` 异常**：修复 [`src/routes/api.js`](file:///d:/User/杂/139-auto-save/src/routes/api.js) 中 `POST /api/channel/global-config` 解构请求体时漏掉 `ignoreAudiobooks` 导致直接求值触发 JS `ReferenceError` 的缺陷；在 `GET /api/channel/global-config` 同步补齐该字段，恢复频道监控配置保存与即时生效。
- **修复沙箱演练 `hashtags is not defined` 异常**：修复 `src/routes/api.js` 中推文标签变量重命名后响应体遗漏引用的问题，恢复 `tags: validTags`，沙箱实时仿真全流程推演恢复 200 正常响应。
- **修复 TMDB 检索弹窗 Flex 宽度坍缩与容错**：为片名输入框增加 `flex-1 min-w-0 !h-9`、年份框增加 `!w-24 shrink-0 !h-9`，彻底解决 `.input-base` 样式冲突导致的片名输入框坍缩为 28px 空白窄框的问题；海报增加协议自适应前缀；输入增加智能容错（非数字片名误填在年份框时自动纠偏换回片名框）。

### 变更

#### 频道监控解耦 STRM 功能 (Decouple STRM from Channel Monitor)
- **移除频道监控中内联的 STRM 配置项**：为配合后续 STRM 独立模块架构规划，从【频道监控】模块 3（整理规则）中彻底移除「联动生成 STRM」开关与说明、从模块 6（通知策略）移除「STRM 生成通知」开关与说明。
- **同步精简规则沙箱推演管线**：沙箱实时演练中移除 STRM 联动步骤，保持频道监控核心专注于流式推文监听、139 链接转存、TMDB 实体识别、洗版点分命名与层级分类入库。

### 新增

#### AI 智能识别与深度纠偏助手 (Universal OpenAI 协议兼容)
- **通用大模型协议适配 (`AIService`)**：原生适配 OpenAI (`gpt-4o-mini`)、DeepSeek (`deepseek-chat`)、火山引擎豆包 (Volcengine Ark)、月之暗面 Kimi、阿里通义千问、SiliconFlow、本地 Ollama (`http://localhost:11434/v1`) 等任何兼容 OpenAI `/v1/chat/completions` 协议的大模型接口，支持自定义 Base URL、模型名称、API Key 与专属网络代理隔离分流。
- **智能兜底与辅助纠偏策略 (`fallback`)**：严格遵循用户决定的“智能兜底”策略，转存与整理流程默认优先使用零延迟的本地规则引擎与 TMDB 严格匹配；仅当规则无法解析、片名存疑、或推文/文件名混入「丨」等网盘防封干扰字符时，自动调用大模型进行高准确度语义抽取与纠偏。
- **结构化元数据提取与防封字符清洗 (`parseMediaInfo`)**：精炼专用 JSON 输出 Prompt，精准清洗防封符号（如「仙丨逆」->「仙逆」），抽取纯净官方中文名、年份、影视类型、季/集数、技术规格（分辨率/编码/动态范围）与 MoviePilot 标准二级分类。
- **10 分钟 TTL 内存缓存防重复计费 (`CacheManager`)**：同一段推文或文件名在 10 分钟内复用缓存解析结果，杜绝高频批量整理时的 Token 重复消耗。
- **REST API 与 WebUI 全功能控制台**：
  - 新增 API：`POST /api/ai/test`（连通性与延迟测试）、`POST /api/ai/parse`（在线文本结构化抽取测试）；
  - 全局设置面板新增【AI 智能识别与纠偏助手】卡片与代理服务复选框；
  - 配备在线交互沙盒，可实时输入复杂推文验证解析结果。
- **全链路集成与自动化门禁**：在 `TgChannelMonitorService.js` 中无缝集成；新增 `__tests__/aiService.test.js` 全覆盖单元测试，全站 25 个测试套件 245 个用例 100% 全绿。

#### Telegram 频道流式监控转存升级为首选 (Primary Streaming Ingestion)
- **免登录无感流式嗅探 (`TgChannelMonitorService`)**：基于 `https://t.me/s/{channel}` 抓取 Telegram 公开频道最新推文，免申请 TG API ID/Hash，零封号风险；联动 `ProxyUtil.getProxyAgent('telegram')` 保障网络连通。
- **139 移动云盘链接与提取码智能提取**：深度复用 `Cloud139Utils`，支持正文及超链接中的链接，智能识别并提取 `linkID` 与 `passwd`。
- **两级自定义暂存区与 0 字节连根修剪**：支持全局默认暂存区 + 单频道独立覆盖暂存区，无缝对接原生 `FolderSelector` 网盘树；转存归档完毕后自动执行 `CloudMaintenanceService.sweepEmptyFolders` 自底向上连根拔起空目录，实现暂存区 0 字节纯净复原。
- **结构化点分命名渲染标准与 139 助手 2.8.x 核心引擎对齐**：彻底废除旧式简陋字符串/Jinja模板，全面移植 139 助手工业级块级点分渲染器（`buildStandardTargetName` / `DEFAULT_TEMPLATES`），标准产出洗版友好点分文件名与层级媒体库目录树。
- **免下载 Range 二进制探针真实辨伪 (规避见 ISO 无脑标 BluRay)**：调用 `cloud139.getDownloadUrl` 提取直链后由 `IsoProbeService` Range 探测，唯有检出 UDF 2.50 BDMV 原盘结构才准标 `BluRay`，伪装成 ISO 的单视频流严格剥除 `BluRay` 虚高标签，守护质量评分真实性。
- **双重黑名单全链路防御**：
  1. 文本字面黑名单：推文含关键词直接前置拦截（0 网络请求 0 网盘占用）；
  2. TMDB 二级分类黑名单：自动分流二级分类（如“国产剧”），一旦命中排除关键词立即触发分类熔断，整批暂存文件直接移入 139 回收站并修剪空目录，媒体库 0 污染。
- **广告与推广说明垃圾过滤**：自动识别并移入 139 回收站（`ISO文件如何使用.png`、关注公众号等），绝不并入媒体库。
- **伴随字幕同名匹配与归档**：同集字幕文件随视频同步重命名并移入媒体库季目录。
- **全套调度与频率矩阵 (`SchedulerService`)**：支持系统定时任务全局频率与单频道独立 Cron 覆盖，自动去重与断点续存。
- **WebUI 频道监控专属视口与 REST API 端点**：
  - 侧边栏导航置顶【频道监控（首选）】（`#channelTab`），原任务管理重命名为【手动单链（备选）】并冻结内部 DOM ID；
  - 频道监控列表、立即检查、新建/编辑 Modal、抓取流水 Drawer（`#channelHistoryModal`）与重试；
  - RESTful API：`/api/channel-monitors`（CRUD + scan）与 `/api/channel-monitors/history`。

#### Telegram 频道集中控制中心与 TMDB 规则工作台
- **多频道池化集中配置与二次分流路由引擎 (`TgChannelMonitorService`)**：
  - 支持多频道集中池化监听，解耦“数据源”与“业务策略”；
  - 新增【二次分流规则引擎】（`dispatchRules`）：支持设置匹配关键词（如 `4K`、`动漫`）自动分发到指定云盘目录 ID；
  - 正规数据库迁移 `1746400000000-AddChannelSecondaryDispatch.js` 扩展实体，配置向下兼容 `_deepMerge`；
  - 提供全局 REST API：`GET/POST /api/channel/global-config`、`POST /api/channel/preview-rule`、`POST /api/channel/sync-now`。
- **双视口 WebUI 与 TMDB 规则可视化工作台 (`channel.js` 视口 A / 视口 B)**：
  - 视口 A：监控总开关、动态频道列表、默认目录绑定、二次分流规则卡片组、双列黑名单标签网格；
  - 视口 B：频道白名单规则可视化工作台，支持 TMDB 搜索海报生成卡片、AST 正则组合编译器（一键将卡片聚合编译为高效正则表达式回填）与推文沙箱实时演练测试器（Live Preview）。

#### TMDB 影视整理大盘、139 网盘文件穿梭机与双分栏手动整理沙箱 (MoviePilot v3 工业级范式)
- **全自动归档全景大盘 (`media.js` + `GET /api/scrape/overview`)**：
  - 顶部指标卡片实时呈现总计整理文件数、电影数、剧集数、失败数与最近活跃批次；
  - 媒体库网格卡片实时展示 TMDB 海报、评分、年代、⚪原文件名 vs 🔵2.8.x 标准点分物理路径双行对比与单条撤回。
- **139 网盘文件管理穿梭机 (`mediaExplorer.js`)**：
  - 独立模块管理，支持多账号无缝切换、多级目录面包屑导航、新建目录、内嵌改名与一键唤起手动整理沙箱；
  - 资产安全红线：删除操作 100% 移入 139 官方回收站（`POST /api/cloud139/trash`），杜绝物理硬删。
- **双分栏手动整理沙箱 (`mediaSandbox.js` + `#manualOrganizeModal`)**：
  - 左侧：识别参数微调（TMDB 标题联想补全、类型/年份/季集纠偏、目标目录选择器）；
  - 右侧：0 物理写入内存沙箱推演，即时计算并高亮对比原始名、点分洗版规范名与归档路径；
  - 严格服务端门禁：源目录与目标目录相同一票熔断；整理成功后自动登记 WAL 事务日志并持久化自愈记忆映射表。

#### 全站统一版心与运维日志中心
- **视口自适应版心 (`.app-viewport-container`)**：注入全站统一宽度版心与滚动隔离，彻底根除切换 Tab 时 450px 宽度剧烈跳跃缺陷。
- **交互式运维日志中心 (`logs.js` + `GET /api/logs/download`)**：支持 500 条日志最新置顶、滚动时自动冻结防抢焦点、分词胶囊过滤、一键清空与导出日志文件。

## [2.3.3] - 2026-10-10

### 新增

#### 跨号秒传：139 移动云盘账号间 PC 协议闭环秒传 (CrossAccountFastTransferService)
- **纯正 PC 模式协议闭环 (`/hcy/file/create`)**：彻底剔除 APP 模式与幽灵图片 `.jpg` 脱壳逻辑，基于 139 官方 PC 端 `contentHash` + 默认单 Part 结构直连秒传，云端碰撞命中率 100%，单文件秒传耗时 <200ms。
- **目标目录并发互斥锁 (TargetDirResolver)**：采用带有 Promise 缓存的互斥锁队列，并发解析与创建目标多级目录，彻底杜绝并发竞态导致的同名“双胞胎”文件夹。
- **智能预检跳过与安全资产移入回收站**：目标目录存在同名同大小或同哈希文件直接标记 `exist` 智能放行；支持可选 `autoTrashSource` 策略，仅在目标账号 100% 秒传确认成功后才将源文件移入源账号回收站（`batchTrash`），严格执行 0 物理硬删安全红线。

#### 跨网盘直链离线：从 139 提取官方 CDN 直链与 123 离线拉取 (OfflineDownloadService + Pan123OfflineAdapter)
- **通用直链离线适配器抽象基类 (`BaseHttpOfflineAdapter`)**：规范化离线驱动契约，为后续无缝接入 115、迅雷等其它支持 HTTP/HTTPS 直链离线下载的网盘奠定统一驱动规范。
- **123 网盘离线驱动 (`Pan123OfflineAdapter`)**：完整实现 CRC32 防重放动态签名 (`getSignedUrl`)、Token 12 小时自适应保活与 401 自动失效重登机制、多级目录自动创建与缓存复用。
- **5252 自适应二分拆批 (Learned Limit)**：深度吸收脚本实践经验，遇到 123 服务端 `code=5252` 批次限额时自动递归对半切分提交，并动态记忆账号安全批次大小。
- **停滞卡死停工检测与新鲜直链自动重推 (Stall Detection & Repush)**：自动扫描超过 30 分钟未动静的排队或下载卡死任务，调用云端删除后重新向 139 获取新鲜有效的官方 CDN 直链进行重推（上限 2 次）。
- **系统级级联熔断器 (Circuit Breaker)**：10 秒内连续 6 次请求失败时触发冷却熔断（30s -> 60s -> 120s -> 300s），冷却期内拒绝提交新任务，彻底保护目标网盘账号不被频控拦截。
- **凭据解耦与独立持久化 (`DriveCredential`)**：外部网盘账号密码与 139 `Account` 彻底物理隔离解耦，密码脱敏存储与展示，并支持一键连通性测通与容量水位检查。

#### 交互中心：WebUI 原生面板与 REST API 端点
- **统一 REST API 端点发布**：在 `routes/api.js` 发布 `/api/drive-credentials`、`/api/transfer/fast/*`、`/api/offline/*` 等标准端点，统一封包 `{ success, data }`。
- **WebUI 现代化卡片集成 (`transferTab` + `transfer.js`)**：在侧边栏与顶部导航新增【跨号秒传与离线】独立视口，提供秒传配置表单、离线直链提交表单、实时任务状态监控表与外部网盘凭据管理。

#### Docker 容器化：内置 docker-entrypoint 挂载权限自愈与优雅安全降权
- **挂载目录权限自动修复与降权启动 (`docker-entrypoint.sh`)**：在生产镜像引入 `su-exec` 与自愈入口脚本，启动时自动检测宿主机挂载的 `/home/data` 与 `/home/strm` 目录权限；若不可写则自动修复其所有权为环境变量指定的 `PUID:PGID`（默认 1000:1000），随后降权为普通用户安全运行，彻底终结 Linux/Armbian 宿主机常见的 `EACCES: permission denied` 与 SQLite `SQLITE_CANTOPEN` 启动崩溃。
- **数据库目录前置防御自检与友好指引**：在 `src/database/index.js` 增加目录存在性与写权限前置侦测，在遭遇外部不可抗力权限阻断时输出格式化排查解决指引，避免抛出底层晦涩的驱动堆栈。

#### 影视刮削：TMDB 满血对齐与五级降级防漏检索链 (TMDBService + RecognitionEngine)
- **五级降级防漏检索链**：在 `TMDBService.searchCandidates` 完整集成多层级防漏检索策略：① 年份剥离重试（带年份搜空自动剥离年份重搜，防止剧集当前季首播年份与第一季不一致导致漏搜）；② 影视分类交叉互换（`movie <-> tv` 自动交叉回退）；③ 简繁对偶重试（利用 `RecognitionEngine.toTraditional` / `toSimplified` 自动简繁互换）；④ 副标题拆解重试（提取冒号/下划线后副标题）；⑤ 主片名截断重试（提取首空格前主词）。
- **显式 TMDB ID / 纯数字直查直通**：实现 `parseTmdbLookupQuery` 与 `lookupById`，支持用户输入 `tv:12345`、`movie:857`、`tmdb:12345`、`{12345}` 或纯数字 ID 时直接穿透查详情，跳过模糊匹配。
- **凭据自适应与整季详情获取**：`_request` 自动识别 v4 Read Access Token (`ey...` 携带 `Authorization: Bearer` 头) 与 v3 API Key；新增 `getSeasonDetails(tvId, seasonNumber)` 整季剧集获取接口与 `testCredential` 凭据连通性测通方法。

#### 影视刮削：REST API 端点与 WebUI 交互中心 (registerApiRoutes + media.js + index.html 子模块 4-4)
- **RESTful API 契约与严格互斥拦截**：在 `routes/api.js` 统一发布 `/api/scrape/rules`、`/api/scrape/plan`、`/api/scrape/apply`、`/api/scrape/journal`、`/api/scrape/revert/*`、`/api/scrape/inbox`、`/api/scrape/binding/resolve` 与 `/api/scrape/search-candidates` 等端点；服务端强制执行“源目录与目标目录相同”及“目标目录位于源目录内部”的双重一票否决门禁。
- **WebUI 影视刮削中心深度交互面板**：在 `mediaTab` 接入专属“影视规范整理与自动化刮削中心”卡片，包含【监控规则与目录】、【待人工处理箱 (Inbox)】与【刮削流水账与撤回 (Journal)】三个子面板，支持一键增量巡检。
- **原生 FolderSelector 树状目录双选器与实时爆红防呆**：新建/编辑规则时独立唤起系统原生 `FolderSelector` 选择源目录与目标目录，选框下方实时计算互斥隔离性，存在包含或相同时即刻爆红提示并禁用保存与测试按钮。
- **免打扰待人工处理箱 (Inbox)**：存疑或多版本冲突影视坚决在源目录原地不动保留；处理箱清晰呈现原地冻结原因、提供 TMDB 候选一键采纳纠偏，并默认勾选“记住此源目录绑定关系 (ScrapeBinding)”，实现追更新集终身免干预自动归档。
- **WAL 流水账透明追溯与无损原子逆向撤回**：清晰呈现由【源目录/原文件名】到【目标目录/规范新名】的迁移轨迹，提供单条与整批一键原子 LIFO 回滚能力，先恢复原名再搬回原目录原路径。

#### 影视刮削：自动化编排、自愈记忆与系统调度闭环 (MediaScrapeService + SchedulerService 子模块 4-3)
- **端到端刮削编排引擎 (`MediaScrapeService`)**：实现 `planRule` 预演扫描规划（纯函数零物理副作用）与 `executePlan` 正式整理（WAL 日志先行、创建层级、跨目录移动改名、标记应用并广播 `scrapeComplete` 事件）。
- **系统级后台巡检调度集成 (`SchedulerService`)**：在 `SchedulerService.applySystemJobs` 注入“影视规范刮削定时整理”调度器，支持从配置中读取自定义 Cron（默认每天凌晨 04:00）静默轮询所有启用的归档规则。
- **存疑条目推送通知与待办闭环**：扫描过程中一旦发现存疑或歧义条目，自动汇总节流向 Telegram/企业微信等渠道发送提醒卡片，引导前往待处理箱核对。

#### 影视刮削：驱动抽象解耦与 WAL 逆向原子撤回引擎 (MediaDriveAdapter + ScrapeJournalService 子模块 4-2)
- **多网盘统一驱动抽象与目录互斥隔离 (`MediaDriveAdapter`)**：抽象基类并实现 `Cloud139DriveAdapter`（移动云盘 HCY 协议）与 `OpenListDriveAdapter`（AList/OpenList REST API），统一定义 `listAll`、`ensureDir`、`rename`、`batchMove`；内置最高熔断级别的 `validateDirs` 校验，坚决杜绝“源目录等于目标目录”或“目标目录位于源目录子树”的误配置。
- **写前操作日志 (WAL) 与 LIFO 逆向安全撤回 (`ScrapeJournalService`)**：在任何跨目录移动与规范重命名发生前，强制持久化写前日志 `ScrapeRecord`；提供单条与整批 `revertRecord` / `revertBatch` 逆向 LIFO 撤回能力，先无损恢复原文件名，再将文件搬回源目录原路径，最后原子标记为 `reverted`，彻底解除误刮削顾虑。
- **纠偏自愈记忆库 (`ScrapeBinding`)**：提供 `saveBinding` 与 `findBinding` 能力，记录用户对目录与 TMDB ID 的人工纠偏关系，为后续追更增量归档提供终身免干预支持。

#### 影视刮削：多区域 Translations 证据链与跨地区对照识别 (RecognitionEngine + TMDBService 子模块 4-1)
- **TMDB 官方全区域 Translations 接口与缓存**：在 `TMDBService` 新增 `getTranslations` 接口，拉取并结构化解析各区域官方中文译本（CN 陆、TW 台、HK 港、SG 新），生成 `regional` 映射与 `display` 友好展示，利用 `CacheManager` 建立 600s 内存缓存。
- **跨地区译名证据链验证与放行 (`chooseTmdbCandidate`)**：当本地影视因港台或跨地区公映异名（如《间谍过家家》vs《间谍家家酒》、《灌篮高手》vs《男儿当入樽》、《钢之炼金术师》等）在首轮未精确对齐时，自动异步调取官方 Translations 证据链进行核验；官方全区域译名完全吻合即赋予 320 强置信高分直接放行，并将 `regionalTranslations` 与 `translationsDisplay` 透传至刮削结果。
- **通用经典与热门动漫别名矩阵扩展**：将 `RecognitionEngine.ANIME_ALIAS_GROUPS` 扩充至 40+ 组完整的大陆/港台/官方中译/日英文对照矩阵，新增 `getAliases` 实现关联片名全向双向互通。
- **精准度安全护栏与冲突熔断**：实现 `extractSequelNum`（续集部数提取，硬熔断《神偷奶爸3》匹配第1部）、`extractConcertDate`（演唱会公演日期冲突熔断）、`extractTmdbIdTag`（提取 `{tmdb-id}` 权威标签）、跨年份冲突拦截（> 1 年直接否决）与无年份同名多年份作品防误判熔断。

#### Web 端运维中心面板与去重治理可视化交互 (模块 3-3)
- **网盘维护面板去重巡检与清理联动**：在 WebUI“网盘清理与违规检测”面板中新增【资产去重】一键操作按钮，调用后台纯计算引擎实时巡检同影视多版本资产分布。
- **可视化多版本去重模态框 (dedupScanModal)**：支持实时渲染扫描媒体文件总数、多版本资产组数、可淘汰冗余数与预估释放空间；详细以表格形式展示资产识别名称、最佳保留版本（Keeper 高亮绿标）、淘汰冗余版本列表（Losers 红标）及每组释放空间，提供一键将淘汰版本安全移入回收站闭环。
- **定时去重配置与自动清理开关双向绑定**：在系统设置中无缝接入 `enableDedupCron`、`dedupCron` 与 `autoPruneDedup` 开关配置，支持用户自定义去重定时策略，实现纯前端到后端的透明持久化与生命周期联动。

#### 定时调度器任务与自愈/巡检健康大盘联动 (SchedulerService 模块 3-2)
- **多版本资产去重系统定时调度**：在 `SchedulerService.applySystemJobs` 中注入 `多版本资产定时去重` 系统级定时任务，支持从 `maintenance` 配置中读取 `enableDedupCron`（默认每周日 05:00）及自定义 Cron 表达式。
- **Cron 表达式标准化与非法校验**：在 `validateTaskScheduleSettings` 中统一处理 5 位 Cron 自动补齐为 6 位秒级 Cron（如 `0 5 * * 0` -> `0 0 5 * * 0`），并集成非法表达式安全校验与异常拦截。
- **定时治理自动化与安全闭环**：定时任务触发时自动消费 139 账号与 `AssetDeduplicationService`，支持开启 `autoPruneDedup` 自动移入回收站并同步清理 `TransferredFile` 防重漏斗记录；配合 `notifyOnMaintenance` 自动将包含抽样的去重报告推送到多渠道通知总线。

#### Telegram Bot 交互式运维与多云盘资产治理命令闭环 (TelegramBotService)
- **多版本资产去重巡检与清理命令**：新增 `/dedup`（`/dedup_scan`）与 `/dedup_clean` 命令，基于 `AssetDeduplicationService.scanCloudFiles` 递归巡检并输出资产去重报告（扫描媒体数、多版本资产组数、淘汰版本数、预估释放空间、Keeper/Loser 抽样）。
- **双向内嵌交互按钮 (Inline Keyboard)**：巡检发现冗余版本或违规死链后，自动附带 `[🗑 立即清理冗余版本]`（`m_dc`）与 `[🗑 立即清理违规文件]`（`m_cb`）内嵌回调按钮，用户轻触即可一键触发安全回收站清理。
- **空目录修剪命令别名支持**：支持 `/sweep_empty` 与 `/clean_empty` 语义别名，无缝契合用户运维使用习惯。

#### 原盘与多版本资产去重与智能择优治理 (AssetDeduplicationService 0 刮削)
- **纯计算物理资产指纹 (`buildMediaAssetKey`)**：消费 `RecognitionEngine.parseMediaFilename` 与 `normalizeTitleKey`，以剧集 `titleKey::SxxEyy` 与电影 `titleKey::(Year|movie)` 为唯一指纹键，繁简互通、大小写与标点全归一化，精准聚类同影视资产多版本，零依赖外部刮削。
- **5 级覆盖策略多版本智能择优 (`analyzeDuplicates`)**：对冗余文件列表自动聚类并结合用户策略（发布组 > Remux/蓝光 > 分辨率 > 杜比视界 > 文件体积）评选出全局最优保留版本（Keeper）与淘汰版本（Losers），计算释放字节数并生成可视化去重计划。
- **资产安全清理闭环与白名单拦截 (`executePrune`)**：支持 `dryRun` 预演模式；正式清理严格遵循安全铁律，淘汰版本统一调用 139 网盘回收站接口（`deleteFiles`），对受保护白名单目录（如 `/媒体库`）执行绝对熔断拦截，并同步清理 `TransferredFile` 冗余记录，杜绝资产误删与孤儿数据。
- **REST 运维管理端点对接**：在 `api.js` 新增 `POST /api/maintenance/assets/dedup/scan` 与 `POST /api/maintenance/assets/dedup/prune`，无缝融入系统全盘维护治理体系。

#### 媒体识别纯计算引擎普适规则与技术规格强化 (RecognitionEngine 0 刮削)
- **单一事实来源归位 (`parseChineseNumber`)**：在 `RecognitionEngine` 建立统一的静态纯函数 `parseChineseNumber`，支持 0~999 阿拉伯与复杂中文数字（零至九十九、百位、两/兩、大写壹贰叁等）；`task.js` 的 `_parseChineseNumber` 与内部 `_cnNumToInt` 全面收口代理复用，杜绝重复实现。
- **复合季集与显式多季识别**：重构 `parseMediaFilename`，优先匹配一体化 `SxxEyy` / `2x05` 标记，并深度支持“中文季+规范集”分离复合模式（如 `庆余年.第二季.第05集`、`庆余年.第2季.EP05`、`The.Show.Season.2.Episode.05`），精准提取显式季号并将 `_seasonInferred` 标记为 `false`；仅有集号时自动设 `season = 1` 且 `_seasonInferred = true`。
- **汉语自然语法边界防护 (铁律 6 零打地鼠)**：在 `titleEndPatterns` 中增加显式分隔符与中文季/集语法边界截断，彻底避免如《21座桥》《8佰》《101次求婚》《第一滴血》《第二十条》等紧凑词汇被误伤切断，100% 依托汉语语法自然成立，严禁特例硬编码。
- **技术规格纯计算推断强化**：`inferTechnicalTags` 新增 `DTS:X`（`DTS-X`）、`Opus` 独立音频编码识别，以及 `IMAX Enhanced`（`isImax`）特性标签推断；`TaskNamingService.parseMediaFileName` 增加 `isImax` 字段透传。

#### 分享链接失效自动补正与自愈闭环 (AutoHealingService + PansouService)
- **致命链接失效定向自愈**：当追更任务遭遇 139 分享链接失效、过期或被取消（`LINK_INVALID` / `LINK_EXPIRED` / `LINK_LIMIT_EXCEEDED`）时，自动触发 PanSou 移动云盘资源智能搜盘与自愈闭环。
- **高置信影视识别与定向搜索**：优先提取规范化 TMDB 影视名及年份作为精准关键词；无 TMDB 时消费 `RecognitionEngine.cleanAnimeFolderName` 智能剥离压制组、规格、合集标签提取干净词，向 PanSou 官方 API 发起定向检索。
- **5 级覆盖策略加权比对择优**：严格按照「发布组优先级 > 原盘Remux > 高分辨率 > 杜比视界 > 文件体积」5 级策略加权评分，自动排除原失效链接，优选最佳替代资源。
- **原子更新与自愈重新排期**：自愈成功后自动更新任务 `shareLink`、`accessCode`（免密分享自动清空密码），重置 `shareFolderId`、`shareFileId`、`realFolderId`，递增 `healCount` 并调用 `CheckpointManager.clearCheckpoint` 清理脏断点，将任务状态重置为 `pending` 立即重新排期。
- **死循环熔断与卡片通知**：支持 `autoHealing.maxAttempts`（默认 3 次）防止单任务无限自愈；自愈完成后自动推送多渠道（Telegram 等）富文本自愈卡片通知，清晰标注原失效链接、新资源标题、技术规格与自愈轮次。
- **配置平滑向下兼容与数据库迁移**：`ConfigService` 深度合并 `pansou`、`autoHealing`、`policy` 默认配置；新增正规幂等迁移 `AddHealCountToTask` 为 task 表补全 `healCount` 字段。

#### 全双工 Webhook 深度联调与受保护路径防御加固 (WebhookService)
- **入站路由鉴权放行**：在路由 Session 鉴权中间件中将 `/api/webhook/emby` 纳入白名单，确保外部 Emby 服务器可直接穿透并交由 WebhookService 的 `inboundToken` 执行强鉴权门禁，彻底解决外部调用被全局 401 拦截的问题。
- **目录穿越漏洞防御**：`mapEmbyPathToCloudPath` 与 `isProtectedPath` 强化对 `../` 目录穿越的绝对阻断，恶意相对路径直接解析为空并触发安全熔断拒绝。
- **模糊匹配误删熔断**：在反向删除任务匹配中，对长度小于 2 字符的过短或空搜索关键词进行一票否决，坚决杜绝因短路径模糊 `Like('%')` 导致全库任务被误删的严重隐患。
- **单集删除双向匹配与回收站闭环**：单集文件删除支持文件名双向包含与精确匹配，命中后调用 139 回收站接口移入回收站并清理 `TransferredFile` 防重漏斗记录。

#### 纯原盘镜像流式探测与技术规格对齐 (IsoProbeService + RecognitionEngine)
- **假 ISO 伪装流式识别**：通过首部分段二进制签名探针（MKV: `1A 45 DF A3`，MP4: `ftyp`，TS: `0x47`），秒级识别用户为防网盘和谐而重命名为 `.iso` 的常见视频封装。
- **真蓝光与 DVD 原盘结构定位**：基于纯内存流式解析 UDF 2.50 AVDP、MVDS、LVD、FID 及 File Entry，精准定位主流 `.m2ts` 文件偏移量与物理大小；支持 ISO 9660 PVD 与 VIDEO_TS 结构定位 DVD 主流 `.VOB`。
- **技术规格推断双向对齐**：`RecognitionEngine.inferTechnicalTags` 融合探针 `streamMeta`，将假 ISO 真实扩展名（`.mkv`/`.mp4`）、蓝光原盘标志（`isBluRay: true`、`M2TS`）及 DVD（`isDvd: true`、`VOB`、默认 480p）无缝对齐至统一技术规格。
- **HTTP Range 分段读取防御加固**：`createHttpRangeReader` 支持带超时（15s）与限次重试的 HTTP Range 请求；探针入口注入完善的容错 `try...catch`，避免网络断流影响系统稳定性。

## [2.3.2] - 2026-09-18

### 新增

#### 媒体服务器全双工 Webhook 统一总线 (WebhookService)
- **正向入库通知 (Outbound Webhook)**：转存成功且 STRM 生成完毕后，自动向下游派发出站 Webhook。
  - 支持 **SmartStrm 行业标准规范**（`event: "cs_strm"`、`savepath`、`strmtask`、`files`），与 [Cp0204/SmartStrm](https://github.com/Cp0204/SmartStrm) 无缝联动生成 302 直链播放 STRM；
  - 支持 **通用 JSON 规范**（`event: "transfer.completed"`），供 MoviePilot、飞牛 NAS、Jellyfin 或自定义脚本自动化消费；
  - 内置基于 `accountId:savePath` 的 2000ms 智能防抖窗口与 5 秒超时保护，异步静默派发，绝不阻塞主转存流程。
- **反向删除同步网盘 (Inbound Webhook)**：供 Emby Webhooks 插件联动，实现“Emby 删片 -> 139 网盘自动清理”。
  - 监听 `library.deleted` 与 `item.delete` 事件，自动逆向剥离 Emby 容器挂载前缀（`embyMountPrefix`）并还原网盘真实相对路径；
  - **双模请求体解析**：健壮兼容 Emby Webhook 插件的标准 `application/json` 与 `multipart/form-data`（包含 `data` JSON 字符串）；
  - **单文件与整剧目录智能识别**：单文件删除精准匹配 `TransferredFile` 历史记录并在网盘移入回收站；整剧目录删除同步清理系统对应任务。
- **绝对安全红线白名单拦截**：
  - 强制对根目录 `/`、系统关键路径（如 `/`、`/媒体库`、`/media`、`/strm`、`/公共目录`）进行删除拦截熔断，出现危险请求时立即拒绝并输出错误告警，彻底防误删；
  - 资产安全第一：删除操作统一调用 139 网盘回收站接口（`recyclebin/batchTrash`），绝不执行物理硬删除。
- **连通性测试与运维握手**：
  - 支持 Emby 控制台的 `system.notificationtest` 测试事件，即时返回 HTTP 200 与握手成功日志；
  - Web 端提供【测试出站推送】即时连通性检测功能，向目标 URL 发送模拟请求并展示响应状态码与内容。

#### Web 前端控制台全面升级
- 新增 **【媒体服务器与 Webhook 联动 (SmartStrm / Emby)】** 专属设置卡片。
- **可视化地址与 Token 管理**：根据当前浏览器 Origin 自动拼接完整的接收端点 URL，提供【一键复制地址】与【重置 Token】（生成 16 字节高强度随机 Hex）按钮。
- **精细化安全控制**：支持「启用 Emby 删除同步网盘」、「同步移入 139 网盘回收站」与「同步清除对应转存任务」独立开关。

### 重构与物理废弃 (铁律 1)
- **全面物理删除旧 Emby 递归搜索与全库刷新**：彻底删除 `src/services/emby.js` 中陈旧脆弱的 `searchItemsByPathRecursive`（向上递归探测）、`searchItemsByName`（模糊名称搜索）、`refreshItemById`、`refreshAllLibraries`（全库 I/O 阻塞刷新）、`_replacePath` 以及未暴露 HTTP 路由的死代码 `handleWebhookNotification`（共清理 450+ 行冗余代码）。
- **废弃数据库缓存污染**：彻底废除对 `Task.embyId` 字段的读写缓存，彻底消除 Emby 重构媒体库后因 ID 失效引发的死循环刷新问题。
- `taskEventHandler.js` 全面收敛委托至统一的 `WebhookService.notifyTransferComplete`。

## [2.3.1] - 2026-09-18

### 新增

#### 全局违规失效文件检测与清除 (CloudMaintenanceService)
- 完整移植 139 助手 2.8.0 的 **6 层违规判定规则**：黑名单哈希匹配、警告占位缩略图（`hw-warning`、`warning/`、`audit-fail` 等）、审核结论状态码（`auditResult=3`）与拦截关键词匹配、审核文本描述、服务端布尔标记与限深 3 层对象属性递归 URL 扫描。
- 支持全盘/指定目录递归巡检，详细汇报扫描目录数、文件数、违规死链清单与占用体积。
- **安全分批清理与目录复查**：分批（每批 100 个）移入回收站，具备严格白名单校验；删除后执行 `verifyIdsGone` 原目录复查，确保确实已消失才计入成功。
- **Web 端网盘清理控制台**：在「设置」页新增「网盘清理与违规检测」卡片，提供【违规巡检】、【一键清理违规】、【清理空目录】可视化按钮与巡检结果弹窗明细列表。
- **定时检查与清理频率支持**：支持配置 5/6 位 Cron 表达式（默认 `0 3 * * 0` 每周日凌晨 3 点），支持独立开关以及“查到违规直接移入回收站”安全防误删开关（默认仅检测通知，不私自删除）。
- **多渠道系统通知推送**：脱离对 Telegram 单一依赖，检测与清理结果全面联动 `MessageUtil`，自动推送到企业微信、Bark、WxPusher、PushPlus、自定义 Webhook 等所有已配置通道。
- **Telegram 机器人联动**：新增 `/scan_banned`（违规全盘巡检）与 `/clean_banned`（一键清理回收）命令。

#### 零下载 ISO 原盘轻量规格嗅探 (IsoProbeService)
- 采用纯 JS HTTP Range 分段读取器（仅读 512KB~2MB，内存占用 <5MB，零外部子进程依赖），避免 ffmpeg 的重型依赖与 OOM 风险。
- **假 ISO 伪装识别**：检测头部二进制 Magic Number（`1A 45 DF A3` -> MKV，`ftyp` -> MP4，`0x47` -> TS），智能识别改名防和谐文件。
- **UDF 2.50 蓝光原盘解析**：读取 Sector 256（AVDP）及元数据分区，遍历 `BDMV/STREAM` 精确定位最大的主播放 `.m2ts` 流，获取其精确偏移与体积。
- **ISO 9660 DVD 原盘解析**：读取 Sector 16（PVD），解析 `VIDEO_TS` 遍历定位最大主影片 `.VOB` 流。
- 将探测出的真原盘规格（`BluRay / DVD / Remux`）无缝回填至 `RecognitionEngine.inferTechnicalTags`，赋能重命名模板与 STRM 生成。

#### 安全空文件夹递归修剪 (sweepEmptyFolders)
- 采用严格白名单保护机制：根目录 `/`、系统关键路径与转存业务目标基础路径（如 `/媒体库`）绝对受保护不删。
- 先行过滤与清理 `.DS_Store`、`Thumbs.db`、`desktop.ini` 系统垃圾文件，避免假性非空。
- 自底向上深度优先安全修剪纯空目录，并联动 Telegram Bot `/clean_empty` 命令。

#### 极致格式清洗扩展 (RecognitionEngine)
- **繁简统一标准化**：内置 `TRADITIONAL_TO_SIMPLIFIED` 字典与 `toSimplified()`，将港台繁体片名统一规范为简体中文，大幅提高 TMDB 匹配命中率。
- **防和谐伪装幽灵后缀剥离**：新增 `removeGhostExtension()`，自动识别并剔除 `.mkv.jpg`、`.mp4.png`、`.b64` 等伪装扩展名，还原真实视频格式。
- **截断乱码与 URL 编码自愈**：新增 `safeDecodeName()`，容错自愈末尾截断的多字节 UTF-8 乱码与 `%XX` 编码，杜绝 `URIError` 异常崩溃。
- **非法字符全角化与安全去噪**：新增 `cleanName()` 与 `cleanRenderedName()`，转换系统禁忌字符为安全全角字符，消除多余连续点号、首尾无效符号与冗余词汇。
- **综艺与新闻放送日期提取**：新增 `parseEpisodeAirDate()`，精确提取 `YYYY-MM-DD` 放送日期，并新增 `{airDate}` / `{date}` 模板变量。

### 重构

#### 贯彻铁律 1 废弃清单物理删除
- 彻底物理删除 `taskNamingService.js` 中内联的旧 `sanitizeFileName` 正则，统一单轨化收敛至 `RecognitionEngine.cleanName`，杜绝两套并存与多头猜测。

## [2.3.0] - 2026-09-18

### 新增

#### 核心媒体识别引擎 (RecognitionEngine)
- 移植并升级 139 助手 2.8.0 核心媒体整理规范，建立统一权威单一事实源（SSOT）。
- **动漫别名归一化与中英双语去噪**：内置知名动漫官方标准译名映射表（`CANONICAL_TITLE_MAP`、`ANIME_ALIAS_GROUPS`），智能清洗字幕组前缀、中英双语混合后缀及多余修饰词。
- **单文件物理技术规格提取**：支持精确推导分辨率（8K / 4K / 2160p / 1080p 等）、压制规格（Remux / BluRay / WEB-DL / HDrip 等）、动态范围与画质技术（Dolby Vision 杜比视界 / HDR10+ / HDR）、音频编码（TrueHD Atmos / DTS-HD MA / FLAC / AAC / AC3 等）及制作组标签。
- **MoviePilot 标准二级分类推导**：支持基于 TMDB 媒体类型、国家/地区、流派分类自动映射为 MoviePilot 标准目录结构（如 `华语电影`、`外语电影`、`华语剧`、`欧美剧`、`日韩剧`、`日漫`、`国漫`、`纪录片`、`综艺`、`少儿`）。
- **TMDB 候选评分加权体系**：集成年份差异惩罚算法（首播年份完全命中 +250，年份冲突则大幅扣减 500 分），杜绝同名影视不同年代错位刮削。
- **5 级候选资源覆盖对比策略**：当存在多个候选资源时，严格依据「制作压制组 > 原盘/Remux 规格 > 分辨率 > 动态范围与杜比视界 > 文件体积」依次降级择优。

#### PanSou 盘搜资源自动愈合 (AutoHealingService)
- 新增 `pansouService.js`：无缝对接 PanSou 官方服务端 API（`POST /api/search`），专项检索 139 移动云盘资源（`cloud_types: ["mobile"]`），并支持自动剔除预告、花絮、短剧等干扰项。
- 新增 `AutoHealingService.js`：当转存任务因链接失效（`LINK_INVALID`）、链接过期（`LINK_EXPIRED`）或转存人数超限（`LINK_LIMIT_EXCEEDED`）导致失败时，自动从任务原名提取核心关键词并在 PanSou 中检索最新 139 分享链接。
- **规格择优智能替换**：多候选时自动调用 `RecognitionEngine.compareCandidates` 挑选最高品质有效链接，直接就地更新任务链接、重置重试计数并自动恢复为挂起就绪状态。
- **防雪崩与通知**：引入单任务最大自愈上限护栏（默认 3 次），并向 Telegram 机器人推送包含新旧链接对比、识别规格与命中匹配度的图文通知卡片。

### 重构

#### 铁律贯彻与废弃正则物理删除
- **全面物理删除 `taskNamingService.js` 中的过时废弃正则**（`resMap`、`srcMatch`、`vcMatch`、`acMatch`），所有重命名解析统一收敛至 `RecognitionEngine.parseMediaFilename`，杜绝多套逻辑共存。
- **全面物理删除 `ScrapeService.js` 中的空桩 `_parseMediaInfo()`**，打通至 `RecognitionEngine` 权威推断。
- **重构 `tmdb.js` 候选结果评分逻辑**，引入标准加权体系，提升精准匹配率。

## [2.2.90] - 2026-04-27

### 修复

#### 前端任务状态对齐
- 移除前端任务筛选器与编辑弹窗中不存在的「追剧中」状态选项，避免状态显示不一致。

#### 自动命名默认关闭
- 新建任务时若未勾选「启用重命名模板」，后端字段 `disableRename` 将正确写入 `true`，不再错误继承全局模板。
- 任务编辑弹窗新增「禁用重命名」勾选项，支持单独覆盖全局配置。
- 新增数据库迁移 `1745600000000-AddDisableRename`，为 task 表添加 `disableRename` 列。

#### 重命名模板剧名/季信息自动补全
- 当文件名包含 Season 2 / 第2季 / S02 / 2x16 等常见季号格式时，自动从任务名称中推断补全。
- 新增 `_isMeaningfulShowTitle` 校验，防止纯季号字符串被误认为剧名。
- 新增 `hasEpisodeKeyInfo` 门控：仅在文件名包含明确集数信息时才执行补全，避免误操作。
- 新增 `_seasonInferred` 标记，区分模板中季号来源。

#### 认证失败处理
- 新增 `AUTH_FAILED` 错误类型，识别 139 云盘鉴权失败 API 码。
- 认证失败时自动暂停账号、清除重试计数，并推送去重通知（24h 窗口）。
- `taskRetryService` 自动跳过 `isActive=false` 的账号任务。

### [P1] 前端可用性与发布质量修复 - 2026-04-05

**目标达成**: ✅ 前端交互一致性 | ✅ 表格结构对齐 | ✅ CI 覆盖率恢复

#### 前端体验优化
- 统一任务与账号列表操作按钮样式，增强可点击反馈与可读性。
- 重命名配置区改为更清晰的分组卡片结构，创建/编辑任务保持一致。
- 任务列表表头与数据列再次对齐，移除歧义性目录列展示。

#### 预览页清理
- 删除临时静态预览页 `src/public/index.static.preview.html`，避免测试页面误入发布包。

#### 测试与覆盖率修复
- 新增服务层 Jest 单测：
  - `__tests__/checkpointManager.test.js`
  - `__tests__/errorClassifier.test.js`
  - `__tests__/taskErrorService.test.js`
  - `__tests__/taskNamingService.test.js`
  - `__tests__/taskParserService.test.js`
- `npm run test:ci` 已通过，覆盖率恢复到门禁阈值以上：
  - Statements: 93.61%
  - Branches: 76.98%
  - Functions: 100%
  - Lines: 95.88%

### [P0] 基础风险清零 - 2026-04-01

**目标达成**: ✅ 架构一致性 | ✅ 数据库安全 | ✅ 调度完整性 | ✅ 构建稳定性

#### P0-01: 架构口径一致化（189策略落地）

**后端架构调整**
- **189代码隔离**：将天翼云盘（189）相关代码移动到 `src/legacy189/` 目录
  - `src/services/cloud189.js` → `src/legacy189/services/cloud189.js`
  - `src/utils/Cloud189Utils.js` → `src/legacy189/utils/Cloud189Utils.js`
- **引用路径更新**：更新所有文件中的import路径，使用 `../legacy189/` 前缀
  - 涉及文件：task.js, taskStorageService.js, taskRecycleService.js, taskParserService.js, api.js, emby.js, telegramBot.js
- **依赖路径修复**：修复legacy189内部文件的相对引用（logUtils, ProxyUtil, ConfigService, logger）

**前端UI更新**
- **系统设置页面**：在189并发配置项添加警告说明："⚠️ 189功能已隔离到legacy189，仅作算法参考保留。主流程已停用，不影响139转存。"
- **代理设置**：将"天翼"标签改为"天翼（已隔离）"

**文档更新**
- **README.md**：更新项目描述，强调"主要支持移动云盘（139）"，在主要改动中添加189策略说明
- **CHANGELOG.md**：创建变更日志文件

**验收结果**: ✅ 所有TypeScript编译通过 | ✅ Smoke test通过 | ✅ 代码与文档一致

---

#### P0-02: 数据库基线纠偏（禁用synchronize）

**核心变更**
- **禁用自动同步（计划）**：后续在 `src/database/index.js` 中将 `synchronize: true` 调整为 `synchronize: false`
- **迁移脚本（计划）**：创建初始迁移 `src/database/migrations/1743505200000-InitialSchema.js`
  - 包含所有实体：Account, Task, CommonFolder, TransferredFile
  - 包含索引：IDX_transferred_file_taskId_fileId（唯一索引）
  - up()使用 `CREATE IF NOT EXISTS` 防止重复创建
  - down()提供完整回滚逻辑
- **迁移路径配置（计划）**：在 AppDataSource 中添加 `migrations: [path.join(__dirname, 'migrations/*.js')]`

**文档补充（规划中）**
- **docs/MIGRATION_TEST.md**：创建迁移测试指南
  - 场景1：现有数据库（schema已存在）
  - 场景2：空数据库（全新安装）
  - 场景3：回滚测试
  - 包含命令参考和注意事项

**当前状态**: ⚠️ 仅完成方案设计，后续版本再落地为可验收项

---

#### P0-03: VACUUM周更任务补齐

**后端实现**
- **SchedulerService增强**：
  - 添加 `DEFAULT_VACUUM_CRON = '0 3 * * 0'`（每周日凌晨3点）
  - `validateTaskScheduleSettings` 增加 vacuumCron 验证
  - `applySystemJobs` 增加 VACUUM 系统任务
- **ConfigService配置**：在默认配置中添加 `vacuumCron: '0 3 * * 0'`
- **VACUUM任务逻辑**：
  ```javascript
  this.saveDefaultTaskJob('SQLite维护(VACUUM)', normalized.vacuumCron, async () => {
      await AppDataSource.query('VACUUM');
      logTaskEvent('SQLite VACUUM 执行完成，数据库已优化');
  });
  ```

**前端UI**
- **系统设置页面**：添加"SQLite维护(VACUUM)"配置项
  - 输入框ID：`vacuumCron`
  - 默认值：`0 3 * * 0`（每周日凌晨3点执行）
  - 说明文字："默认：0 3 * * 0 (每周日凌晨3点执行)"
- **settings.js更新**：
  - `loadSettings` 加载 `vacuumCron` 配置
  - `saveSettings` 保存 `vacuumCron` 配置

**验收结果**: ✅ Scheduler包含VACUUM任务 | ✅ 前端UI完整 | ✅ 构建测试通过

---

#### P0-04: 构建与运行一致性修复

**验证项目**
- ✅ package.json 脚本配置完整：
  - `start`: node dist/index.js
  - `start:prod`: npm run migration:run:prod && node dist/index.js
  - `build`: tsc && xcopy /E /I /Y src\public dist\public
  - `migration:run:prod`: node ./node_modules/typeorm/cli.js migration:run -d dist/database/index.js
- ✅ 构建产物完整：
  - dist/index.js (6876 bytes)
  - dist/database/index.js (2693 bytes)
  - dist/services/scheduler.js (9771 bytes)
  - dist/services/task.js (67724 bytes)
  - dist/public/index.html (46095 bytes)
  - dist/database/migrations/1743505200000-InitialSchema.js (5681 bytes)
  - dist/legacy189/* (cloud189.js, Cloud189Utils.js, recycleAdapter.js)
- ✅ Smoke test 通过：核心模块可正常加载
- ✅ Dockerfile 一致性：
  - Builder阶段：tsc编译 + 复制public资源
  - Production阶段：start:prod自动执行迁移

**验收结果**: ✅ 干净环境可构建 | ✅ 产物结构正确 | ✅ Docker启动脚本完整

---

### 影响范围

**破坏性变更**
1. **数据库**：首次启动需执行迁移（Docker自动，手动部署需 `npm run migration:run`）
2. **189功能**：已从主流程移除，代码移至 `src/legacy189/`

**兼容性**
- ✅ 对现有139用户无影响
- ✅ 现有数据库可无缝升级（TypeORM自动检测schema已存在）
- ✅ 配置文件向后兼容（新增字段有默认值）

**代码质量**
- ✅ 符合白皮书V1.4.1要求
- ✅ 代码与文档完全一致
- ✅ 所有构建和测试通过

---

### 升级步骤

#### Docker用户
无需操作，重新pull镜像即可：
```bash
docker pull azheng0108/cloudpan-auto-save:latest
docker-compose up -d
```

#### 手动部署用户
1. 备份数据库：
   ```bash
   cp data/database.sqlite data/database.sqlite.bak
   ```
2. 拉取最新代码并安装依赖：
   ```bash
   git pull
   npm install
   ```
3. 构建项目：
   ```bash
   npm run build
   ```
4. 运行迁移（首次启动会自动检测schema）：
   ```bash
   npm run migration:run
   ```
5. 启动服务：
   ```bash
   npm run start:prod
   ```

---

### 回滚步骤

如遇问题，可回滚到P0前版本：
```bash
git checkout <previous-tag>
cp data/database.sqlite.bak data/database.sqlite
npm install && npm run build && npm start
```

---

## [2.2.47] - 之前版本

（历史版本记录省略）

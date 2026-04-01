# UI 说明文档（UI_SPEC）

**事实来源优先级**：实现以 **`src/public/` + 后端 API** 为准；本文件与 [ui原型.html](../ui原型.html) 为设计与评审基准。**若原型与当前页面数据流不一致，以代码为准**，并在本文档 §「与当前实现的差异」记录。

---

## 1. 设计令牌（Design Tokens）

以下与原型 [ui原型.html](../ui原型.html) 对齐；生产环境建议落在 `src/public/css/base.css` 的 **CSS 变量**中，避免长期依赖 Tailwind CDN。

| 令牌 | 原型参考值 | 用途 |
|------|------------|------|
| `--color-primary` | `#1677ff` | 主按钮、链接强调 |
| `--color-primary-soft` | `#f0f7ff` | 目录树选中底色 |
| `--radius-card` | `0.5rem` 量级 | 卡片、弹层 |
| `--border-default` | 浅灰 `#e5e7eb` 类 | 表单边框 |
| `--shadow-modal` | 较深阴影 | 弹窗 |
| Focus ring | 蓝色环 + 浅外光 | 类 `.input-focus` 行为 |

**成功反馈**：原型中保存目录变更的 **绿边脉冲**（`.animate-success`）可在生产中用意同等效动画替代。

---

## 2. 布局模式

### 2.1 创建任务（模态/长表单）

- **外壳**：`max-width` 约 `48rem`（`max-w-3xl`）；**`max-height: 90vh`**。
- **分区**：**头部标题**固定感；**主体 `overflow-y: auto`**（自定义细滚动条可选）；**底部操作栏**与主体分离（`border-top` + 浅灰背景），**取消 / 创建**始终贴在可视区底部，避免长表单拖不到按钮。
- **多端**：窄屏下同样保持「中间滚动 + 底栏固定」；禁止父级无故 `overflow: hidden` 截断滚动链。

### 2.2 选择保存目录（二级弹层）

- 蒙层 + 居中卡片；树区域固定高度 + 内部滚动；底部 **新建文件夹**（若 API 支持）+ **取消 / 确定**。

---

## 3. 组件说明

| 组件 | 原型行为 | 与生产对齐时注意 |
|------|----------|------------------|
| 账号下拉 | 自定义箭头、`appearance-none` | 绑定真实 `/api/accounts` |
| 分享链接 + 提取码 | 左右分栏 | `shareLink`、`accessCode` |
| 分享目录树 | 全选、子项、「当前外层的文件」文案 | 与 `parseShare` / 批量创建逻辑一致 |
| 保存目录 | 只读展示 + 点击开树；**常用目录**下拉 | `targetFolderId`、收藏 API |
| 正则 / 匹配 / 定时 | 与现表单字段一一对应 | 见 `tasks.js`、DTO |

图标：原型用 **Lucide**；生产可用内联 SVG、字体图标或精简子集，避免整库 CDN（见差异表）。

---

## 4. 页面映射表（原型区块 ↔ 代码侧）

| 原型区块 | 典型 API / 脚本（以仓库为准） |
|----------|-------------------------------|
| 选择账号 | `GET /api/accounts`；表单 `accountId` |
| 分享链接/提取码 | `POST /api/share/parse`；创建 `POST /api/tasks` |
| 任务名称 | `resourceName` / 任务 DTO |
| 分享目录勾选 | `tasks.js` 批量/选中目录结构 |
| 保存目录 | `GET /api/folders/:id`、`POST /api/folders/mkdir`（139）；`favorites` 系列 |
| 总集数/备注/正则/定时 | `Task` 实体字段与 `tasks.js` 提交 body |

**具体字段名**维护者须在改表单时核对 [src/entities/index.ts](../src/entities/index.ts) 与 [src/public/js/tasks.js](../src/public/js/tasks.js)。

---

## 5. 与当前实现的差异（须持续更新）

| 项 | 说明 |
|----|------|
| Tailwind / Lucide | 原型用 CDN；生产已采用 **CSS 变量 + 手写布局**，不直接依赖 Tailwind/Lucide CDN。 |
| 创建任务容器 | 已按 §2.1 调整为 `modal-content` + `form-body` 可滚动 + `form-actions` 底部固定，创建/编辑任务弹窗统一 `display:flex` 打开。 |
| 静态资源版本参数 | 已在 `index.html/login.html` 关键资源引用增加 `?v=__ASSET_VERSION__`，由后端路由按应用版本注入，降低缓存陈旧概率。 |
| Emby / 媒体设置 | `settings.js` 是否含全部 Emby 字段以 **grep `emby`** 为准。 |

---

## 6. 无障碍与移动端（R1 验收子集）

- 触控目标建议 ≥ 44px 等价区域。
- 校验 `viewport`、横竖屏下 Tab 与模态是否可用。
- **验收**：390px 宽下完整滚动 + 主按钮可达；与 [REFACTOR_ROADMAP.md](./REFACTOR_ROADMAP.md) R1 一致。

---

## 修订记录

- 首版：随文档计划生成；UI 重构实施时请同步更新 §5。
- 2026-04-01：D3 第一批完成，新增静态资源版本参数注入与关键任务弹窗布局对齐说明。

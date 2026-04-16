# cloudpan-auto-save

云盘自动转存系统（当前主流程为移动云盘 139），提供 Web 管理界面、自动追更、机器人操作、STRM 生成和 Emby 刷新能力。

> 本项目 Fork 自 [1307super/cloud189-auto-save](https://github.com/1307super/cloud189-auto-save)，并在其基础上持续演进。  
> 当前版本聚焦 139 相关能力，189 代码已隔离为历史参考实现。

---

## 项目定位

- 自动监控分享链接更新并转存到指定目录
- 适用于影视追更、资源归档、机器人远程管理场景
- 支持私有化部署（推荐 Docker）
- 版本：`2.2.63`

---

## 最近更新

> 更新时间：2026-04-14（按最近 Git 提交整理）

- `v2.2.63`：修复追更标题兼容性，优化复杂命名场景识别。
- 优化追更推送链路，补齐 Emby 刷新收尾日志。
- 修复 139 重试阶段重复转存与可见性误判问题。
- `v2.2.62`：修复 139 分页游标逻辑，升级 `sqlite3` 依赖。
- 完善路径映射逻辑，支持 `rootFolderId` 自动识别并优化 Emby 精准刷新。

完整历史见 `CHANGELOG.md`。

---

## 核心能力

### 自动化任务

- 定时检查任务更新（Cron）
- 失败任务自动重试
- 支持任务过期自动完成
- 支持 139 回收站自动清理
- 目标目录缺失时可自动重建最后一级目录

### 文件与命名

- 支持目录树选择保存路径与常用目录
- 支持批量创建任务（按分享目录结构识别）
- 支持正则、Jinja2 模板、顺序重命名
- 支持后续自动更新时复用命名规则

### 媒体与通知

- 生成 STRM 文件
- Emby 库刷新通知（支持路径替换与逐级回退）
- 支持企业微信、Telegram、Bark、WxPusher 消息推送

### 机器人与扩展

- Telegram 机器人远程管理任务
- CloudSaver 搜索并一键创建转存任务
- 提供 API Key 与 REST API 调用能力

---

## 安全提示

项目涉及账号凭据、Cookie、Authorization 等敏感信息，请务必注意：

- 仅建议本地或内网私有部署
- 不要使用陌生人提供的托管实例
- 不要将账号信息交给第三方
- 建议配合反向代理与 HTTPS

---

## 快速开始

### 方式一：Docker Hub 镜像（推荐）

```bash
docker run -d \
  -v /yourpath/data:/home/data \
  -p 3001:3000 \
  --restart unless-stopped \
  --name cloudpan-auto-save \
  -e PUID=0 \
  -e PGID=0 \
  azheng0108/cloudpan-auto-save:latest
```

### 方式二：本地构建镜像

```bash
docker build -t cloudpan-auto-save .
docker run -d \
  -v /yourpath/data:/home/data \
  -p 3001:3000 \
  --restart unless-stopped \
  --name cloudpan-auto-save \
  -e PUID=0 \
  -e PGID=0 \
  cloudpan-auto-save
```

### 访问系统

- 地址：`http://localhost:3001`
- 默认账号：`admin`
- 默认密码：`admin`
- 首次登录后请立即修改密码

> 如果你需要修改容器内部端口，可设置 `PORT`，并同步调整 `-p` 映射。

---

## 本地开发

### 环境要求

- Node.js（建议 LTS）
- npm
- SQLite（默认使用项目内置 sqlite3）

### 开发命令

```bash
npm install
npm run migration:run
npm run dev
```

生产构建与启动：

```bash
npm run build
npm run start:prod
```

测试：

```bash
npm run test
npm run test:ci
```

---

## 使用指引

### 1) 添加 139 账号（Authorization 推荐）

1. 登录 [yun.139.com](https://yun.139.com)
2. 打开开发者工具，进入 Network
3. 找到任意发往 `yun.139.com` 的请求
4. 复制请求头中的 `Authorization`（`Basic ...`）
5. 在系统账号页面填入对应字段

> `Authorization` 一般比普通 Cookie 更稳定，失效后需重新获取。

### 2) 创建转存任务

- 选择账号
- 填写分享链接（如有访问码一并填写）
- 选择保存目录（支持目录树）
- 可选配置：总集数、文件名匹配规则、重命名方案

### 3) 自动重命名

- 支持正则、Jinja2 模板、顺序重命名
- 支持预览后应用
- 支持后续自动更新复用规则

### 4) 系统设置建议

- 配置任务检查 Cron 与重试策略
- 139 并发建议从小到大逐步调优（默认 `3`）
- 配置媒体后缀、STRM 前缀、Emby 地址与 API Key
- 若配置跨域调用，设置 `ALLOWED_ORIGINS`

---

## Telegram 机器人

### 基础配置

1. 在 [@BotFather](https://t.me/BotFather) 创建机器人并获取 Token
2. 在系统设置中启用 Telegram 并填入 Token
3. 与机器人发起对话后即可使用

### 常用命令

- `/help`：帮助信息
- `/accounts`：账号列表
- `/tasks`：任务列表
- `/execute_all`：执行全部任务
- `/fl`：常用目录列表
- `/fs`：添加常用目录
- `/search_cs`：搜索 CloudSaver 资源
- `/cancel`：取消当前交互

任务命令：

- `/execute_[ID]`
- `/strm_[ID]`
- `/emby_[ID]`
- `/dt_[ID]`
- `/df_[ID]`

---

## CloudSaver 集成

1. 自行部署 [CloudSaver](https://github.com/jiangrui1994/CloudSaver)
2. 在系统设置填写服务地址、账号、密码
3. 在 Web 或 Telegram 中搜索资源并一键建任务

---

## 常见问题

- **任务失败后重复转存？**  
  请升级到最新版本，并检查重试策略与目标目录是否被外部改动。

- **Emby 刷新不生效？**  
  优先检查地址、API Key、路径替换规则是否与媒体库实际路径一致。

- **目录移动后任务异常？**  
  更新目录可移动但不建议删除；删除后可能触发任务失败或重建逻辑。

- **旧版 Telegram 目录异常？**  
  建议清空旧常用目录后重新添加。

---

## 界面截图

### Web

- 任务管理：`img/task-1.png`
- 资源搜索：`img/cloudsaver.png`
- 媒体库：`img/media.png`
- 系统日志：`img/logs.png`

### Telegram

- 帮助：`img/bot/1.jpg`
- 搜索：`img/bot/2.jpg`
- 建任务：`img/bot/3.jpg`
- 任务列表：`img/bot/5.jpg`

---

## 风险与声明

1. 本项目仅用于学习与技术交流，请勿用于非法用途。
2. 项目通过官方接口交互，不对资源内容负责。
3. 因使用本项目造成的任何后果，由使用者自行承担。

---

## License

MIT

<div align="center">
  <h1>cloudpan-auto-save</h1>
  <p>移动云盘（139）自动追更系统 · WebUI 管理 · Telegram 机器人 · Emby / AList / STRM 联动</p>
  <p>
    <img src="https://img.shields.io/github/package-json/v/azheng0108/cloudpan-auto-save?color=2d7ef7" alt="version" />
    <img src="https://img.shields.io/badge/node-18%2B-4caf50" alt="node" />
    <img src="https://img.shields.io/badge/license-MIT-9e9e9e" alt="license" />
    <img src="https://img.shields.io/badge/platform-Docker-0db7ed" alt="docker" />
  </p>
</div>

> 本项目 Fork 自 [1307super/cloud189-auto-save](https://github.com/1307super/cloud189-auto-save)。
>
> 当前版本在原项目基础上重点增强了移动云盘（139）全流程能力：
> - 139 账号登录、链接监控、自动转存、删除同步
> - Telegram 机器人支持 139 链接识别、目录树选择、CloudSaver 搜索
> - 批量重命名能力增强（支持 Jinja2 模板）

## 目录

- [项目状态](#项目状态)
- [功能特点](#功能特点)
- [快速开始](#快速开始)
- [使用说明](#使用说明)
- [Telegram 机器人命令](#telegram-机器人命令)
- [环境变量](#环境变量)
- [注意事项](#注意事项)
- [安全警告](#安全警告)
- [界面预览](#界面预览)
- [特别声明](#特别声明)
- [License](#license)

## 项目状态

项目目前处于 Beta 阶段，核心流程可用，但仍可能在边界场景出现问题。

- 可能存在边界 Bug（超大文件、特殊字符文件名、网络抖动等）
- 建议先用非核心数据小规模验证后再正式投入使用
- 欢迎提交 [Issue](../../issues) 或 [Pull Request](../../pulls)

## 功能特点

### 自动化任务

- 定时自动检查分享链接更新
- 支持 Cron 定时规则
- 失败任务自动重试（可配置次数和间隔）
- 任务过期自动完成
- 支持目标目录缺失时自动创建（139）

### 文件与命名

- 支持目录树选择保存路径
- 支持常用目录管理
- 支持批量重命名：正则、Jinja2 模板、顺序重命名

### 媒体联动

- STRM 文件自动生成
- Emby 自动通知刷新，支持路径替换和逐级回退
- AList /
 OpenList 路径刷新
- CloudSaver 资源搜索与一键建任务

### 通知与集成

- Telegram 机器人远程管理任务
- 企业微信 / Telegram / Bark / WxPusher 推送
- WebUI 可视化管理（含暗黑模式）
- API Key 保护的 REST API

## 快速开始

### 方式一：Docker Run（推荐）

```bash
docker run -d \
  -v $(pwd)/data:/home/data \
  -v $(pwd)/strm:/home/strm \
  -p 3001:3000 \
  --restart unless-stopped \
  --name cloudpan-auto-save \
  -e TZ=Asia/Shanghai \
  azheng0108/cloudpan-auto-save:latest
```

> `data` 和 `strm` 目录会自动创建在执行命令的当前目录下。

### 方式二：Docker Compose

```yaml
version: '3.8'

services:
  cloudpan-auto-save:
    image: azheng0108/cloudpan-auto-save:latest
    container_name: cloudpan-auto-save
    restart: unless-stopped
    ports:
      - "127.0.0.1:3001:3000"
    volumes:
      - ./data:/home/data
      - ./strm:/home/strm
    environment:
      - NODE_ENV=production
      - TZ=Asia/Shanghai
```

启动命令：

```bash
docker compose up -d
```

访问地址：`http://localhost:3001`

默认账号密码：`admin / admin`（首次登录后请立即修改）

## 使用说明

### 1. 账号配置（139）

- 支持账号密码登录与 Authorization 登录
- 当前主流程聚焦移动云盘（139）

Authorization 获取步骤：

1. 打开 [yun.139.com](https://yun.139.com) 并登录
2. 按 `F12` 打开开发者工具，进入 `Network`
3. 过滤 `Fetch/XHR`，刷新页面
4. 找到任一 `yun.139.com` 请求，复制请求头 `Authorization` 值（通常为 `Basic xxxxx`）
5. 在系统中新增账号时填入 Cookie 输入框

<img src="doc/new_personal.png" alt="找到请求头中的 Authorization" style="max-width:600px;" />

<img src="doc/139_new_au.png" alt="填入 Authorization" style="max-width:600px;" />

提示：Authorization 模式通常更稳定，Cookie 失效后需重新抓取。

### 2. 任务管理

创建任务时可配置：

- 账号
- 分享链接（含访问码）
- 保存目录
- 总集数（可选）
- 文件名匹配规则（可选）

支持能力：

- 批量任务创建（自动识别目录结构）
- 手动执行任务
- 删除任务（可选同步删除云盘文件）
- 任务失败重试与定时检查

### 3. 批量重命名

支持三种模式：

- 正则重命名（可持续用于后续更新）
- Jinja2 模板重命名（自动识别标题、年份、集号）
- 顺序重命名（一次性处理）

### 4. 媒体设置（STRM / Emby / AList）

- STRM：自动生成媒体条目对应的 STRM 文件
- Emby：自动通知刷新媒体库
- AList：自动触发目录刷新

Emby 路径替换示例：

- 云盘路径：`/影视剧/电视剧/北上/Season 01/S01E01.mkv`
- Emby 根路径：`/cloud/移动云盘/电视剧`
- 替换规则：`/影视剧:/cloud/移动云盘`

执行逻辑：

1. 优先尝试完整路径
2. 失败则逐级向上回退
3. 仍未命中则触发全库刷新

### 5. CloudSaver 搜索

- 支持 Web 页面与 Telegram 搜索
- 结果按链接分组并去重
- 可一键创建转存任务

部署说明：

1. 自行部署 [CloudSaver](https://github.com/jiangrui1994/CloudSaver)
2. 在系统设置中填写服务地址、账号、密码
3. 保存后即可启用搜索

## Telegram 机器人命令

基础命令：

- `/help`：显示帮助
- `/accounts`：账号列表
- `/tasks`：任务列表
- `/execute_all`：执行所有任务
- `/fl`：常用目录列表
- `/fs`：添加常用目录
- `/search_cs`：CloudSaver 搜索
- `/cancel`：取消当前操作

任务命令：

- `/execute_[ID]`：执行任务
- `/strm_[ID]`：生成 STRM
- `/emby_[ID]`：通知 Emby 刷新
- `/dt_[ID]`：删除任务

目录命令：

- `/df_[ID]`：删除常用目录

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 运行环境 |
| `PORT` | `3000` | 容器内监听端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `DEBUG` | `false` | 是否开启调试日志 |
| `ALLOWED_ORIGINS` | 空 | CORS 白名单，逗号分隔 |

示例：

```bash
ALLOWED_ORIGINS=http://localhost:3001,https://your-domain.com
```

## 注意事项

- 更新目录可移动但不建议删除，否则任务可能失败
- 数据库存储在挂载目录 `data` 下，请做好备份
- 媒体后缀配置会影响文件过滤和计数
- STRM 生成依赖正确的访问前缀
- Emby / AList 功能依赖正确的服务地址与密钥配置
- 旧版本升级后若 TG 常用目录异常，建议清空后重新添加

## 安全警告

本项目涉及账号凭据与敏感数据，请严格遵守以下原则：

- 务必私有化部署，不要直接暴露公网
- 不要使用第三方搭建实例
- 不要向他人泄露账号、Cookie、Token
- 建议使用反向代理并启用 HTTPS

## 界面预览

<details>
<summary>点击展开截图预览</summary>

### Web 界面

<div style="display: flex; flex-wrap: wrap; gap: 20px; justify-content: flex-start;">
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>任务管理</h4>
    <img src="img/task-1.png" alt="任务管理" style="max-width: 100%; height: auto;" />
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>资源搜索</h4>
    <img src="img/cloudsaver.png" alt="资源搜索" style="max-width: 100%; height: auto;" />
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>媒体库</h4>
    <img src="img/media.png" alt="媒体库" style="max-width: 100%; height: auto;" />
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>系统日志</h4>
    <img src="img/logs.png" alt="系统日志" style="max-width: 100%; height: auto;" />
  </div>
</div>

### Telegram 机器人界面

<div style="display: flex; flex-wrap: wrap; gap: 20px; justify-content: flex-start;">
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>帮助信息</h4>
    <img src="img/bot/1.jpg" alt="帮助命令" style="max-width: 100%; height: auto;" />
    <p>通过 /help 查看所有可用命令。</p>
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>资源搜索</h4>
    <img src="img/bot/2.jpg" alt="资源搜索" style="max-width: 100%; height: auto;" />
    <p>使用 /search_cs 搜索资源。</p>
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>创建任务</h4>
    <img src="img/bot/3.jpg" alt="创建任务" style="max-width: 100%; height: auto;" />
    <p>发送分享链接或编号可直接创建任务。</p>
  </div>
  <div style="flex: 0 0 calc(50% - 10px);">
    <h4>任务列表</h4>
    <img src="img/bot/5.jpg" alt="任务列表" style="max-width: 100%; height: auto;" />
    <p>使用 /tasks 查看当前任务列表。</p>
  </div>
</div>

</details>

## 特别声明


1. 本项目仅供学习交流，请勿用于非法用途。
2. 本项目当前版本提供移动云盘（139）转存能力，接口来自各平台官方接口。
3. 由使用本项目产生的风险与后果由用户自行承担。

## License

MIT



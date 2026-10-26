# cloudpan-auto-save

多云盘自动转存系统，支持 **移动云盘（139）**，自动监控分享链接更新并转存文件，支持 Telegram 机器人操作。

> 本项目是一套专注于 **中国移动云盘（139）** 及多网盘生态的自动化追更转存与媒体资产管理系统。全面重构 Vue3 前端并内置 302 直链 STRM 播放与治理功能。

---

## ✨ 主要功能

- 🔄 定时监控分享链接，自动转存更新文件
- ☁️ **当前支持移动云盘（139）**
- 🤖 Telegram 机器人：远程添加/删除任务、目录浏览、资源搜索
- 🔍 CloudSaver 资源搜索与分组展示
- 📲 消息推送：Telegram、企业微信、Bark、Wxpusher
- 🌙 WebUI 可视化管理，支持暗黑模式
- 🔑 系统 API Key，支持第三方调用

---

## 🚀 快速部署

```bash
docker run -d \
  -v /yourpath/data:/home/data \
  -p 3001:3000 \
  --restart unless-stopped \
  --name cloudpan-auto-save \
  azheng0108/cloudpan-auto-save:latest
```

> - `yourpath` 替换为宿主机实际目录
> - 端口 `3001` 可避免与原项目（默认 `3000`）冲突

浏览器访问 `http://localhost:3001`，默认账号密码：`admin / admin`，**登录后请立即修改密码**。

---

## ⚠️ 安全提示

- 请**私有化部署**，不建议将服务直接暴露在公网
- 不要使用他人搭建的本项目实例
- 建议配置反向代理 + HTTPS

---

## 🔗 相关链接

- GitHub 源码：[azheng0108/cloudpan-auto-save](https://github.com/azheng0108/cloudpan-auto-save)

# 部署说明（D4 基线）

## 运行要求

- Node.js 18+
- SQLite 持久化目录可写
- data 目录可持久化挂载

## 构建

- npm run build

## 生产启动

推荐使用：

- npm run start:prod

该命令会先执行 migration:run:prod，再启动服务。

## 健康检查

- 路径：GET /api/health
- Docker HEALTHCHECK 应指向该接口

## 容器运行建议

- 使用非 root 用户运行（USER node）
- 挂载 data 目录，确保配置与会话持久化

## 升级流程建议

1. 拉取新版本镜像或代码
2. 执行 npm run build
3. 执行 npm run start:prod
4. 校验 /api/health 为 ok
5. 执行 npm test（推荐）

## 回滚建议

- 保留上一个可用镜像 tag
- 保留 data 目录快照
- 若升级失败，回滚镜像并恢复 data 快照

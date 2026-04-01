# API 说明（D4 基线）

本文档用于补齐当前主运行链路的核心接口说明，事实以服务端路由实现为准。

## 认证

- 登录接口：POST /api/auth/login
- 会话校验：除白名单外，/api/* 需会话或 x-api-key
- 白名单：/、/login、/api/health、/api/auth/login、静态资源

## 健康检查

### GET /api/health

用途：容器健康探针与运行状态检查。

成功响应示例：

```json
{
  "success": true,
  "status": "ok",
  "version": "2.2.47",
  "uptimeSeconds": 123,
  "database": { "connected": true },
  "timestamp": "2026-04-01T06:00:00.000Z"
}
```

异常场景：数据库不可用时返回 503，status 为 degraded。

## 系统设置

### GET /api/settings

返回当前系统配置。

### POST /api/settings

用途：保存系统配置并重建相关运行时组件。

关键行为：
- 调度配置变更会触发 SchedulerService 重新应用任务计划
- 消息配置会触发消息组件刷新
- 如果 system.password 发生变更：
  - 物理清理 data/sessions 下会话文件
  - 当前会话失效并销毁

成功响应：

```json
{ "success": true, "data": null }
```

## 任务执行

### POST /api/tasks/:id/execute

用途：执行单个任务。

### POST /api/tasks/executeAll

用途：批量触发执行任务。

## 版本

### GET /api/version

返回当前应用版本号。

## 说明

- 139 为主运行链路，legacy 189 默认禁用。

## 错误响应约定

- 业务错误默认字段：`success=false` + `error`（字符串）。
- 部分异常路径会返回 HTTP 500，同时 body 仍包含 `success=false` 与 `error`。
- 调用方应优先判断 `success`，其次结合 HTTP 状态码处理。

典型业务错误示例（200）：

```json
{
  "success": false,
  "error": "任务不存在"
}
```

典型认证错误示例（401）：

```json
{
  "success": false,
  "error": "未登录"
}
```

典型服务异常示例（500）：

```json
{
  "success": false,
  "error": "数据库连接失败"
}
```

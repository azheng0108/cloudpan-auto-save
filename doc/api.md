### 认证要求
所有API请求都需要在HTTP请求头中包含认证信息：
```http
x-api-key: {apiKey}
```

### 1. 获取账号列表
- 接口 : /api/accounts
- 方法 : GET
- 描述 : 获取所有已配置的天翼云盘账号
- 返回示例 :
```json
{
    "success": true,
    "data": [
        {
            "id": "账号ID",
            "username": "用户名",
            "capacity": {
                "cloudCapacityInfo": {
                    "usedSize": "已用容量",
                    "totalSize": "总容量"
                },
                "familyCapacityInfo": {
                    "usedSize": "家庭空间已用容量",
                    "totalSize": "家庭空间总容量"
                }
            }
        }
    ]
}
```

###  2.获取常用目
- 接口 : /api/favorites/{accountId}
- 方法 : GET
- 描述 : 获取指定账号的常用目录列表
- 返回示例 :
```json
{
    "success": true,
    "data": [
        {
            "id": "目录ID",
            "path": "目录完整路径"
        }
    ]
}
```

###  3.创建任务
- 接口 : /api/tasks
- 方法 : POST
- 参数 :
```json
{
    "accountId": "账号ID",
    "shareLink": "分享链接",
    "targetFolderId": "目标文件夹ID",
    "overwriteFolder": "是否覆盖",
    "targetFolder": "目标文件夹完整路径",
}
```
- 成功返回示例 :
```json
{
    "success": true,
    "data": [{
        "id": "任务ID"
    }]
}
```
- 目录已存在返回示例 :
```json
{
    "success": false,
    "error": "folder already exists"
}
如果目录已存在, 需要提示用户是否覆盖, 如果点击覆盖, 继续调用创建任务, 参数新增: overwriteFolder: 1
```

###  4.执行任务
- 接口 : /api/tasks/{taskId}/execute
- 方法 : POST
- 描述 : 执行指定的任务

注意!  创建任务不会立即执行, 需要调用此接口执行任务
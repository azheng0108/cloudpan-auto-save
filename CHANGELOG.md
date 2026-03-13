# 更新日志

## [2.2.45] - 2026-03-13

### 修复

#### 移动云盘（139）转存

- **重复目录堆积问题**（关键修复）
  - **问题**：每次执行转存任务时，在目标目录下不断创建带时间戳和随机后缀的重复文件夹（如 `风骚律师系列_20260313_000440_1795`），导致云盘中同系列文件夹越来越多
  - **根因**：`_findMatchingFolder139` 使用 `listDiskDir`（每次仅返回首页 100 条，无分页），当目标目录子文件夹数量超过 100 时无法找到已有同名目录，触发 `createFolderHcy`，139 API 检测到同名后自动追加时间戳和随机后缀新建文件夹
  - **修复**：新增 `cloud139.findFolderByName()` 方法，使用 `nextPageCursor` 分页遍历所有子目录，确保无论目录数量多少都能正确查找到已有同名目录

- **压缩包不被保存的问题**
  - **问题**：开启「只保存媒体文件」后，`.rar`、`.zip`、`.tar`、`.7z` 等压缩包格式无法被转存
  - **根因**：默认 `mediaSuffix` 仅包含视频格式，不含常见压缩包后缀
  - **修复**：默认 `mediaSuffix` 新增 `.rar;.zip;.7z;.tar;.gz;.tar.gz;.tar.bz2;.tar.xz`

- **磁盘压缩包文件去重失效**
  - **问题**：已转存的压缩包文件每次都被重复转存
  - **根因**：`listAllDiskFiles` 用 `&& f.fileExtension` 判断是否为文件，但 139 API 对压缩包的 `fileExtension` 字段可能返回空值，导致这些文件未计入去重名单
  - **修复**：改用 `&& f.name` 判断，有文件名即视为有效文件

- **文件类型误判**
  - **问题**：`listDiskDir` 将无 `fileExtension` 的文件（如压缩包）误判为文件夹类型
  - **修复**：仅凭 `fileType`/`category` 字段判断类型，不再依赖 `fileExtension`

#### 界面（前端）

- **选择目录弹窗底部「确定/取消」按钮被遮挡**
  - **问题**：创建文件夹输入框出现时，弹窗底部按钮超出视口不可见
  - **根因**：`.modal-content` 无 `max-height` 限制；`.form-body` 用固定 `height` 在 flex 容器中行为不稳定；`position: sticky` 在无 `overflow` 限制的父容器中失效
  - **修复**：`.modal-content` 增加 `max-height: 90vh; overflow: hidden`；`.form-body` 改为 `flex: 1 1 auto; min-height: 0`（flexbox 可滚动标准写法）；`.form-actions` 改为 `flex-shrink: 0` 确保始终可见；清理重复 CSS 声明

- **新建文件夹确认/取消按钮被水平溢出遮挡**
  - **问题**：目录树含超长文件名时水平滚动，输入行随之变宽，✓/✗ 按钮被推出可见区域
  - **修复**：`.mkdir-input-row` 添加 `position: sticky; left: 0`，使输入行始终贴左显示

- **目录树横向滚动条缺失**
  - **问题**：文件夹名称过长时超出弹窗宽度，没有横向滚动条
  - **修复**：横向滚动管理上移至 `.form-body`（`overflow-x: auto`）；`.folder-tree` 改为 `width: max-content` 使内容宽度撑开父容器，触发横向滚动条

---

## [2.2.44] - 历史版本

> 详见 Git 提交记录

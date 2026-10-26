// 账号切换器条目契约（对齐频道监控规范：组件契约 design 接口一）
export interface AccountSwitcherItem {
  id: number | string;
  accountName?: string;
  username?: string;
  phone?: string;
  isDefault?: boolean;
  isActive?: boolean;
}
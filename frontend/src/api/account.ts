import { http } from './request';

export interface AccountItem {
  id: number | string;
  username: string;
  original_username?: string;
  alias?: string;
  accountType: 'cloud139' | 'cloud189';
  isDefault: boolean;
  isActive: boolean;
  memberStatus?: string;
  memberStatusText?: string;
  memberInfo?: {
    memberName?: string;
  } | null;
  capacity?: {
    cloudCapacityInfo?: { usedSize: number; totalSize: number };
    familyCapacityInfo?: { usedSize: number; totalSize: number };
    totalCapacityInfo?: { usedSize: number; totalSize: number };
  };
}

export interface CloudFileItem {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  updatedAt?: string;
}

export const accountApi = {
  getAccounts(): Promise<AccountItem[]> {
    return http.get('/api/accounts');
  },
  addAccount(data: any): Promise<any> {
    return http.post('/api/accounts', data);
  },
  deleteAccount(id: number | string): Promise<any> {
    return http.delete(`/api/accounts/${id}`);
  },
  recycleAccounts(): Promise<any> {
    return http.delete('/api/accounts/recycle');
  },
  setAlias(id: number | string, alias: string): Promise<any> {
    return http.put(`/api/accounts/${id}/alias`, { alias });
  },
  setDefault(id: number | string): Promise<any> {
    return http.put(`/api/accounts/${id}/default`);
  },
  cancelDefault(id: number | string): Promise<any> {
    return http.delete(`/api/accounts/${id}/default`);
  },
  createQrCode(): Promise<{ sID: string; dID: string; qrUrl: string; qrDataUrl: string; expiresIn: number }> {
    return http.get('/api/accounts/qrcode/create');
  },
  checkQrStatus(sID: string): Promise<{ status: 'waiting' | 'confirmed' | 'expired'; account?: string; message?: string }> {
    return http.get('/api/accounts/qrcode/status', { params: { sID } });
  },
  getFolders(accountId: number | string, parentId?: string): Promise<CloudFileItem[]> {
    return http.get(`/api/folders/${accountId}`, { params: { folderId: parentId || '-11' } });
  },
};

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { accountApi, type AccountItem } from '../api/account';

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<AccountItem[]>([]);
  const loading = ref(false);

  const defaultAccount = computed(() => accounts.value.find((a) => a.isDefault) || accounts.value[0]);
  const activeAccounts = computed(() => accounts.value.filter((a) => a.isActive !== false));

  async function fetchAccounts() {
    loading.value = true;
    try {
      accounts.value = await accountApi.getAccounts();
    } finally {
      loading.value = false;
    }
  }

  return {
    accounts,
    loading,
    defaultAccount,
    activeAccounts,
    fetchAccounts,
  };
});

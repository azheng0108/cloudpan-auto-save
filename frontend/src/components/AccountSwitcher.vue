<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { User, ChevronDown, Check } from 'lucide-vue-next';
import type { AccountSwitcherItem } from './accountSwitcher';

const props = defineProps<{
  accounts: AccountSwitcherItem[];
  modelValue: number | string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', id: number | string): void;
  (e: 'select', account: AccountSwitcherItem): void;
}>();

// 浮层开合状态（组件局部 UI 状态，不持久化、不进 store）
const isDropdownOpen = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

const hasAccounts = computed(() => props.accounts.length > 0);

// 当前选中账号（单一状态源在父组件，此处仅读取展示）
const currentAccount = computed(() => {
  return props.accounts.find((a) => a.id === props.modelValue) || props.accounts[0] || null;
});

// 取名优先级：账号备注名 → 用户名 → 手机号 → "账号 + 编号"（与迁移前三处口径一致）
function displayName(acc?: AccountSwitcherItem | null, fallbackId?: number | string): string {
  if (!acc) {
    return fallbackId !== undefined && fallbackId !== '' ? `账号 ${fallbackId}` : '未选择账号';
  }
  return acc.accountName || acc.username || acc.phone || `账号 ${acc.id}`;
}

// 空态：账号列表为空时浮层不展开（spec 5.5.3.2）
function toggleDropdown() {
  if (!hasAccounts.value) return;
  isDropdownOpen.value = !isDropdownOpen.value;
}

function handleSelect(acc: AccountSwitcherItem) {
  isDropdownOpen.value = false;
  emit('update:modelValue', acc.id);
  emit('select', acc);
}

// 点击组件外部浮层自动收起（spec 5.5.1.4）
function handleOutsideClick(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    isDropdownOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleOutsideClick);
});

onUnmounted(() => {
  document.removeEventListener('click', handleOutsideClick);
});
</script>

<template>
  <!-- 账号切换选择器（并置目录选择框旁边，视觉规格提炼自 MaintenanceView:3082-3167 原位形态） -->
  <div ref="dropdownRef" class="account-switcher">
    <button
      type="button"
      class="account-switcher__btn"
      :title="hasAccounts ? '切换 139 移动云盘操作用户' : '当前无可用 139 账号'"
      @click.stop="toggleDropdown"
    >
      <!-- 139 专属移动云盘标识 -->
      <div class="account-switcher__logo">
        <User class="w-4 h-4" />
      </div>

      <div class="flex flex-col min-w-0 pr-1">
        <div class="flex items-center gap-1.5 leading-none">
          <span class="account-switcher__tag">139 移动云盘</span>
          <span v-if="currentAccount?.isDefault" class="account-switcher__default">默认</span>
        </div>
        <span class="account-switcher__name">
          {{ hasAccounts ? `用户: ${displayName(currentAccount, modelValue)}` : '无可用账号' }}
        </span>
      </div>

      <ChevronDown class="account-switcher__chevron" :class="{ 'is-open': isDropdownOpen }" />
    </button>

    <!-- 浮层下拉列表 -->
    <transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="transform scale-95 opacity-0"
      enter-to-class="transform scale-100 opacity-100"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="transform scale-100 opacity-100"
      leave-to-class="transform scale-95 opacity-0"
    >
      <div v-if="isDropdownOpen && hasAccounts" class="account-switcher__dropdown">
        <div class="account-switcher__dropdown-header">
          <span>切换 139 操作用户</span>
          <span class="account-switcher__dropdown-count">共 {{ accounts.length }} 个</span>
        </div>

        <div class="max-h-56 overflow-y-auto py-1">
          <button
            v-for="acc in accounts"
            :key="acc.id"
            type="button"
            class="account-switcher__option"
            :class="{ 'account-switcher__option--active': acc.id === modelValue }"
            @click="handleSelect(acc)"
          >
            <div class="flex items-center gap-2 min-w-0">
              <div
                class="account-switcher__option-avatar"
                :class="{ 'account-switcher__option-avatar--active': acc.id === modelValue }"
              >
                <User class="w-3.5 h-3.5" />
              </div>
              <div class="truncate">
                <div class="flex items-center gap-1.5">
                  <span class="account-switcher__option-name">{{ displayName(acc) }}</span>
                  <span v-if="acc.isDefault" class="account-switcher__option-default">默认</span>
                </div>
                <span v-if="acc.phone && (acc.accountName || acc.username)" class="account-switcher__option-phone">
                  {{ acc.phone }}
                </span>
              </div>
            </div>

            <Check v-if="acc.id === modelValue" class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>
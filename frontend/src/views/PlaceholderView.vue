<script setup lang="ts">
import { useRoute } from 'vue-router';
import { Layers } from 'lucide-vue-next';

const route = useRoute();
</script>

<template>
  <div class="bg-white dark:bg-[#111827] border border-gray-200/80 dark:border-gray-800 rounded-xl p-16 shadow-sm flex flex-col items-center justify-center text-center">
    <div class="w-14 h-14 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-4 shadow-sm">
      <Layers class="w-7 h-7" />
    </div>
    <div class="flex items-center gap-2 mb-2">
      <h3 class="text-base font-bold text-gray-900 dark:text-white">
        {{ route.meta.title }}
      </h3>
      <span class="px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80">
        {{ route.meta.badge }}
      </span>
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400 max-w-md mb-6 leading-relaxed">
      <strong>【第 1 阶段：仅调试主框架】</strong><br>
      当前专注于左侧边栏手风琴、顶部标题与徽章联动、页面版心骨架。本业务内容尚未开始迁移。
    </p>
    <div class="text-[11px] font-mono px-3.5 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-800">
      当前活跃路由: {{ route.path }}
    </div>
  </div>
</template>

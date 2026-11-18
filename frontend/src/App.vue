<script setup lang="ts">
import { onMounted } from 'vue';
import { initTheme } from './composables/useTheme';

onMounted(() => {
  initTheme();
});
</script>

<template>
  <router-view />
</template>

<style>
html, body {
  margin: 0;
  padding: 0;
  background-color: #f8fafc;
  color: #0f172a;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
* {
  box-sizing: border-box;
}
</style>

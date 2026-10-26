import { ref } from 'vue';

const THEME_KEY = 'theme';
export const isDark = ref(false);

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark') {
    isDark.value = true;
  } else if (saved === 'light') {
    isDark.value = false;
  } else {
    // 默认跟随系统偏好，若系统为暗黑则开启
    isDark.value = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  applyTheme();
}

export function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem(THEME_KEY, isDark.value ? 'dark' : 'light');
  applyTheme();
}

function applyTheme() {
  if (isDark.value) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

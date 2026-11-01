<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api/request';
import { ElMessage } from 'element-plus';
import { User, Lock } from '@element-plus/icons-vue';
import { Film, RefreshCw, LogIn } from 'lucide-vue-next';

interface WallpaperItem {
  id?: number;
  url: string;
  backdropUrl?: string;
  posterUrl?: string;
  title?: string;
  overview?: string;
  voteAverage?: number;
  releaseDate?: string;
  mediaType?: string;
}

const router = useRouter();
const loading = ref(false);
const rememberMe = ref(false);

const loginForm = ref({
  username: '',
  password: '',
});

// TMDB 壁纸状态管理
const wallpapers = ref<WallpaperItem[]>([]);
const currentIndex = ref(0);
const currentBg = ref('');
const isFading = ref(false);
const isRotating = ref(false);
let rotationTimer: any = null;

const currentWallpaper = computed(() => {
  if (!wallpapers.value.length) return null;
  return wallpapers.value[currentIndex.value] || null;
});

const hasWallpaper = computed(() => Boolean(currentBg.value));

// 预加载并切换背景图（平滑淡入淡出，防白屏闪烁）
function setWallpaperByIndex(index: number) {
  if (!wallpapers.value.length) return;
  const target = wallpapers.value[index];
  if (!target || !target.url) return;

  const img = new Image();
  img.onload = () => {
    isFading.value = true;
    setTimeout(() => {
      currentBg.value = target.url;
      currentIndex.value = index;
      isFading.value = false;
    }, 280);
  };
  img.src = target.url;
}

// 切换至下一张推荐壁纸
function nextWallpaper() {
  if (wallpapers.value.length <= 1) return;
  isRotating.value = true;
  setTimeout(() => {
    isRotating.value = false;
  }, 600);

  const nextIdx = (currentIndex.value + 1) % wallpapers.value.length;
  setWallpaperByIndex(nextIdx);
}

// 获取 TMDB 每日推荐壁纸
async function fetchWallpapers() {
  try {
    const res: any = await http.get('/api/auth/wall-posters');
    const list = Array.isArray(res) ? res : (res?.data || []);
    if (Array.isArray(list) && list.length > 0) {
      wallpapers.value = list.map((item: any) => {
        if (typeof item === 'string') {
          return { url: item };
        }
        return {
          id: item.id,
          url: item.url || item.backdropUrl || item.posterUrl,
          backdropUrl: item.backdropUrl,
          posterUrl: item.posterUrl,
          title: item.title,
          overview: item.overview,
          voteAverage: item.voteAverage,
          releaseDate: item.releaseDate,
          mediaType: item.mediaType,
        };
      }).filter((w: WallpaperItem) => Boolean(w.url));

      if (wallpapers.value.length > 0) {
        // 随机初始一张
        const randomIdx = Math.floor(Math.random() * wallpapers.value.length);
        setWallpaperByIndex(randomIdx);

        // 每隔 30 秒自动轮播下一张
        if (!rotationTimer) {
          rotationTimer = setInterval(() => {
            nextWallpaper();
          }, 30000);
        }
      }
    }
  } catch (_) {
    // 未配置 TMDB 或网络异常时优雅降级至默认背景
  }
}

async function handleLogin() {
  if (!loginForm.value.username || !loginForm.value.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await http.post('/api/auth/login', loginForm.value);
    if (rememberMe.value) {
      localStorage.setItem('saved_username', loginForm.value.username);
    } else {
      localStorage.removeItem('saved_username');
    }
    ElMessage.success('登录成功');
    router.push('/tasks');
  } catch (err: any) {
    // 拦截器已统一提示错误信息
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  const savedUser = localStorage.getItem('saved_username');
  if (savedUser) {
    loginForm.value.username = savedUser;
    rememberMe.value = true;
  }
  fetchWallpapers();
});

onUnmounted(() => {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
});
</script>

<template>
  <div class="login-wrapper">
    <!-- 全屏壁纸层（带淡入淡出过渡） -->
    <div
      v-if="currentBg"
      class="wallpaper-bg"
      :class="{ 'wallpaper-fading': isFading }"
      :style="{ backgroundImage: `url(${currentBg})` }"
    />

    <!-- 电影感暗色蒙版与景深晕影，确保高对比度和文字极佳可读性 -->
    <div class="vignette-overlay" :class="{ 'vignette-with-bg': hasWallpaper }" />

    <!-- 核心登录卡片 -->
    <div class="login-container">
      <div class="login-card" :class="{ 'card-frosted-light': hasWallpaper, 'card-frosted-dark': !hasWallpaper }">
        <!-- 头部 Logo 与标题 -->
        <div class="header">
          <div class="logo-box">
            <img src="/logo.svg" alt="Cloudpan Auto-Save Logo" class="logo-icon" />
          </div>
          <h1 class="app-title">139 移动云盘自动追更</h1>
          <p class="app-subtitle">欢迎回来 · 智能转存与媒体中台</p>
        </div>

        <!-- 登录表单 -->
        <el-form @keyup.enter="handleLogin">
          <el-form-item class="custom-form-item">
            <el-input
              v-model="loginForm.username"
              :prefix-icon="User"
              placeholder="用户名"
              size="large"
              class="custom-input"
              clearable
            />
          </el-form-item>

          <el-form-item class="custom-form-item">
            <el-input
              v-model="loginForm.password"
              :prefix-icon="Lock"
              type="password"
              show-password
              placeholder="密码"
              size="large"
              class="custom-input"
            />
          </el-form-item>

          <div class="form-extra-row">
            <el-checkbox v-model="rememberMe" class="custom-checkbox">
              保持登录
            </el-checkbox>
          </div>

          <el-button
            type="primary"
            size="large"
            class="submit-btn"
            :loading="loading"
            @click="handleLogin"
          >
            <template #icon>
              <LogIn class="w-4 h-4 mr-1.5" />
            </template>
            立即登录
          </el-button>
        </el-form>

        <!-- 卡片底部版权 -->
        <div class="card-footer">
          © 2026 Cloudpan Auto-Save · 移动云盘自动追更
        </div>
      </div>
    </div>

    <!-- 左下角：TMDB 每日推荐影视信息角标 -->
    <transition name="fade">
      <div v-if="currentWallpaper?.title" class="movie-badge">
        <Film class="w-4 h-4 text-amber-400 shrink-0" />
        <div class="movie-info">
          <span class="movie-title">TMDB 推荐 · {{ currentWallpaper.title }}</span>
          <span v-if="currentWallpaper.voteAverage" class="movie-rating">
            ★ {{ currentWallpaper.voteAverage }}
          </span>
          <span v-if="currentWallpaper.releaseDate" class="movie-year">
            ({{ currentWallpaper.releaseDate.slice(0, 4) }})
          </span>
        </div>
      </div>
    </transition>

    <!-- 右下角：换一张壁纸按钮 -->
    <transition name="fade">
      <button
        v-if="wallpapers.length > 1"
        type="button"
        @click="nextWallpaper"
        class="switch-wallpaper-btn"
        title="换一张 TMDB 推荐壁纸"
      >
        <RefreshCw class="w-3.5 h-3.5 transition-transform duration-500" :class="{ 'rotate-180': isRotating }" />
        <span>换一张</span>
      </button>
    </transition>
  </div>
</template>

<style scoped>
.login-wrapper {
  position: relative;
  min-height: 100vh;
  width: 100vw;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: radial-gradient(circle at 50% 20%, #1e293b 0%, #090d16 100%);
  padding: 24px 16px;
}

/* 全屏壁纸层 */
.wallpaper-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center center;
  background-repeat: no-repeat;
  transition: opacity 0.5s ease-in-out, transform 8s ease-out;
  opacity: 1;
  transform: scale(1.02);
}

.wallpaper-fading {
  opacity: 0.15;
}

/* 晕影与蒙版 */
.vignette-overlay {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(circle at center, rgba(15, 23, 42, 0.35) 0%, rgba(9, 13, 22, 0.72) 100%);
}

.vignette-with-bg {
  background: linear-gradient(
    180deg,
    rgba(15, 23, 42, 0.35) 0%,
    rgba(15, 23, 42, 0.5) 40%,
    rgba(9, 13, 22, 0.78) 100%
  );
}

/* 居中卡片容器 */
.login-container {
  position: relative;
  z-index: 10;
  width: 100%;
  max-width: 410px;
}

/* 登录卡片基础 */
.login-card {
  width: 100%;
  border-radius: 24px;
  padding: 40px 36px 30px;
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 仿 MoviePilot 高级白色亚克力毛玻璃风格 (图2) */
.card-frosted-light {
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.3) inset;
}

.card-frosted-light .app-title {
  color: #1e293b;
}

.card-frosted-light .app-subtitle {
  color: #64748b;
}

.card-frosted-light :deep(.el-form-item__label) {
  color: #475569 !important;
  font-weight: 500;
  font-size: 13.5px;
  margin-bottom: 6px;
}

.card-frosted-light :deep(.el-input__wrapper) {
  background-color: rgba(241, 245, 249, 0.85) !important;
  border-radius: 12px !important;
  box-shadow: 0 0 0 1px rgba(203, 213, 225, 0.8) inset !important;
  padding: 4px 14px;
  transition: all 0.2s ease;
}

.card-frosted-light :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px #94a3b8 inset !important;
}

.card-frosted-light :deep(.el-input__wrapper.is-focus) {
  background-color: #ffffff !important;
  box-shadow: 0 0 0 2px #3b82f6 inset !important;
}

.card-frosted-light :deep(.el-input__inner) {
  color: #1e293b !important;
  font-weight: 500;
}

.card-frosted-light :deep(.el-checkbox__label) {
  color: #64748b !important;
  font-size: 13px;
}

.card-frosted-light .card-footer {
  color: #94a3b8;
}

/* 降级暗色毛玻璃风格 (未配置 TMDB 时) */
.card-frosted-dark {
  background: rgba(30, 41, 59, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
}

.card-frosted-dark .app-title {
  color: #f8fafc;
}

.card-frosted-dark .app-subtitle {
  color: #94a3b8;
}

.card-frosted-dark :deep(.el-form-item__label) {
  color: #cbd5e1 !important;
  font-weight: 500;
  font-size: 13px;
  margin-bottom: 6px;
}

.card-frosted-dark :deep(.el-input__wrapper) {
  background-color: rgba(15, 23, 42, 0.7) !important;
  border-radius: 12px !important;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset !important;
  padding: 4px 14px;
}

.card-frosted-dark :deep(.el-input__wrapper:hover) {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25) inset !important;
}

.card-frosted-dark :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 2px #3b82f6 inset !important;
}

.card-frosted-dark :deep(.el-input__inner) {
  color: #f8fafc !important;
}

.card-frosted-dark :deep(.el-checkbox__label) {
  color: #94a3b8 !important;
  font-size: 13px;
}

.card-frosted-dark .card-footer {
  color: #64748b;
}

/* 头部样式 */
.header {
  text-align: center;
  margin-bottom: 30px;
}

.logo-box {
  width: 58px;
  height: 58px;
  margin: 0 auto 14px;
  border-radius: 18px;
  background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px;
  box-shadow: 0 10px 25px -4px rgba(37, 99, 235, 0.45);
}

.logo-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
}

.app-title {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
  line-height: 1.3;
}

.app-subtitle {
  font-size: 13px;
  margin: 6px 0 0;
  letter-spacing: 0.01em;
}

.custom-form-item {
  margin-bottom: 20px;
}

.form-extra-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: -6px 0 20px;
}

.submit-btn {
  width: 100%;
  height: 46px;
  font-size: 15px;
  font-weight: 600;
  border-radius: 12px;
  background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
  border: none;
  box-shadow: 0 6px 20px -2px rgba(37, 99, 235, 0.4);
  transition: all 0.25s ease;
  letter-spacing: 0.02em;
}

.submit-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 25px -2px rgba(37, 99, 235, 0.5);
  background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%);
}

.submit-btn:active {
  transform: translateY(0);
}

.card-footer {
  text-align: center;
  font-size: 12px;
  margin-top: 26px;
  letter-spacing: 0.02em;
}

/* 左下角影视信息胶囊 */
.movie-badge {
  position: fixed;
  bottom: 20px;
  left: 20px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #f8fafc;
  font-size: 12.5px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-width: 80vw;
}

.movie-info {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.movie-title {
  font-weight: 600;
  color: #f1f5f9;
}

.movie-rating {
  color: #fbbf24;
  font-weight: 700;
  font-size: 11.5px;
}

.movie-year {
  color: #94a3b8;
  font-size: 11.5px;
}

/* 右下角换一张按钮 */
.switch-wallpaper-btn {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 9999px;
  background: rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #e2e8f0;
  font-size: 12.5px;
  font-weight: 500;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: all 0.25s ease;
}

.switch-wallpaper-btn:hover {
  background: rgba(15, 23, 42, 0.85);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
  transform: translateY(-1px);
}

.switch-wallpaper-btn:active {
  transform: translateY(0);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .login-card {
    padding: 32px 24px 24px;
    border-radius: 20px;
  }
  .movie-badge {
    bottom: 14px;
    left: 14px;
    padding: 6px 12px;
    font-size: 11.5px;
  }
  .switch-wallpaper-btn {
    bottom: 14px;
    right: 14px;
    padding: 6px 12px;
    font-size: 11.5px;
  }
}
</style>

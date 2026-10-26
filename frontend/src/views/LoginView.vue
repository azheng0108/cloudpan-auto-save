<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '../api/request';
import { ElMessage } from 'element-plus';
import { User, Lock } from '@element-plus/icons-vue';

const router = useRouter();
const loading = ref(false);

const loginForm = ref({
  username: '',
  password: '',
});

async function handleLogin() {
  if (!loginForm.value.username || !loginForm.value.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await http.post('/api/auth/login', loginForm.value);
    ElMessage.success('登录成功');
    router.push('/tasks');
  } catch (err: any) {
    // 拦截器已弹窗
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="header">
        <div class="logo-title">
          <img src="/logo.svg" alt="139 Auto Save Logo" class="logo-icon object-contain rounded-lg shadow-md shadow-blue-500/20" />
          <h1>139 移动云盘自动追更</h1>
        </div>
        <p class="subtitle">Cloudpan Auto-Save 工业级管理中台</p>
      </div>

      <el-form label-position="top" @keyup.enter="handleLogin">
        <el-form-item label="管理员账号">
          <el-input
            v-model="loginForm.username"
            :prefix-icon="User"
            placeholder="默认用户名: admin"
            size="large"
          />
        </el-form-item>
        <el-form-item label="登录密码">
          <el-input
            v-model="loginForm.password"
            :prefix-icon="Lock"
            type="password"
            show-password
            placeholder="请输入系统密码"
            size="large"
          />
        </el-form-item>

        <el-button
          type="primary"
          size="large"
          class="submit-btn"
          :loading="loading"
          @click="handleLogin"
        >
          立即登录
        </el-button>
      </el-form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 20%, #1e293b 0%, #0f172a 100%);
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 400px;
  background: rgba(30, 41, 59, 0.85);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 36px 32px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}
.header {
  text-align: center;
  margin-bottom: 28px;
}
.logo-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.logo-icon {
  width: 32px;
  height: 32px;
}
.header h1 {
  font-size: 19px;
  font-weight: 600;
  margin: 0;
  color: #f8fafc;
}
.subtitle {
  font-size: 13px;
  color: #94a3b8;
  margin: 6px 0 0;
}
.submit-btn {
  width: 100%;
  margin-top: 12px;
  font-weight: 600;
  border-radius: 8px;
}
</style>

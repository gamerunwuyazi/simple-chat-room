<!-- eslint-disable vue/multi-word-component-names -->
<template>
 <div class="login-container">
  <!-- 装饰性元素 -->
  <div class="decoration decoration-1"></div>
  <div class="decoration decoration-2"></div>
  <div class="decoration decoration-3"></div>

  <div class="login-form">
   <button class="theme-toggle" type="button" @click="toggleDarkMode" :title="isDarkMode ? '切换为浅色模式' : '切换为深色模式'">
    <span class="theme-icon"><i class="fas" :class="isDarkMode ? 'fa-sun' : 'fa-moon'" aria-hidden="true"></i></span>
   </button>
   <h1>登录聊天室</h1>
   <form @submit.prevent="handleLoginClick">
    <div class="input-group">
     <label for="username">用户名</label>
     <input
      type="text"
      id="username"
      v-model="formData.username"
      name="username"
      required
      placeholder="请输入用户名"
     >
    </div>
    <div class="input-group">
     <label for="password">密码</label>
     <input
      type="password"
      id="password"
      v-model="formData.password"
      name="password"
      required
      placeholder="请输入密码"
     >
    </div>
    <div v-if="loginNotice" class="login-notice" v-html="loginNotice" :style="noticeStyle"></div>
    <button type="submit" :disabled="!isFormValid || isSubmitting">
     {{ isSubmitting ? '登录中...' : '登录' }}
    </button>
   </form>
   <p class="register-link">还没有账号？<router-link to="/register">去注册</router-link></p>
   
   <!-- 人机验证进度显示（底部左侧） -->
   <div v-if="captchaVisible" class="captcha-progress-row">
     <div class="captcha-progress-ring">
       <svg viewBox="0 0 100 100" class="progress-svg">
         <defs>
           <linearGradient id="capGradient" x1="0%" y1="0%" x2="100%" y2="100%">
             <stop offset="0%" stop-color="#3b82f6" />
             <stop offset="100%" stop-color="#06b6d4" />
           </linearGradient>
         </defs>
         <circle cx="50" cy="50" r="45" class="progress-bg"></circle>
         <circle cx="50" cy="50" r="45" class="progress-bar" stroke="url(#capGradient)" :style="{ strokeDashoffset: 283 - (captchaProgress * 283 / 100) }"></circle>
       </svg>
     </div>
     <div class="captcha-status-text">{{ captchaProgress }}%: {{ captchaStatus }}</div>
   </div>
   
   <div v-if="message" :class="['login-message', messageType]">
    {{ message }}
   </div>
  </div>
 </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { humanVerify } from 'human-verify';
import { login } from "@/utils/chat";
import { login as apiLogin } from '@/api/user.js';

const loginNotice = import.meta.env.VITE_LOGIN_NOTICE || '';
const noticeColor = import.meta.env.VITE_LOGIN_NOTICE_COLOR || '';
const noticeBg = import.meta.env.VITE_LOGIN_NOTICE_BG || '';
const noticeBorder = import.meta.env.VITE_LOGIN_NOTICE_BORDER || '';
const noticeStyle = computed(() => {
 const style = {};
 if (noticeColor) style.color = noticeColor;
 if (noticeBg) style.backgroundColor = noticeBg;
 if (noticeBorder) style.borderColor = noticeBorder;
 return style;
});

// 深色模式切换
const isDarkMode = ref(false);
onMounted(() => {
 try {
  isDarkMode.value = document.body.classList.contains('dark-mode');
 } catch {}
});
function toggleDarkMode() {
 isDarkMode.value = !isDarkMode.value;
 document.body.classList.toggle('dark-mode', isDarkMode.value);
 try {
  localStorage.setItem('dark-mode', isDarkMode.value ? '1' : '0');
 } catch {}
}

const formData = reactive({
 username: '',
 password: ''
});

const message = ref('');
const messageType = ref('error');
const isSubmitting = ref(false);

// 人机验证进度状态
const captchaVisible = ref(false);
const captchaProgress = ref(0);
const captchaStatus = ref('');

const serverUrl = import.meta.env.VITE_SERVER_URL || '';

const isFormValid = computed(() => {
 const usernameValid = !!formData.username && String(formData.username).trim().length > 0;
 const passwordValid = !!formData.password && String(formData.password).trim().length > 0;
 return usernameValid && passwordValid;
});

function showMessage(msg, type) {
 message.value = msg;
 messageType.value = type;
 setTimeout(() => {
  message.value = '';
 }, 5000);
}

async function handleLoginClick() {
 if (!formData.username || !formData.password) {
  showMessage('请输入用户名和密码', 'error');
  return;
 }

 if (isSubmitting.value) return;

 isSubmitting.value = true;

 // 显示人机验证进度
 captchaVisible.value = true;
 captchaProgress.value = 0;
 captchaStatus.value = '准备验证...';

 try {
  // 人机验证（函数模式）
  const verifyResult = await humanVerify({
    challengeUrl: `${serverUrl}/api/verify/challenge`,
    powChallengeUrl: `${serverUrl}/api/verify/pow-challenge`,
    powVerifyUrl: `${serverUrl}/api/login`,
    onProgress: (progress, status) => {
      captchaProgress.value = progress;
      captchaStatus.value = status;
    }
  });

  // 验证完成，隐藏进度显示
  captchaVisible.value = false;

  if (!verifyResult.passed) {
   captchaVisible.value = false;
   showMessage(verifyResult.reason || '人机验证未通过', 'error');
   isSubmitting.value = false;
   return;
  }

  // 登录
  const res = await apiLogin(formData.username, formData.password, verifyResult.sessionId, verifyResult.pow.nonce);
  const data = res.data;

  // 登录成功处理
  const userId = data.userId || (data.user && data.user.id) || (data.data && data.data.id) || '';
  const nickname = data.nickname || (data.user && data.user.nickname) || (data.data && data.data.nickname) || '';
  const signature = data.signature || (data.user && data.user.signature) || (data.data && data.data.signature) || '';
  const avatarUrl = data.avatarUrl || (data.user && data.user.avatarUrl) || (data.data && data.data.avatarUrl) || (data.user && data.user.avatar) || (data.data && data.data.avatar) || null;
  const gender = data.gender || (data.user && data.user.gender) || (data.data && data.data.gender) || 0;
  const sessionToken = data.sessionToken || data.token || data.session_token;
  const refreshToken = data.refreshToken || data.refresh_token;

  if (!userId || !sessionToken) {
    showMessage('登录响应数据不完整，请稍后重试', 'error');
    isSubmitting.value = false;
    return;
  }

  const userData = {
    id: userId ? String(userId) : '',
    nickname: nickname,
    signature: signature,
    gender: gender,
    avatarUrl: avatarUrl && typeof avatarUrl === 'string' ? avatarUrl.trim() : null
  };

  localStorage.setItem('currentSessionToken', sessionToken);
  localStorage.setItem('chatUserId', userData.id);

  if (refreshToken) {
    localStorage.setItem('refreshToken', refreshToken);
  }

  showMessage('登录成功，正在跳转...', 'success');
  setTimeout(() => {
    login();
  }, 500);
 } catch (error) {
  let errorMessage = error.response?.data?.message || error.response?.data?.msg || error.message || '登录失败';
  if (error.response?.status === 401 || errorMessage.includes('用户名') || errorMessage.includes('密码')) {
    showMessage(errorMessage, 'error');
    isSubmitting.value = false;
    return;
  }
  if (error.response?.status === 429) {
    errorMessage = errorMessage || '操作过于频繁，请稍后再试';
  } else if (error.response?.status === 403) {
    errorMessage = errorMessage || '账号异常，请联系管理员';
  }
  showMessage(errorMessage, 'error');
  isSubmitting.value = false;
 }
}
</script>

<style scoped>
/* 登录页面容器样式 */
.login-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, white 0%, #e0f1ff 100%);
  padding: 20px;
  box-sizing: border-box;
  overflow: hidden;
}

/* 装饰性元素 */
.decoration {
  position: absolute;
  border-radius: 50%;
  background: rgba(150, 200, 255, 0.6);
}

.decoration-1 {
  width: 150px;
  height: 150px;
  background: rgba(150, 200, 255, 0.6);
  top: -150px;
  right: 0px;
  animation: float 16s infinite ease-in-out;
}

.decoration-2 {
  width: 200px;
  height: 200px;
  background: rgba(140, 190, 255, 0.55);
  bottom: -100px;
  left: -50px;
  animation: float 12s infinite ease-in-out;
}

.decoration-3 {
  width: 100px;
  height: 100px;
  background: rgba(160, 210, 255, 0.5);
  top: 50%;
  right: 50px;
  animation: float 8s infinite ease-in-out;
}

@keyframes float {
  0%,
  100% {
    transform: translateY(0) translateX(0);
  }

  25% {
    transform: translateY(-60px) translateX(30px);
  }

  50% {
    transform: translateY(30px) translateX(-45px);
  }

  75% {
    transform: translateY(-30px) translateX(-30px);
  }
}

/* 登录表单容器 */
.login-form {
  position: relative;
  background: white;
  padding: 40px;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 400px;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
  z-index: 10;
}

.login-form:hover {
  transform: translateY(-2px);
  box-shadow: 0 15px 40px rgba(0, 0, 0, 0.15);
}

h1 {
  text-align: center;
  color: #333;
  margin-bottom: 30px;
  font-size: 24px;
  font-weight: 600;
}

/* 深色模式切换按钮 */
.theme-toggle {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid #e1e5e9;
  background: #f9fafb;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  padding: 0;
  margin: 0;
  box-shadow: none;
  color: inherit;
  font-size: 16px;
  line-height: 1;
}

.theme-toggle:hover {
  background: #e8ecf1;
  border-color: #c8d0d9;
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.1);
}

.theme-toggle:active {
  transform: translateY(0);
}

.theme-icon {
  font-size: 16px;
  line-height: 1;
  display: inline-block;
}

form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

label {
  font-size: 14px;
  font-weight: 500;
  color: #555;
}

input {
  padding: 12px 15px;
  border: 2px solid #e1e5e9;
  border-radius: 8px;
  font-size: 16px;
  transition: all 0.3s ease;
  background-color: #f9fafb;
}

input:focus {
  outline: none;
  border-color: #0072ff;
  background-color: white;
  box-shadow: 0 0 0 3px rgba(0, 114, 255, 0.1);
}

/* 通知文本样式 */
.login-notice {
  text-align: center;
  font-size: 13px;
  color: #e67e22;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #f0c27a;
  background-color: #fef9e7;
  margin-top: 10px;
}

button {
  background: #0072ff;
  color: white;
  border: none;
  padding: 14px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  margin-top: 10px;
}

button:hover {
  transform: translateY(-1px);
  box-shadow: 0 5px 15px rgba(0, 114, 255, 0.4);
  background: #0062dd;
}

button:active {
  transform: translateY(0);
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.register-link {
  text-align: center;
  margin-top: 25px;
  font-size: 14px;
  color: #666;
}

.register-link a {
  color: #0072ff;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.3s ease;
}

.register-link a:hover {
  color: #0056b3;
  text-decoration: underline;
}

.login-message {
  text-align: center;
  font-size: 14px;
  margin-top: 15px;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid;
}

.login-message.error {
  color: #d32f2f;
  background-color: #ffebee;
  border-color: #ffcdd2;
}

.login-message.success {
  color: #388e3c;
  background-color: #e8f5e8;
  border-color: #c8e6c9;
}

/* 验证码模态框 */
.captcha-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.captcha-modal {
  background: white;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  padding: 24px;
  max-width: 360px;
  width: 90%;
  animation: modalIn 0.2s ease-out;
}

@keyframes modalIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.captcha-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.captcha-close-btn {
  background: none;
  border: none;
  font-size: 22px;
  color: #999;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
  margin-top: 0;
}

.captcha-close-btn:hover {
  color: #333;
}

.captcha-modal-body {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.captcha-error {
  color: #d32f2f;
  font-size: 13px;
  margin-top: 10px;
  text-align: center;
}

@media (max-width: 480px) {
  .login-form {
    padding: 30px 20px;
  }

  h1 {
    font-size: 22px;
  }

  input, button {
    font-size: 15px;
  }
}

/* === 深色模式 === */
@media (prefers-color-scheme: dark) {
  .login-container {
    background: linear-gradient(135deg, #0d1117 0%, #161b22 100%);
  }
  .login-form {
    background: #161b22;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }
  h1 {
    color: #f0f6fc;
  }
  .theme-toggle {
    background: #21262d;
    border-color: #30363d;
  }
  .theme-toggle:hover {
    background: #30363d;
    border-color: #484f58;
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
  }
  label {
    color: #8b949e;
  }
  input {
    background-color: #0d1117;
    border-color: #30363d;
    color: #c9d1d9;
  }
  input:focus {
    border-color: #388bfd;
    background-color: #161b22;
    box-shadow: 0 0 0 3px rgba(56, 139, 255, 0.3);
  }
  input::placeholder {
    color: #6e7681;
  }
  button {
    background: #238636;
  }
  button:hover:not(:disabled) {
    background: #2ea043;
    box-shadow: 0 5px 15px rgba(46, 160, 67, 0.4);
  }
  button:disabled {
    background-color: #21262d;
    color: #6e7681;
  }
  .register-link {
    color: #8b949e;
  }
  .register-link a {
    color: #388bfd;
  }
  .register-link a:hover {
    color: #58a6ff;
  }
  .login-message.error {
    background-color: rgba(248, 81, 73, 0.15);
    color: #f85149;
    border-color: rgba(248, 81, 73, 0.4);
  }
  .login-message.success {
    background-color: rgba(46, 160, 67, 0.15);
    color: #3fb950;
    border-color: rgba(46, 160, 67, 0.4);
  }
  .login-notice {
    background-color: rgba(210, 153, 34, 0.15);
    color: #d29922;
    border-color: rgba(210, 153, 34, 0.4);
  }
  .decoration {
    background: rgba(56, 139, 253, 0.15) !important;
  }
  .decoration-1 {
    background: rgba(56, 139, 253, 0.15) !important;
  }
  .decoration-2 {
    background: rgba(88, 166, 255, 0.12) !important;
  }
  .decoration-3 {
    background: rgba(56, 139, 253, 0.1) !important;
  }
  .captcha-modal {
    background: #161b22;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  }
  .captcha-modal-header {
    color: #f0f6fc;
  }
  .captcha-close-btn {
    color: #8b949e;
  }
  .captcha-close-btn:hover {
    color: #f0f6fc;
  }
  .captcha-error {
    color: #f85149;
  }
}

body.dark-mode .login-container {
  background: linear-gradient(135deg, #0d1117 0%, #161b22 100%) !important;
}
body.dark-mode .login-form {
  background: #161b22 !important;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4) !important;
}
body.dark-mode .login-form h1 {
  color: #f0f6fc !important;
}
body.dark-mode .login-form .theme-toggle {
  background: #21262d !important;
  border-color: #30363d !important;
  color: #f0f6fc !important;
}
body.dark-mode .login-form .theme-toggle:hover {
  background: #30363d !important;
  border-color: #484f58 !important;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3) !important;
}
body.dark-mode .login-form label {
  color: #8b949e !important;
}
body.dark-mode .login-form input {
  background-color: #0d1117 !important;
  border-color: #30363d !important;
  color: #c9d1d9 !important;
}
body.dark-mode .login-form input:focus {
  border-color: #388bfd !important;
  background-color: #161b22 !important;
  box-shadow: 0 0 0 3px rgba(56, 139, 255, 0.3) !important;
}
body.dark-mode .login-form input::placeholder {
  color: #6e7681 !important;
}
body.dark-mode .login-form button {
  background: #238636 !important;
  color: #ffffff !important;
}
body.dark-mode .login-form button:hover:not(:disabled) {
  background: #2ea043 !important;
  box-shadow: 0 5px 15px rgba(46, 160, 67, 0.4) !important;
}
body.dark-mode .login-form button:disabled {
  background-color: #21262d !important;
  color: #6e7681 !important;
}
body.dark-mode .login-form .register-link {
  color: #8b949e !important;
}
body.dark-mode .login-form .register-link a {
  color: #388bfd !important;
}
body.dark-mode .login-form .register-link a:hover {
  color: #58a6ff !important;
}
body.dark-mode .login-form .login-message.error {
  background-color: rgba(248, 81, 73, 0.15) !important;
  color: #f85149 !important;
  border-color: rgba(248, 81, 73, 0.4) !important;
}
body.dark-mode .login-form .login-message.success {
  background-color: rgba(46, 160, 67, 0.15) !important;
  color: #3fb950 !important;
  border-color: rgba(46, 160, 67, 0.4) !important;
}
body.dark-mode .login-form .login-notice {
  background-color: rgba(210, 153, 34, 0.15) !important;
  color: #d29922 !important;
  border-color: rgba(210, 153, 34, 0.4) !important;
}
body.dark-mode .login-container .decoration,
body.dark-mode .login-container .decoration-1 {
  background: rgba(56, 139, 253, 0.15) !important;
}
body.dark-mode .login-container .decoration-2 {
  background: rgba(88, 166, 255, 0.12) !important;
}
body.dark-mode .login-container .decoration-3 {
  background: rgba(56, 139, 253, 0.1) !important;
}
body.dark-mode .login-container .captcha-modal {
  background: #161b22 !important;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6) !important;
  border: 1px solid #30363d !important;
}
body.dark-mode .login-container .captcha-modal-header {
  color: #f0f6fc !important;
}
body.dark-mode .login-container .captcha-close-btn {
  color: #8b949e !important;
}
body.dark-mode .login-container .captcha-close-btn:hover {
  color: #f0f6fc !important;
}
body.dark-mode .login-container .captcha-error {
 color: #f85149 !important;
}

/* 人机验证进度显示 */
.login-content {
 display: flex;
 align-items: center;
 justify-content: center;
 gap: 20px;
 min-height: 100vh;
 padding: 40px 20px;
 box-sizing: border-box;
}

.captcha-progress-row {
 display: flex;
 align-items: center;
 gap: 14px;
 margin: 16px 0;
 padding: 12px 18px;
 background: linear-gradient(135deg, #f0f7ff 0%, #e8f4fd 100%);
 border: 1px solid rgba(59, 130, 246, 0.12);
 border-radius: 10px;
 box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
}

.captcha-progress-ring {
 position: relative;
 width: 36px;
 height: 36px;
 flex-shrink: 0;
}

.progress-svg {
 width: 100%;
 height: 100%;
 transform: rotate(-90deg);
}

.progress-bg {
 fill: none;
 stroke: rgba(59, 130, 246, 0.12);
 stroke-width: 6;
}

.progress-bar {
 fill: none;
 stroke-width: 6;
 stroke-linecap: round;
 stroke-dasharray: 283;
 stroke-dashoffset: 283;
 transition: stroke-dashoffset 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.captcha-status-text {
 font-size: 13px;
 color: #3b82f6;
 line-height: 1.4;
 font-weight: 500;
 letter-spacing: 0.01em;
}

/* 深色模式下的验证进度样式 */
body.dark-mode .captcha-progress-row {
 background: linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%);
 border-color: rgba(59, 130, 246, 0.2);
 box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

body.dark-mode .progress-bg {
 stroke: rgba(56, 189, 248, 0.12);
}

body.dark-mode .progress-bar {
 stroke: url(#capGradient);
}

body.dark-mode .captcha-status-text {
 color: #38bdf8;
}
</style>
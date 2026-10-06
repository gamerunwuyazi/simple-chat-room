<script setup>
import { ref, onMounted } from 'vue';

const isDarkMode = ref(false);

onMounted(() => {
  isDarkMode.value = document.body.classList.contains('dark-mode');
});

function toggleDarkMode() {
  isDarkMode.value = !isDarkMode.value;
  document.body.classList.toggle('dark-mode', isDarkMode.value);
  try {
    localStorage.setItem('dark-mode', isDarkMode.value ? '1' : '0');
  } catch {}
}

function handleSettingItemClick(settingId) {
  // 派发事件
  window.dispatchEvent(new CustomEvent('settings-item-click', {
    detail: { setting: settingId }
  }));
}
</script>

<template>
  <div id="secondary-sidebar">
    <div class="secondary-content" data-content="user-settings">
        <div class="sidebar-section">
            <h3>账户设置</h3>
            <ul class="settings-list">
                <li class="settings-item" data-setting-id="change-password" @click="handleSettingItemClick('change-password')">修改密码</li>
                <li class="settings-item" data-setting-id="change-nickname" @click="handleSettingItemClick('change-nickname')">修改昵称</li>
                <li class="settings-item" data-setting-id="change-gender" @click="handleSettingItemClick('change-gender')">性别设置</li>
                <li class="settings-item" data-setting-id="change-signature" @click="handleSettingItemClick('change-signature')">个性签名</li>
                <li class="settings-item" data-setting-id="upload-avatar" @click="handleSettingItemClick('upload-avatar')">上传头像</li>
            </ul>
        </div>
        
        <div class="sidebar-section">
            <h3>聊天设置</h3>
            <ul class="settings-list">
                <li class="settings-item" data-setting-id="dark-mode" @click="toggleDarkMode">
                    深色模式
                    <span class="setting-value">{{ isDarkMode ? '开' : '关' }}</span>
                </li>
                <li class="settings-item" data-setting-id="friend-verification" @click="handleSettingItemClick('friend-verification')">
                    好友验证
                </li>
                <li class="settings-item" data-setting-id="shortcut-settings" @click="handleSettingItemClick('shortcut-settings')">快捷键</li>
                <li class="settings-item" data-setting-id="clear-unread-counts" @click="handleSettingItemClick('clear-unread-counts')">清除未读计数</li>
            </ul>
        </div>
        
        <div class="sidebar-section">
            <h3>关于</h3>
            <ul class="settings-list">
                <li class="settings-item" data-setting-id="version-info" @click="handleSettingItemClick('version-info')">版本信息</li>
                <li class="settings-item" data-setting-id="help-center" @click="handleSettingItemClick('help-center')">帮助中心</li>
            </ul>
        </div>
    </div>
  </div>
</template>

<style scoped>
.settings-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-item .unread-count {
  font-size: 11px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin-left: 8px;
}
</style>

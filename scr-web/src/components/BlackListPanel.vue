<template>
  <div class="blacklist-panel" data-content="blacklist">
    <div class="blacklist-header">
      <h2>黑名单</h2>
    </div>

    <div class="blacklist-body">
      <div v-if="blockedUsers.length === 0" class="empty-blacklist">
        <p>暂无拉黑用户</p>
      </div>
      <div v-else class="blacklist-list">
        <div v-for="user in blockedUsers" :key="user.id" class="block-item">
          <div class="block-user-info">
            <img v-if="user.avatarUrl" :src="SERVER_URL + user.avatarUrl" alt="头像" class="block-avatar">
            <div v-else class="block-avatar-placeholder">{{ (user.nickname || user.username || 'U').charAt(0).toUpperCase() }}</div>
            <div class="block-details">
              <div class="block-nickname">{{ user.nickname || user.username }}</div>
              <div class="block-username">@{{ user.username || '未知' }}</div>
            </div>
          </div>
          <div class="block-actions">
            <button class="unblock-btn" @click="handleUnblock(user.id)">取消拉黑</button>
          </div>
        </div>
      </div>

      <div v-if="message" :class="'form-message ' + messageClass" style="margin-top: 15px;">
        {{ message }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { getBlockList } from '@/api/user.js';
import { useBaseStore } from '@/stores/baseStore';
import request from '@/utils/request.js';

const baseStore = useBaseStore();
const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

const blockedUsers = ref([]);
const message = ref('');
const messageClass = ref('');

async function loadBlockList() {
  try {
    const res = await getBlockList();
    blockedUsers.value = res.data?.users || [];
  } catch (err) {
    console.error('获取黑名单失败:', err);
  }
}

async function handleUnblock(targetUserId) {
  message.value = '';
  try {
    const res = await request.post('/api/user/unblock-user', { targetUserId });
    message.value = res.data?.message || '已取消拉黑';
    messageClass.value = 'success';
    await loadBlockList();
  } catch (err) {
    console.error('取消拉黑失败:', err);
    message.value = err.response?.data?.message || err.message || '取消拉黑失败';
    messageClass.value = 'error';
  }
}

onMounted(() => {
  loadBlockList();
});
</script>

<style scoped>
.blacklist-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: #f5f6f8;
  overflow: hidden;
}

.blacklist-panel .blacklist-header {
  padding: 16px 20px;
  background-color: #ffffff;
  border-bottom: 1px solid #e2e8f0;
}

.blacklist-panel .blacklist-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
}

.blacklist-panel .blacklist-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.blacklist-panel .empty-blacklist {
  text-align: center;
  padding: 30px;
  color: #999;
  background: #f8f9fa;
  border-radius: 8px;
}

.blacklist-panel .blacklist-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.blacklist-panel .block-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  transition: all 0.2s;
}

.blacklist-panel .block-item:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  border-color: #2196F3;
}

.blacklist-panel .block-user-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.blacklist-panel .block-avatar {
  width: 45px;
  height: 45px;
  border-radius: 50%;
  object-fit: cover;
}

.blacklist-panel .block-avatar-placeholder {
  width: 45px;
  height: 45px;
  border-radius: 50%;
  background-color: #3498db;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 18px;
}

.blacklist-panel .block-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.blacklist-panel .block-nickname {
  font-size: 15px;
  font-weight: 500;
  color: #333;
}

.blacklist-panel .block-username {
  font-size: 13px;
  color: #999;
}

.blacklist-panel .block-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.blacklist-panel .unblock-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 5px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
  background: #ff9800;
  color: white;
}

.blacklist-panel .unblock-btn:hover {
  background: #f57c00;
}

body.dark-mode .blacklist-panel {
  background-color: #0d1117;
}

body.dark-mode .blacklist-panel .blacklist-header {
  background-color: #161b22;
  border-bottom-color: #30363d;
}

body.dark-mode .blacklist-panel .blacklist-header h2 {
  color: #e6edf3;
}

body.dark-mode .blacklist-panel .block-item {
  background: #161b22 !important;
  border-color: #30363d !important;
  color: #c9d1d9 !important;
}

body.dark-mode .blacklist-panel .block-nickname {
  color: #e6edf3;
}

body.dark-mode .blacklist-panel .block-username {
  color: #8b949e;
}

body.dark-mode .blacklist-panel .empty-blacklist {
  background: #161b22;
  color: #8b949e;
}
</style>
<template>
  <div class="friend-requests-panel" data-content="friend-requests">
    <div v-if="showHeader" class="friend-requests-header">
      <h2>新的朋友</h2>
    </div>

    <div class="friend-requests-body">
      <div class="requests-section">
        <h3>收到的好友申请（等待我接受）</h3>
        <div v-if="receivedFriendRequests.length === 0" class="empty-requests">
          <p>暂无收到的好友申请</p>
        </div>
        <div v-else class="requests-list">
          <div v-for="request in receivedFriendRequests" :key="request.id" class="request-item">
            <div class="request-user-info">
              <img v-if="request.avatar_url" :src="SERVER_URL + request.avatar_url" alt="头像" class="request-avatar">
              <div v-else class="request-avatar-placeholder">{{ request.nickname?.charAt(0)?.toUpperCase() || 'U' }}</div>
              <div class="request-details">
                <div class="request-nickname">{{ request.nickname || request.username }}<span class="request-time"> · {{ formatTime(request.created_at) }}</span></div>
                <div class="request-message" :title="request.request_message">{{ request.request_message || '未设置留言' }}</div>
              </div>
            </div>
            <div class="request-actions">
              <button class="accept-btn" @click="handleAcceptFriendRequest(request.id)">接受</button>
              <button class="reject-btn" @click="handleRejectFriendRequest(request.id)">拒绝</button>
            </div>
          </div>
        </div>
      </div>

      <div class="requests-section" style="margin-top: 30px;">
        <h3>发送的好友申请（等待对方接受）</h3>
        <div v-if="sentFriendRequests.length === 0" class="empty-requests">
          <p>暂无发送的好友申请</p>
        </div>
        <div v-else class="requests-list">
          <div v-for="request in sentFriendRequests" :key="request.id" class="request-item pending">
            <div class="request-user-info">
              <img v-if="request.avatar_url" :src="SERVER_URL + request.avatar_url" alt="头像" class="request-avatar">
              <div v-else class="request-avatar-placeholder">{{ request.nickname?.charAt(0)?.toUpperCase() || 'U' }}</div>
              <div class="request-details">
                <div class="request-nickname">{{ request.nickname || request.username }}</div>
                <div class="request-time">等待对方接受 · {{ formatTime(request.created_at) }}</div>
              </div>
            </div>
            <div class="request-actions">
              <button class="cancel-btn-small" @click="handleCancelFriendRequest(request.id)">撤销</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="friendRequestMessage" :class="'form-message ' + friendRequestMessageClass" style="margin-top: 15px;">
        {{ friendRequestMessage }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

import { useBaseStore } from '@/stores/baseStore';
import { acceptFriendRequest, rejectFriendRequest, cancelFriendRequest } from '@/api/user.js';

defineProps({
  // 是否显示顶部标题栏（私信右侧面板默认不显示独立标题，交由外层头部控制）
  showHeader: {
    type: Boolean,
    default: false
  }
});

const baseStore = useBaseStore();
const SERVER_URL = import.meta.env.VITE_SERVER_URL || '';

const friendRequestMessage = ref('');
const friendRequestMessageClass = ref('');

const receivedFriendRequests = computed(() => baseStore.receivedFriendRequests || []);
const sentFriendRequests = computed(() => baseStore.sentFriendRequests || []);

// 确保每次进入面板都拉取最新申请数据
onMounted(() => {
  baseStore.loadFriendRequests();
});

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;

  return date.toLocaleDateString('zh-CN');
}

async function handleAcceptFriendRequest(requesterId) {
  friendRequestMessage.value = '';
  try {
    await acceptFriendRequest(requesterId);
    friendRequestMessage.value = '已接受好友请求';
    friendRequestMessageClass.value = 'success';
    await baseStore.loadFriendRequests();
  } catch (error) {
    console.error('接受好友请求失败:', error);
    friendRequestMessage.value = error.response?.data?.message || error.message || '接受好友请求失败';
    friendRequestMessageClass.value = 'error';
  }
}

async function handleRejectFriendRequest(requesterId) {
  friendRequestMessage.value = '';
  try {
    await rejectFriendRequest(requesterId);
    friendRequestMessage.value = '已拒绝好友请求';
    friendRequestMessageClass.value = 'success';
    await baseStore.loadFriendRequests();
  } catch (error) {
    console.error('拒绝好友请求失败:', error);
    friendRequestMessage.value = error.response?.data?.message || error.message || '拒绝好友请求失败';
    friendRequestMessageClass.value = 'error';
  }
}

async function handleCancelFriendRequest(friendId) {
  friendRequestMessage.value = '';
  try {
    await cancelFriendRequest(friendId);
    friendRequestMessage.value = '已撤销好友请求';
    friendRequestMessageClass.value = 'success';
    await baseStore.loadFriendRequests();
  } catch (error) {
    console.error('撤销好友请求失败:', error);
    friendRequestMessage.value = error.response?.data?.message || error.message || '撤销好友请求失败';
    friendRequestMessageClass.value = 'error';
  }
}
</script>

<style scoped>
.friend-requests-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background-color: #f5f6f8;
  overflow: hidden;
}

.friend-requests-panel .friend-requests-header {
  padding: 16px 20px;
  background-color: #ffffff;
  border-bottom: 1px solid #e2e8f0;
}

.friend-requests-panel .friend-requests-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1e293b;
}

.friend-requests-panel .friend-requests-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.friend-requests-panel .requests-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 15px;
  color: #333;
}

.friend-requests-panel .empty-requests {
  text-align: center;
  padding: 30px;
  color: #999;
  background: #f8f9fa;
  border-radius: 8px;
}

.friend-requests-panel .requests-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.friend-requests-panel :deep(.request-item) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  background: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  transition: all 0.2s;
}

.friend-requests-panel :deep(.request-item.pending) {
  background: #fff;
  border: 1px solid #e0e0e0;
}

body.dark-mode .friend-requests-panel :deep(.request-item) {
  background: #161b22 !important;
  border-color: #30363d !important;
  color: #c9d1d9 !important;
}

body.dark-mode .friend-requests-panel :deep(.request-item.pending) {
  background: #161b22 !important;
  border-color: #30363d !important;
  color: #c9d1d9 !important;
}

.friend-requests-panel :deep(.request-item:hover) {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  border-color: #2196F3;
}

.friend-requests-panel :deep(.request-user-info) {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.friend-requests-panel :deep(.request-avatar) {
  width: 45px;
  height: 45px;
  border-radius: 50%;
  object-fit: cover;
}

.friend-requests-panel :deep(.request-avatar-placeholder) {
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

.friend-requests-panel :deep(.request-details) {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.friend-requests-panel :deep(.request-nickname) {
  font-size: 15px;
  font-weight: 500;
  color: #333;
}

body.dark-mode .friend-requests-panel :deep(.request-nickname) {
  color: #e6edf3;
}

.friend-requests-panel :deep(.request-message) {
  font-size: 13px;
  color: #999;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

body.dark-mode .friend-requests-panel :deep(.request-message) {
  color: #8b949e;
}

.friend-requests-panel :deep(.request-time) {
  font-size: 13px;
  color: #999;
}

body.dark-mode .friend-requests-panel :deep(.request-time) {
  color: #8b949e;
}

.friend-requests-panel :deep(.request-actions) {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.friend-requests-panel :deep(.accept-btn),
.friend-requests-panel :deep(.reject-btn) {
  padding: 6px 16px;
  border: none;
  border-radius: 5px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}

.friend-requests-panel :deep(.accept-btn) {
  background: #4CAF50;
  color: white;
}

.friend-requests-panel :deep(.accept-btn:hover) {
  background: #45a049;
}

.friend-requests-panel :deep(.reject-btn) {
  background: #f44336;
  color: white;
}

.friend-requests-panel :deep(.reject-btn:hover) {
  background: #da190b;
}

.friend-requests-panel :deep(.cancel-btn-small) {
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

.friend-requests-panel :deep(.cancel-btn-small:hover) {
  background: #f57c00;
}

body.dark-mode .friend-requests-panel {
  background-color: #0d1117;
}

body.dark-mode .friend-requests-panel .friend-requests-header {
  background-color: #161b22;
  border-bottom-color: #30363d;
}

body.dark-mode .friend-requests-panel .friend-requests-header h2 {
  color: #e6edf3;
}

body.dark-mode .friend-requests-panel .requests-section h3 {
  color: #e6edf3;
}

body.dark-mode .friend-requests-panel .empty-requests {
  background: #161b22;
  color: #8b949e;
}
</style>
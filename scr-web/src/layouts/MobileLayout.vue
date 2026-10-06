<template>
  <div id="mobile-app">
    <!-- 用户列表左抽屉 -->
    <div id="mobile-user-drawer" :class="{ open: showUserDrawer }">
      <div class="mobile-drawer-overlay" @click="showUserDrawer = false"></div>
      <div class="mobile-drawer-panel">
        <div class="mobile-drawer-header">
          <h3>用户列表</h3>
          <button class="mobile-drawer-close" @click="showUserDrawer = false">✕</button>
        </div>
        <div class="mobile-drawer-body">
          <div class="mobile-drawer-section">
            <h4>在线用户 ({{ userStore.onlineUsers.length }})</h4>
            <div class="mobile-user-list">
              <div v-if="userStore.onlineUsers.length === 0" class="mobile-empty-hint">暂无在线用户</div>
              <div v-else v-for="user in userStore.onlineUsers" :key="user.id" class="mobile-user-item" @click="handleUserClick(user)">
                <span class="mobile-user-avatar">
                  <img v-if="getAvatarUrl(user) && !isSvgAvatar(getAvatarUrl(user))" :src="`${baseStore.SERVER_URL}${getAvatarUrl(user)}`" :alt="user.nickname" @error="handleAvatarError($event, user)">
                  <span v-else class="mobile-user-avatar-text">{{ (user.nickname || 'U').charAt(0).toUpperCase() }}</span>
                </span>
                <span class="mobile-user-name">{{ getUserDisplayName(user) }}</span>
                <span class="mobile-user-dot online"></span>
              </div>
            </div>
          </div>
          <div class="mobile-drawer-section">
            <h4>离线用户</h4>
            <div class="mobile-user-list">
              <div v-if="userStore.offlineUsers.length === 0" class="mobile-empty-hint">暂无离线用户</div>
              <div v-else v-for="user in userStore.offlineUsers" :key="user.id" class="mobile-user-item" @click="handleUserClick(user)">
                <span class="mobile-user-avatar">
                  <img v-if="getAvatarUrl(user) && !isSvgAvatar(getAvatarUrl(user))" :src="`${baseStore.SERVER_URL}${getAvatarUrl(user)}`" :alt="user.nickname" @error="handleAvatarError($event, user)">
                  <span v-else class="mobile-user-avatar-text">{{ (user.nickname || 'U').charAt(0).toUpperCase() }}</span>
                </span>
                <span class="mobile-user-name">{{ user.nickname }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 主内容区域 -->
    <div id="mobile-content">
      <!-- 会话列表（默认显示） -->
      <div id="mobile-conversations" :class="{ hidden: isInChat }">
        <router-view name="sidebar"></router-view>
      </div>

      <!-- 聊天覆盖层 -->
      <div id="mobile-chat" :class="{ visible: isInChat }">
        <div class="mobile-chat-header">
          <button class="mobile-back-btn" @click="goBack">← 返回</button>
          <span class="mobile-chat-title">{{ chatTitle }}</span>
          <button v-if="isPublicChat" class="mobile-user-list-btn" @click="showUserDrawer = true">用户</button>
          <button v-else-if="currentTab === 'group'" class="mobile-header-action" @click="triggerGroupInfo">信息</button>
          <button v-else-if="currentTab === 'private'" class="mobile-header-action" @click="triggerPrivateUserInfo">资料</button>
          <span v-else class="mobile-chat-spacer"></span>
        </div>
        <div class="mobile-chat-view">
          <router-view></router-view>
        </div>
      </div>
    </div>

    <!-- 底部导航栏 -->
    <div id="mobile-tab-bar">
      <div class="mobile-tab" :class="{ active: currentTab === 'public' }" @click="switchTab('public')">
        <span class="mobile-tab-icon"><i class="fas fa-comments tab-icon-img"></i></span>
        <span class="mobile-tab-label">公共</span>
        <span v-if="totalUnread" class="mobile-tab-badge">{{ totalUnread > 99 ? '99+' : totalUnread }}</span>
      </div>
      <div class="mobile-tab" :class="{ active: currentTab === 'group' }" @click="switchTab('group')">
        <span class="mobile-tab-icon"><i class="fas fa-user-group tab-icon-img"></i></span>
        <span class="mobile-tab-label">群组</span>
      </div>
      <div class="mobile-tab" :class="{ active: currentTab === 'private' }" @click="switchTab('private')">
        <span class="mobile-tab-icon"><i class="fas fa-user tab-icon-img"></i></span>
        <span class="mobile-tab-label">私信</span>
        <span v-if="friendRequestUnread" class="mobile-tab-badge">{{ friendRequestUnread > 99 ? '99+' : friendRequestUnread }}</span>
      </div>
      <div class="mobile-tab" :class="{ active: currentTab === 'settings' }" @click="switchTab('settings')">
        <span class="mobile-tab-icon"><i class="fas fa-gear tab-icon-img"></i></span>
        <span class="mobile-tab-label">设置</span>
      </div>
    </div>

    <!-- 弹窗 -->
    <ChatModal />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import ChatModal from '@/components/ChatModal.vue';
import { openUserAvatarPopup } from '@/stores/index.js';
import { useBaseStore } from '@/stores/baseStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUnreadStore } from '@/stores/unreadStore';
import { useUserStore } from '@/stores/userStore';

const baseStore = useBaseStore();
const userStore = useUserStore();
const sessionStore = useSessionStore();
const unreadStore = useUnreadStore();
const router = useRouter();
const route = useRoute();

const showUserDrawer = ref(false);
const showSettingsDetail = ref(false);

// 监听设置项点击事件
function handleSettingsItemClick() {
  showSettingsDetail.value = true;
}

onMounted(() => {
  window.addEventListener('settings-item-click', handleSettingsItemClick);
});

onUnmounted(() => {
  window.removeEventListener('settings-item-click', handleSettingsItemClick);
});

// 当前激活的底部标签
const currentTab = computed(() => {
  const path = route.path;
  if (path === '/chat' || path === '/chat/') return 'public';
  if (path.startsWith('/chat/group')) return 'group';
  if (path.startsWith('/chat/private')) return 'private';
  if (path.startsWith('/chat/settings')) return 'settings';
  return 'public';
});

// 是否在聊天中（公共聊天始终显示，群聊/私聊/设置需选中具体会话）
const isInChat = computed(() => {
  if (currentTab.value === 'public') return true;
  if (currentTab.value === 'group') return !!sessionStore.currentGroupId;
  if (currentTab.value === 'private') return !!sessionStore.currentPrivateChatUserId;
  if (currentTab.value === 'settings') return showSettingsDetail.value;
  return false;
});

// 是否为公共聊天
const isPublicChat = computed(() => currentTab.value === 'public');

// 聊天标题
const chatTitle = computed(() => {
  if (currentTab.value === 'group' && sessionStore.currentGroupId) {
    return sessionStore.currentGroupName || '群组聊天';
  }
  if (currentTab.value === 'private' && sessionStore.currentPrivateChatUserId) {
    return sessionStore.currentPrivateChatNickname || sessionStore.currentPrivateChatUsername || '私聊';
  }
  if (currentTab.value === 'settings') {
    return '设置';
  }
  return '聊天';
});

// 未读计数
const publicUnread = computed(() => unreadStore.unreadMessages?.global || 0);

const groupUnread = computed(() => {
  if (!unreadStore.unreadMessages?.groups) return 0;
  let mutedGroups = [];
  try { mutedGroups = JSON.parse(localStorage.getItem('mutedGroups') || '[]'); } catch { mutedGroups = []; }
  let total = 0;
  for (const gid in unreadStore.unreadMessages.groups) {
    if (!mutedGroups.includes(gid)) total += unreadStore.unreadMessages.groups[gid] || 0;
  }
  return total;
});

const privateUnread = computed(() => {
  if (!unreadStore.unreadMessages?.private) return 0;
  let muted = [];
  try { muted = JSON.parse(localStorage.getItem('mutedPrivateChats') || '[]'); } catch { muted = []; }
  let total = 0;
  for (const uid in unreadStore.unreadMessages.private) {
    if (!muted.includes(uid)) total += unreadStore.unreadMessages.private[uid] || 0;
  }
  return total;
});

// 好友申请数：私信 tab 角标（不计入标题未读）
const friendRequestUnread = computed(() => {
  return Array.isArray(baseStore.receivedFriendRequests) ? baseStore.receivedFriendRequests.length : 0;
});

// 公共 tab 角标 = 主聊天室 + 群组 + 私信所有未读总和
const totalUnread = computed(() => {
  return publicUnread.value + groupUnread.value + privateUnread.value;
});

// 工具函数
function getAvatarUrl(user) {
  let url = user.avatarUrl || user.avatar_url || user.avatar || '';
  return typeof url === 'string' ? url.trim() : '';
}

function isSvgAvatar(url) {
  return url && /\.svg$/i.test(url);
}

function getUserDisplayName(user) {
  const isCurrentUser = baseStore.currentUser && String(baseStore.currentUser.id) === String(user.id);
  return isCurrentUser ? `${user.nickname} (我)` : user.nickname;
}

function handleAvatarError(event, user) {
  user.avatarUrl = '';
  user.avatar_url = '';
  user.avatar = '';
}

function handleUserClick(user) {
  showUserDrawer.value = false;
  openUserAvatarPopup({ target: document.body }, user);
}

// 切换标签
function switchTab(tab) {
  showUserDrawer.value = false;
  showSettingsDetail.value = false;
  const paths = {
    public: '/chat',
    group: '/chat/group',
    private: '/chat/private',
    settings: '/chat/settings'
  };
  if (paths[tab] && paths[tab] !== route.path) {
    router.push(paths[tab]);
  }
}

// 返回会话列表
function goBack() {
  if (currentTab.value === 'group') {
    sessionStore.setCurrentGroupId(null);
  } else if (currentTab.value === 'private') {
    sessionStore.setCurrentPrivateChatUserId(null);
  } else if (currentTab.value === 'settings') {
    showSettingsDetail.value = false;
    window.dispatchEvent(new CustomEvent('settings-back'));
  }
}

// 触发群组信息弹窗
function triggerGroupInfo() {
  document.getElementById('groupInfoButton')?.click();
}

// 触发私信用户资料弹窗
function triggerPrivateUserInfo() {
  document.getElementById('privateUserInfoButton')?.click();
}
</script>
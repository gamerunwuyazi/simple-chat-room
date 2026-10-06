<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';

import { useBaseStore } from '@/stores/baseStore';
import { useUnreadStore } from '@/stores/unreadStore';
import { logout } from '@/utils/chat/ui';
import modal from '@/utils/modal';

const baseStore = useBaseStore();
const unreadStore = useUnreadStore();
const SERVER_URL = baseStore.SERVER_URL || import.meta.env.VITE_SERVER_URL || '';

const router = useRouter();
const route = useRoute();

const avatarVersion = ref(Date.now())
const avatarLoadFailed = ref(false);

function handleUserAvatarUpdate() {
  avatarVersion.value = Date.now()
  avatarLoadFailed.value = false;
}

onMounted(() => {
  window.addEventListener('user-avatar-updated', handleUserAvatarUpdate)
});

onUnmounted(() => {
  window.removeEventListener('user-avatar-updated', handleUserAvatarUpdate)
});

const activeMenuItem = computed(() => {
  const path = route.path;
  if (path === '/chat' || path === '/') {
    return 'public-chat';
  } else if (path.startsWith('/chat/group')) {
    return 'group-chat';
  } else if (path.startsWith('/chat/private')) {
    return 'private-chat';
  } else if (path.startsWith('/chat/settings')) {
    return 'user-settings';
  } else {
    return 'public-chat';
  }
});

const publicUnreadCount = computed(() => {
  return unreadStore.unreadMessages?.global || 0;
});

const groupUnreadCount = computed(() => {
  if (!unreadStore.unreadMessages?.groups) return 0;
  
  let mutedGroups = [];
  try {
    mutedGroups = JSON.parse(localStorage.getItem('mutedGroups') || '[]');
  } catch {
    mutedGroups = [];
  }
  
  let total = 0;
  for (const groupId in unreadStore.unreadMessages.groups) {
    if (!mutedGroups.includes(groupId)) {
      total += unreadStore.unreadMessages.groups[groupId] || 0;
    }
  }
  return total;
});

const privateUnreadCount = computed(() => {
  if (!unreadStore.unreadMessages?.private) return 0;
  
  let mutedPrivateChats = [];
  try {
    mutedPrivateChats = JSON.parse(localStorage.getItem('mutedPrivateChats') || '[]');
  } catch {
    mutedPrivateChats = [];
  }
  
  let total = 0;
  for (const userId in unreadStore.unreadMessages.private) {
    if (!mutedPrivateChats.includes(userId)) {
      total += unreadStore.unreadMessages.private[userId] || 0;
    }
  }
  return total;
});

// 好友申请数：私聊图标角标（不计入标题未读，标题只统计 unreadMessages）
const friendRequestUnreadCount = computed(() => {
  return Array.isArray(baseStore.receivedFriendRequests) ? baseStore.receivedFriendRequests.length : 0;
});

// 主聊天图标角标 = 主聊天室 + 群组 + 私信所有未读总和
const totalUnreadCount = computed(() => {
  return publicUnreadCount.value + groupUnreadCount.value + privateUnreadCount.value;
});

const currentUser = computed(() => {
  avatarVersion.value;
  
  if (baseStore.currentUser && baseStore.currentUser.nickname) {
    return {
      id: baseStore.currentUser.id,
      nickname: baseStore.currentUser.nickname,
      gender: baseStore.currentUser.gender,
      avatarUrl: baseStore.currentUser.avatar_url
    };
  }
  
  return null;
});

const userAvatarUrl = computed(() => {
  if (avatarLoadFailed.value) return '';
  
  const user = currentUser.value;
  if (!user) return '';
  
  let url = user.avatar || user.avatarUrl || '';
  if (url && !/\.svg$/i.test(url)) {
    const baseUrl = url.startsWith('http') ? '' : SERVER_URL;
    return `${baseUrl}${url}?v=${avatarVersion.value}`;
  }
  return '';
});

const userInitials = computed(() => {
  const user = currentUser.value;
  const nickname = user?.nickname || '';
  return nickname ? nickname.charAt(0).toUpperCase() : 'U';
});

const showAvatarImage = computed(() => {
  return userAvatarUrl.value !== '' && !avatarLoadFailed.value;
});

function handleAvatarError() {
  avatarLoadFailed.value = true;
}

async function handleMenuClick(section) {
  if (section === 'logout') {
    const confirmed = await modal.confirm('确定要退出登录吗？', '退出登录');
    if (confirmed) {
      logout();
    }
    return;
  }

  let path = '';
  if (section === 'public-chat') {
    // 不重置面板类型：恢复上次打开的面板（chatPanelType 持久保存在 sessionStore 中）
    path = '/chat';
  } else if (section === 'group-chat') {
    path = '/chat/group';
  } else if (section === 'private-chat') {
    path = '/chat/private';
  } else if (section === 'user-settings') {
    path = '/chat/settings';
  }
  
  if (path) {
    router.push(path);
  }
}
</script>

<template>
  <div id="sidebar">
    <div class="sidebar-header">
        <div id="userProfile" class="user-profile">
            <div id="userAvatar" class="user-avatar">
                <template v-if="currentUser">
                    <img v-if="showAvatarImage" :src="userAvatarUrl" alt="用户头像" class="user-avatar-img" loading="lazy" width="60" height="60" style="aspect-ratio: 1/1; object-fit: cover;" @error="handleAvatarError">
                    <span v-else id="userInitials" class="user-initials">{{ userInitials }}</span>
                </template>

            </div>
        </div>
    </div>
    
    <div class="menu-section">
        <ul class="menu-list">
            <li :class="['menu-item', { active: activeMenuItem === 'public-chat' }]" data-section="public-chat" @click="handleMenuClick('public-chat')">
                <div class="chat-avatar"><i class="fas fa-comments"></i></div>
                <span class="menu-label">消息</span>
                <div v-if="totalUnreadCount > 0" class="unread-count">{{ totalUnreadCount }}</div>
            </li>
        </ul>
    </div>

    <div class="menu-section">
        <ul class="menu-list">
            <li :class="['menu-item', { active: activeMenuItem === 'group-chat' }]" data-section="group-chat" @click="handleMenuClick('group-chat')">
                <div class="chat-avatar"><i class="fas fa-user-group"></i></div>
                <span class="menu-label">群聊</span>
            </li>
        </ul>
    </div>

    <div class="menu-section">
        <ul class="menu-list">
            <li :class="['menu-item', { active: activeMenuItem === 'private-chat' }]" data-section="private-chat" @click="handleMenuClick('private-chat')">
                <div class="chat-avatar"><i class="fas fa-user" style="font-size: 22px;"></i></div>
                <span class="menu-label">私聊</span>
                <div v-if="friendRequestUnreadCount > 0" class="unread-count">{{ friendRequestUnreadCount > 99 ? '99+' : friendRequestUnreadCount }}</div>
            </li>
        </ul>
    </div>

    <div class="menu-section">
        <ul class="menu-list">
            <li :class="['menu-item', { active: activeMenuItem === 'user-settings' }]" data-section="user-settings" @click="handleMenuClick('user-settings')">
                <div class="chat-avatar">
                    <i class="fas fa-gear"></i>
                </div>
                <span class="menu-label">设置</span>
            </li>
        </ul>
    </div>

    <div class="menu-section" style="margin-top: auto; margin-bottom: 20px;">
        <ul class="menu-list">
            <li class="menu-item" data-section="logout" @click="handleMenuClick('logout')">
                <div class="chat-avatar">
                    <i class="fas fa-power-off"></i>
                </div>
                <span class="menu-label">退出登录</span>
            </li>
        </ul>
    </div>
</div>
</template>

<style scoped>
/* 图标下方加行小字：菜单项改为纵向排列 */
.menu-item {
  flex-direction: column;
  gap: 2px;
  height: auto;
  padding: 8px 0;
}

.menu-label {
  font-size: 11px;
  line-height: 1.2;
  color: #64748b;
  user-select: none;
  white-space: nowrap;
}

.menu-item:hover .menu-label {
  color: #1e293b;
}

.menu-item.active .menu-label {
  color: white;
}

.chat-avatar {
  position: relative;
}

.chat-avatar i {
  font-size: 22px;
  color: #475569;
  transition: all 0.3s ease;
}

.menu-item.active .chat-avatar i {
  color: white;
}

.menu-item:hover .chat-avatar i {
  color: #1e293b;
}

.menu-item.active:hover .chat-avatar i {
  color: white;
}

.chat-avatar .unread-count {
  position: absolute;
  top: -5px;
  right: -5px;
  font-size: 10px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
}
</style>

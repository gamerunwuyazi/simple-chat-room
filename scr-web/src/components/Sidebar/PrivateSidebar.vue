<script setup>
/* eslint-disable vue/multi-word-component-names */
import { ref, computed, onUnmounted } from 'vue';

import { setFriendDisturb } from '@/api/friend.js';
import { usePagedList, searchSorter } from '@/composables/usePagedList';
import { useBaseStore } from '@/stores/baseStore';
import { useUserStore } from '@/stores/userStore';
import { useFriendStore } from '@/stores/friendStore';
import { useUnreadStore } from '@/stores/unreadStore';
import { useDraftStore } from '@/stores/draftStore';
import { useModalStore } from '@/stores/modalStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useStorageStore } from '@/stores/storageStore';
import { switchToPrivateChat } from '@/utils/chat/private';

const baseStore = useBaseStore();
const userStore = useUserStore();
const friendStore = useFriendStore();
const unreadStore = useUnreadStore();
const draftStore = useDraftStore();
const modalStore = useModalStore();
const sessionStore = useSessionStore();
const storageStore = useStorageStore();

onUnmounted(() => {
  document.removeEventListener('click', hideContextMenu);
  document.removeEventListener('contextmenu', hideContextMenu);
  window.removeEventListener('scroll', hideContextMenu, true);
});

// 私信搜索状态
const privateChatSearchKeyword = ref('');

// 侧边栏根节点即滚动容器（overflow-y: auto），供分页滚动监听与位置恢复使用
const sidebarRef = ref(null);

// 右键菜单相关
const showContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const currentContextMenuFriend = ref(null);

// 检查私信是否被免打扰（使用store中的is_disturb）
function isPrivateMuted(userId) {
  const friend = friendStore.friendsList.find(f => String(f.id) === String(userId));
  return friend ? friend.is_disturb == 1 : false;
}

async function togglePrivateMute(userId) {
  const friend = friendStore.friendsList.find(f => String(f.id) === String(userId));
  if (!friend) return;

  const newIsDisturb = !(friend.is_disturb == 1);

  try {
    const res = await setFriendDisturb(userId, newIsDisturb);
    const data = res.data;
    friend.is_disturb = data.is_disturb;
    if (newIsDisturb) {
      unreadStore.clearPrivateUnread(userId);
    }
  } catch (err) {
    console.error('设置好友免打扰请求失败:', err);
    const errorMessage = err.response?.data?.message || err.message || '设置好友免打扰失败';
    console.error('设置好友免打扰失败:', errorMessage);
  }
  
  hideContextMenu();
}

async function deleteDeletedFriend(friendId) {
  hideContextMenu();
  
  try {
    await storageStore.deleteSingleDeletedSession('private', friendId);
  } catch (error) {
    console.error('删除已删除好友会话失败:', error);
  }
}



// 工具函数：获取用户头像 URL（带版本号参数）
function getAvatarUrl(user) {
  let avatarUrl = '';
  if (user.avatarUrl && typeof user.avatarUrl === 'string') {
    avatarUrl = user.avatarUrl.trim();
  } else if (user.avatar_url && typeof user.avatar_url === 'string') {
    avatarUrl = user.avatar_url.trim();
  } else if (user.avatar && typeof user.avatar === 'string') {
    avatarUrl = user.avatar.trim();
  }
  
  // 如果有版本号，添加?v=参数
  if (avatarUrl && user.avatarVersion) {
    return `${avatarUrl}?v=${user.avatarVersion}`;
  }
  
  return avatarUrl;
}

// 工具函数：检查是否为SVG格式
function isSvgAvatar(url) {
  return url && /\.svg$/i.test(url);
}

// 工具函数：获取好友显示名称（优先备注，其次昵称）
function getFriendDisplayName(friend) {
  if (friend.remark && friend.remark.trim()) {
    return friend.remark.trim();
  }
  return friend.nickname || friend.username || '未知用户';
}

function tryGetRecallNickname(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.id && parsed.nickname && typeof parsed.nickname === 'object') {
        const keys = Object.keys(parsed.nickname);
        if (keys.length > 0) return parsed.nickname[keys[0]];
      }
      const keys = Object.keys(parsed).filter(k => k !== 'id');
      if (keys.length === 1 && typeof parsed[keys[0]] === 'string') {
        return parsed[keys[0]];
      }
    }
  } catch (e) {}
  return null;
}

function getPrivateLastMessage(friend) {
  if (draftStore.drafts && draftStore.drafts.private && draftStore.drafts.private[friend.id]) {
    const draftContent = draftStore.drafts.private[friend.id];
    if (draftContent) {
      return `[草稿] ${draftContent}`;
    }
  }
  
  const lastMessage = friend.lastMessage || storageStore.getPrivateLastMessage(friend.id);
  if (!lastMessage) return '';

  const recallNickname = tryGetRecallNickname(lastMessage.content);
  if (lastMessage.messageType === 101 || lastMessage.isRecalled) {
    if (recallNickname) {
      return `${recallNickname}撤回了一条消息`;
    }
    return '撤回了一条消息';
  }

  return storageStore.formatMessageContent(lastMessage);
}

function hasDraft(friend) {
  return draftStore.drafts && draftStore.drafts.private && draftStore.drafts.private[friend.id];
}

function isUserOnline(userId) {
  return userStore.onlineUsers.some(user => String(user.id) === String(userId));
}

// 搜索不受分页影响：始终对完整好友列表过滤；
// 搜索结果排序按匹配率 + 最后消息时间（匹配率相同按最近活跃从近到远）
const filteredFriendsList = computed(() => {
  const allFriends = [...friendStore.friendsList];
  if (!privateChatSearchKeyword.value) {
    return allFriends;
  }
  const keyword = privateChatSearchKeyword.value.toLowerCase();
  const filtered = allFriends.filter(friend => {
    const displayName = getFriendDisplayName(friend).toLowerCase();
    return displayName.includes(keyword) || (friend.username || '').toLowerCase().includes(keyword);
  });
  return filtered.sort(searchSorter(privateChatSearchKeyword.value, friend => getFriendDisplayName(friend)));
});

// 分页：只渲染前 20 条，滚动到底再追加后 10 条；搜索变化时重置回顶部
const { pagedList: pagedFriendsList } = usePagedList(filteredFriendsList, {
  containerRef: sidebarRef,
  resetTrigger: privateChatSearchKeyword
});

// 清除搜索
function clearPrivateChatSearch() {
  privateChatSearchKeyword.value = '';
}

// 收到待处理的好友申请数（"新的朋友"置顶项角标）
const friendRequestCount = computed(() => (
  Array.isArray(baseStore.receivedFriendRequests) ? baseStore.receivedFriendRequests.length : 0
));

// 点击置顶"新的朋友"：取消选中好友，右侧面板切换到好友申请列表
function handleNewFriendsClick() {
  hideContextMenu();
  sessionStore.setCurrentPrivateChatUserId(null);
  sessionStore.showFriendRequests = true;
}

// 处理好友点击
function handleFriendClick(friend) {
  hideContextMenu();
  sessionStore.showFriendRequests = false;
  const avatarUrl = friend.avatarUrl || friend.avatar_url || friend.avatar || '';
  switchToPrivateChat(friend.id, friend.nickname, friend.username, avatarUrl);
}

// 处理好友右键点击
function handleFriendRightClick(event, friend) {
  event.preventDefault();
  event.stopPropagation();
  
  hideContextMenu();
  
  currentContextMenuFriend.value = friend;
  contextMenuPosition.value = {
    x: event.clientX,
    y: event.clientY
  };
  showContextMenu.value = true;
  
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('contextmenu', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);
  }, 0);
}

// 隐藏右键菜单
function hideContextMenu() {
  showContextMenu.value = false;
  currentContextMenuFriend.value = null;
  
  document.removeEventListener('click', hideContextMenu);
  document.removeEventListener('contextmenu', hideContextMenu);
  window.removeEventListener('scroll', hideContextMenu, true);
}

function handleUserAvatarClick(event, user) {
  event.stopPropagation();
  const avatarUrl = getAvatarUrl(user);
  if (avatarUrl && !isSvgAvatar(avatarUrl)) {
    const fullAvatarUrl = avatarUrl.startsWith('http') ? avatarUrl : `${baseStore.SERVER_URL}${avatarUrl}`;
    modalStore.openModal('avatarPreview', fullAvatarUrl);
  }
}

function handleAvatarError(event, friend) {
  friend.avatarUrl = '';
  friend.avatar_url = '';
  friend.avatar = '';
}

function handleSearchUserClick() {
  modalStore.openModal('userSearch');
}
</script>

<template>
  <div id="secondary-sidebar" ref="sidebarRef">
    <div class="secondary-content" data-content="private-chat">
        <div class="sidebar-section">
            <div class="section-header">
                <div class="search-container">
                    <input type="text" id="privateChatSearchInput" placeholder="搜索好友..." class="search-input" v-model="privateChatSearchKeyword">
                    <button id="clearPrivateChatSearch" class="clear-search-btn" v-if="privateChatSearchKeyword" @click="clearPrivateChatSearch">×</button>
                    <button id="searchUserButton" class="create-group-btn" title="搜索用户" @click="handleSearchUserClick">+</button>
                </div>
            </div>
            <ul class="user-list" id="friendsList">
                <!-- 新的朋友：置顶，不参与分页排序，始终显示（好友申请入口） -->
                <li class="friend-item new-friends-item"
                    :class="{ active: sessionStore.showFriendRequests }"
                    @click="handleNewFriendsClick">
                    <span class="user-avatar-wrapper">
                        <span class="user-avatar"><i class="fas fa-user-plus"></i></span>
                    </span>
                    <div class="friend-info">
                        <span class="friend-name">新的朋友</span>
                        <span class="friend-last-message">{{ friendRequestCount > 0 ? '你有新的好友申请' : '没有新的好友申请' }}</span>
                    </div>
                    <div v-if="friendRequestCount > 0" class="unread-count private-unread-count">{{ friendRequestCount > 99 ? '99+' : friendRequestCount }}</div>
                </li>

                <!-- 分割线：分隔置顶"新的朋友"与普通好友列表 -->
                <li class="chat-list-divider"></li>

                <li v-if="friendStore.friendsList.length === 0" class="empty-friends">暂无好友，请先添加好友</li>
                <li v-else v-for="friend in pagedFriendsList" :key="friend.id" 
                    class="friend-item"
                    :data-user-id="friend.id"
                    :data-user-nickname="friend.nickname"
                    :class="{ 'deleted-item': friend.deleted_at }"
                    @click="handleFriendClick(friend)"
                    @contextmenu.prevent="handleFriendRightClick($event, friend)">
                    <span class="user-avatar-wrapper">
                        <span v-if="getAvatarUrl(friend) && !isSvgAvatar(getAvatarUrl(friend))" class="user-avatar">
                            <img :src="`${baseStore.SERVER_URL}${getAvatarUrl(friend)}`" :alt="getFriendDisplayName(friend)" @error="handleAvatarError($event, friend)">
                            <span v-if="friend.deleted_at" class="deleted-icon"><i class="fas fa-trash-alt"></i></span>
                        </span>
                        <span v-else class="user-avatar">
                            {{ getFriendDisplayName(friend).charAt(0).toUpperCase() }}
                            <span v-if="friend.deleted_at" class="deleted-icon"><i class="fas fa-trash-alt"></i></span>
                        </span>
                        <span v-if="isUserOnline(friend.id) && !friend.deleted_at" class="online-indicator"></span>
                    </span>
                    <div class="friend-info">
                        <span class="friend-name" :style="friend.deleted_at ? { color: '#000' } : {}">{{ getFriendDisplayName(friend) }} <span v-if="friend.deleted_at" style="font-size: 12px;">(已删除)</span></span>
                        <span v-if="hasDraft(friend) && !friend.deleted_at" class="friend-last-message draft-text">{{ getPrivateLastMessage(friend) }}</span>
                        <span v-else-if="friend.deleted_at" class="friend-last-message" style="color: #000;">该会话已被删除</span>
                        <span v-else class="friend-last-message">{{ getPrivateLastMessage(friend) }}</span>
                    </div>
                    <span v-if="isPrivateMuted(friend.id) && !friend.deleted_at" class="mute-icon" style="margin-left: 5px; font-size: 12px;" title="已免打扰"><i class="fas fa-bell-slash"></i></span>
                    <div class="unread-count private-unread-count" v-if="unreadStore.unreadMessages.private && unreadStore.unreadMessages.private[friend.id] && !isPrivateMuted(friend.id)">
                        {{ unreadStore.unreadMessages.private[friend.id] }}
                    </div>
                </li>
            </ul>
        </div>
    </div>

    <!-- 右键菜单 -->
    <div v-if="showContextMenu" class="context-menu" 
         :style="{ left: contextMenuPosition.x + 'px', top: contextMenuPosition.y + 'px' }"
         @click.stop>
        <div v-if="currentContextMenuFriend.deleted_at" class="context-menu-item delete-action" @click="deleteDeletedFriend(currentContextMenuFriend.id)" style="color: #e74c3c;">
            删除会话记录
        </div>
        <div v-else class="context-menu-item" @click="togglePrivateMute(currentContextMenuFriend.id)" style="color: black;">
            {{ isPrivateMuted(currentContextMenuFriend.id) ? '取消免打扰' : '免打扰' }}
        </div>
    </div>
  </div>
</template>

<style scoped>
.context-menu {
    position: fixed;
    z-index: 10000;
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    padding: 5px 0;
}

.context-menu-item {
    padding: 8px 15px;
    cursor: pointer;
    font-size: 14px;
    white-space: nowrap;
    transition: background-color 0.2s;
}

:global(body.dark-mode) .context-menu {
    background: #161b22;
    border-color: #30363d;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}

:global(body.dark-mode) .context-menu-item {
    color: #c9d1d9 !important;
}

.context-menu-item:hover {
    background-color: #f5f5f5;
}

:global(body.dark-mode) .context-menu-item:hover {
    background-color: #21262d;
}

.user-avatar-wrapper {
  position: relative;
  display: inline-flex;
}

.deleted-item {
  opacity: 0.6;
  background-color: #fef2f2 !important;
  border-left: 3px solid #ef4444;
}

.deleted-item:hover {
  background-color: #fee2e2 !important;
}

.deleted-item .user-avatar {
  filter: grayscale(100%);
  position: relative;
}

.deleted-icon {
  position: absolute;
  bottom: -2px;
  right: -2px;
  background: #ffffff;
  border-radius: 50%;
  font-size: 10px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  color: #ef4444;
}

.online-indicator {
  position: absolute;
  right: -2px;
  bottom: 0;
  width: 8px;
  height: 8px;
  background: #22c55e;
  border-radius: 50%;
  border: 2px solid #f5f6f8;
  z-index: 1;
}

.friend-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.friend-name {
  font-weight: 500;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #1e293b;
}

.friend-last-message {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

/* 置顶"新的朋友"项：突出显示，选中态高亮 */
.user-list .new-friends-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-list .new-friends-item .user-avatar {
  color: #fff;
  font-size: 14px;
}

.user-list .new-friends-item.active {
  background-color: #e3f0fc;
}

/* 置顶"新的朋友"与普通好友之间的分割线 */
.user-list .chat-list-divider {
  height: 0;
  padding: 0;
  margin: 4px 0 8px 0;
  border: none;
  border-top: 1px solid #cbd5e1;
  cursor: default;
  pointer-events: none;
}

.user-list .chat-list-divider:hover {
  background-color: transparent;
  transform: none;
}

body.dark-mode .user-list .new-friends-item .user-avatar {
  color: #fff;
}

body.dark-mode .user-list .new-friends-item.active {
  background-color: #2c3e50;
}

.draft-text {
  color: #ff0000 !important;
  font-weight: 500;
}
</style>

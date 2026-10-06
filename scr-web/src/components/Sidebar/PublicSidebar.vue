<script setup>
/* eslint-disable vue/multi-word-component-names */
import { ref, computed, onMounted, onUnmounted } from 'vue';

import { usePagedList, searchSorter } from '@/composables/usePagedList';
import { useBaseStore } from '@/stores/baseStore';
import { useDraftStore } from '@/stores/draftStore';
import { useFriendStore } from '@/stores/friendStore';
import { useGroupStore } from '@/stores/groupStore';
import { openUserAvatarPopup } from '@/stores/index.js';
import { useInputStore } from '@/stores/inputStore';
import { usePublicStore } from '@/stores/publicStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useStorageStore } from '@/stores/storageStore';
import { useUnreadStore } from '@/stores/unreadStore';
import { useUserStore } from '@/stores/userStore';
import { switchToGroupChat } from '@/utils/chat/group';
import { switchToPrivateChat } from '@/utils/chat/private';
import { setActiveChatDirect, updateUnreadCountsDisplay } from '@/utils/chat/ui';

const baseStore = useBaseStore();
const userStore = useUserStore();
const friendStore = useFriendStore();
const groupStore = useGroupStore();
const publicStore = usePublicStore();
const unreadStore = useUnreadStore();
const draftStore = useDraftStore();
const sessionStore = useSessionStore();
const inputStore = useInputStore();
const storageStore = useStorageStore();

const searchKeyword = ref('');

// 侧边栏根节点即滚动容器（overflow-y: auto），供分页滚动监听与位置恢复使用
const sidebarRef = ref(null);

// ===== 在线用户气泡 =====

const showOnlinePanel = ref(false);
const onlineBtnRef = ref(null);
const onlineBubbleRef = ref(null);

const onlineCount = computed(() => (userStore.onlineUsers || []).length);

function toggleOnlinePanel() {
  showOnlinePanel.value = !showOnlinePanel.value;
}

function handleOnlineUserClick(event, user) {
  openUserAvatarPopup(event, user);
}

// 点击按钮和气泡之外时关闭气泡
function handleDocumentClick(event) {
  if (!showOnlinePanel.value) return;
  const btn = onlineBtnRef.value;
  const bubble = onlineBubbleRef.value;
  if (btn && btn.contains(event.target)) return;
  if (bubble && bubble.contains(event.target)) return;
  showOnlinePanel.value = false;
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick);
});

// ===== 通用工具 =====

function isSvgAvatar(url) {
  return url && /\.svg$/i.test(url);
}

// 在线用户头像（广播事件只带 avatarUrl）
function getUserAvatarUrl(user) {
  if (user.avatarUrl && typeof user.avatarUrl === 'string') {
    return user.avatarUrl.trim();
  }
  if (user.avatar_url && typeof user.avatar_url === 'string') {
    return user.avatar_url.trim();
  }
  if (user.avatar && typeof user.avatar === 'string') {
    return user.avatar.trim();
  }
  return '';
}

function getFriendAvatarUrl(friend) {
  let avatarUrl = '';
  if (friend.avatarUrl && typeof friend.avatarUrl === 'string') {
    avatarUrl = friend.avatarUrl.trim();
  } else if (friend.avatar_url && typeof friend.avatar_url === 'string') {
    avatarUrl = friend.avatar_url.trim();
  } else if (friend.avatar && typeof friend.avatar === 'string') {
    avatarUrl = friend.avatar.trim();
  }
  if (avatarUrl && friend.avatarVersion) {
    return `${avatarUrl}?v=${friend.avatarVersion}`;
  }
  return avatarUrl;
}

function getGroupAvatarUrl(group) {
  let avatarUrl = '';
  if (group.avatarUrl && typeof group.avatarUrl === 'string') {
    avatarUrl = group.avatarUrl.trim();
  } else if (group.avatar_url && typeof group.avatar_url === 'string') {
    avatarUrl = group.avatar_url.trim();
  } else if (group.avatar && typeof group.avatar === 'string') {
    avatarUrl = group.avatar.trim();
  }
  if (avatarUrl && group.avatarVersion) {
    return `${avatarUrl}?v=${group.avatarVersion}`;
  }
  return avatarUrl;
}

function getFriendDisplayName(friend) {
  if (friend.remark && friend.remark.trim()) {
    return friend.remark.trim();
  }
  return friend.nickname || friend.username || '未知用户';
}

function getGroupDisplayName(group) {
  if (group.user_remark && group.user_remark.trim()) {
    return group.user_remark.trim();
  }
  return group.name || '未知群组';
}

function isUserOnline(userId) {
  return userStore.onlineUsers.some(user => String(user.id) === String(userId));
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
  } catch (e) { /* 不是撤回消息格式，忽略 */ }
  return null;
}

// ===== 最后一条消息 =====

function getPrivateLastMessageText(friend) {
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
    return recallNickname ? `${recallNickname}撤回了一条消息` : '撤回了一条消息';
  }

  return storageStore.formatMessageContent(lastMessage);
}

function getGroupLastMessageText(group) {
  if (draftStore.drafts && draftStore.drafts.groups && draftStore.drafts.groups[group.id]) {
    const draftContent = draftStore.drafts.groups[group.id];
    if (draftContent) {
      return `[草稿] ${draftContent}`;
    }
  }

  if (!group.lastMessage) return '';

  const { content, messageType, groupNickname } = group.lastMessage;

  if (messageType === 100 || messageType === 102) {
    return storageStore.formatMessageContent({ content, messageType });
  }

  if (messageType === 101) {
    const recallNickname = tryGetRecallNickname(content);
    return recallNickname ? `${recallNickname}撤回了一条消息` : '撤回了一条消息';
  }

  const formatted = storageStore.formatMessageContent({ content, messageType });
  return groupNickname ? `${groupNickname}: ${formatted}` : formatted;
}

// 主聊天室最后一条消息（过滤 101 撤回 / 102 用户信息更新 / 103 已读回执）
const mainChatLastMessage = computed(() => {
  const messages = publicStore.publicMessages || [];
  const validMessages = messages.filter(m => m.messageType !== 101 && m.messageType !== 102 && m.messageType !== 103);
  if (validMessages.length === 0) return '';
  return storageStore.formatMessageContent(validMessages[validMessages.length - 1]);
});

const mainUnreadCount = computed(() => {
  return unreadStore.unreadMessages?.global || 0;
});

function isPrivateMuted(userId) {
  const friend = friendStore.friendsList.find(f => String(f.id) === String(userId));
  return friend ? friend.is_disturb == 1 : false;
}

function isGroupMuted(groupId) {
  const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
  return group ? group.is_disturb == 1 : false;
}

function hasGroupAtMe(groupId) {
  return !!(groupStore.hasGroupAtMe && groupStore.hasGroupAtMe(groupId));
}

function getSessionSortTime(session) {
  if (session.session_last_active_time) return new Date(session.session_last_active_time).getTime();
  if (session.last_message_time) return new Date(session.last_message_time).getTime();
  return 0;
}

// ===== 统一聊天列表（私聊 + 群聊合并，按最后活跃时间排序，不区分类型）=====

const chatSessions = computed(() => {
  const sessions = [];

  (friendStore.friendsList || []).forEach(friend => {
    sessions.push({
      kind: 'private',
      id: friend.id,
      nickname: friend.nickname,
      username: friend.username,
      name: getFriendDisplayName(friend),
      avatarUrl: getFriendAvatarUrl(friend),
      lastMessageText: getPrivateLastMessageText(friend),
      hasDraft: !!(draftStore.drafts?.private?.[friend.id]),
      atMe: false,
      unreadCount: isPrivateMuted(friend.id) ? 0 : (unreadStore.unreadMessages?.private?.[friend.id] || 0),
      isMuted: isPrivateMuted(friend.id),
      deleted: !!friend.deleted_at,
      online: isUserOnline(friend.id) && !friend.deleted_at,
      sortTime: getSessionSortTime(friend)
    });
  });

  (groupStore.groupsList || []).forEach(group => {
    sessions.push({
      kind: 'group',
      id: group.id,
      nickname: getGroupDisplayName(group),
      username: '',
      name: getGroupDisplayName(group),
      avatarUrl: getGroupAvatarUrl(group),
      lastMessageText: getGroupLastMessageText(group),
      hasDraft: !!(draftStore.drafts?.groups?.[group.id]),
      atMe: hasGroupAtMe(group.id) && !group.deleted_at,
      unreadCount: isGroupMuted(group.id) ? 0 : (unreadStore.unreadMessages?.groups?.[group.id] || 0),
      isMuted: isGroupMuted(group.id),
      deleted: !!group.deleted_at,
      online: false,
      sortTime: getSessionSortTime(group)
    });
  });

  sessions.sort((a, b) => b.sortTime - a.sortTime);
  return sessions;
});

// 搜索不受分页影响：始终对完整排序列表过滤；
// 搜索结果排序按匹配率 + 最后消息时间（匹配率相同按最近活跃从近到远）
const searchSessions = computed(() => {
  if (!searchKeyword.value) return chatSessions.value;
  const keyword = searchKeyword.value.toLowerCase();
  return chatSessions.value
    .filter(session => session.name.toLowerCase().includes(keyword))
    .sort(searchSorter(searchKeyword.value, session => session.name));
});

// 分页：只渲染前 20 条，滚动到底再追加后 10 条；搜索变化时重置回顶部
const { pagedList: pagedSessions } = usePagedList(searchSessions, {
  containerRef: sidebarRef,
  resetTrigger: searchKeyword
});

function clearSearch() {
  searchKeyword.value = '';
}

function isSessionActive(session) {
  if (sessionStore.chatPanelType === 'private') {
    return String(sessionStore.currentPrivateChatUserId) === String(session.id);
  }
  if (sessionStore.chatPanelType === 'group') {
    return String(sessionStore.currentGroupId) === String(session.id);
  }
  return false;
}

// ===== 面板切换 =====

// 切换前保存当前嵌入面板的输入草稿（切换后原面板 DOM 会被卸载）
function saveCurrentPanelDraft() {
  const panelType = sessionStore.chatPanelType;
  if (panelType === 'main') {
    const mainInput = document.getElementById('messageInput');
    if (mainInput) {
      inputStore.mainMessageInput = mainInput.innerHTML;
    }
  } else if (panelType === 'private') {
    const privateId = sessionStore.currentPrivateChatUserId;
    if (privateId) {
      const privateInput = document.getElementById('privateMessageInput');
      if (privateInput) {
        draftStore.saveDraft('private', privateId, privateInput.textContent || privateInput.innerHTML || '');
      }
      draftStore.setLastMessageToDraft('private', privateId);
    }
  } else if (panelType === 'group') {
    const groupId = sessionStore.currentGroupId;
    if (groupId) {
      const groupInput = document.getElementById('groupMessageInput');
      if (groupInput) {
        draftStore.saveDraft('group', groupId, groupInput.textContent || groupInput.innerHTML || '');
      }
      draftStore.setLastMessageToDraft('group', groupId);
    }
  }
}

// 打开主聊天室（置顶项，不跳转路由）
function openMainChatRoom() {
  saveCurrentPanelDraft();
  sessionStore.setChatPanelType('main');
  setActiveChatDirect('main', null, true);
  updateUnreadCountsDisplay();
}

// 打开私聊/群聊会话（嵌入 /chat 右侧面板，不跳转路由）
async function handleSessionClick(session) {
  saveCurrentPanelDraft();
  if (session.kind === 'private') {
    const ok = switchToPrivateChat(session.id, session.nickname, session.username, session.avatarUrl, { noNavigate: true });
    if (ok) {
      sessionStore.setChatPanelType('private');
    }
  } else {
    const ok = await switchToGroupChat(session.id, session.name, { noNavigate: true });
    if (ok) {
      sessionStore.setChatPanelType('group');
    }
  }
}
</script>

<template>
  <div id="secondary-sidebar" ref="sidebarRef">
    <div class="secondary-content" data-content="chat-list">
        <div class="sidebar-section">
            <div class="section-header">
                <div class="search-container">
                    <input type="text" id="chatListSearchInput" placeholder="搜索聊天..." class="search-input" v-model="searchKeyword">
                    <button id="clearChatListSearch" class="clear-search-btn" v-if="searchKeyword" @click="clearSearch">×</button>
                </div>
                <button ref="onlineBtnRef" id="onlineUsersBtn" class="online-users-btn" :class="{ active: showOnlinePanel }" title="查看在线用户" @click.stop="toggleOnlinePanel">
                    <span class="online-dot"></span>
                    <span class="online-users-btn-text">在线 {{ onlineCount }}</span>
                </button>
                <!-- 在线用户气泡列表 -->
                <div v-if="showOnlinePanel" ref="onlineBubbleRef" id="onlineUsersBubble" class="online-users-bubble" @click.stop>
                    <div class="online-users-bubble-header">在线用户 ({{ onlineCount }})</div>
                    <div class="online-users-bubble-list">
                        <div v-if="onlineCount === 0" class="online-users-empty">暂无在线用户</div>
                        <div v-else v-for="user in userStore.onlineUsers" :key="user.id" class="online-user-item" @click="handleOnlineUserClick($event, user)">
                            <span v-if="getUserAvatarUrl(user) && !isSvgAvatar(getUserAvatarUrl(user))" class="user-avatar">
                                <img :src="`${baseStore.SERVER_URL}${getUserAvatarUrl(user)}`" :alt="user.nickname">
                            </span>
                            <span v-else class="user-avatar">{{ (user.nickname || 'U').charAt(0).toUpperCase() }}</span>
                            <span class="online-user-name">{{ user.nickname || '未知用户' }}</span>
                        </div>
                    </div>
                </div>
            </div>
            <ul class="user-list" id="chatSessionList">
                <!-- 主聊天室：永久置顶，不参与排序 -->
                <li class="chat-session-item pinned-room-item"
                    :class="{ active: sessionStore.chatPanelType === 'main' }"
                    data-session-type="main"
                    @click="openMainChatRoom">
                    <span class="user-avatar-wrapper">
                        <span class="user-avatar">
                            <img src="/favicon.jpg" alt="聊天室">
                        </span>
                    </span>
                    <div class="chat-session-info">
                        <span class="chat-session-name">聊天室</span>
                        <span class="chat-session-last-msg">{{ mainChatLastMessage || '暂无消息' }}</span>
                    </div>
                    <div v-if="mainUnreadCount > 0" class="unread-count chat-unread-badge">{{ mainUnreadCount > 99 ? '99+' : mainUnreadCount }}</div>
                </li>

                <!-- 分割线：分隔置顶主聊天室与普通聊天 -->
                <li class="chat-list-divider"></li>

                <li v-if="searchSessions.length === 0" class="chat-list-empty">暂无聊天会话</li>
                <li v-else v-for="session in pagedSessions"
                    :key="`${session.kind}-${session.id}`"
                    class="chat-session-item"
                    :class="{ 'deleted-item': session.deleted, active: isSessionActive(session) }"
                    :data-session-type="session.kind"
                    :data-session-id="session.id"
                    @click="handleSessionClick(session)">
                    <span class="user-avatar-wrapper">
                        <span v-if="session.avatarUrl && !isSvgAvatar(session.avatarUrl)" class="user-avatar">
                            <img :src="`${baseStore.SERVER_URL}${session.avatarUrl}`" :alt="session.name">
                            <span v-if="session.deleted" class="deleted-icon"><i class="fas fa-trash-alt"></i></span>
                        </span>
                        <span v-else class="user-avatar">
                            {{ session.name.charAt(0).toUpperCase() }}
                            <span v-if="session.deleted" class="deleted-icon"><i class="fas fa-trash-alt"></i></span>
                        </span>
                        <span v-if="session.online" class="online-indicator"></span>
                    </span>
                    <div class="chat-session-info">
                        <span class="chat-session-name">{{ session.name }}<span v-if="session.deleted" class="deleted-label">（已删除）</span></span>
                        <span v-if="session.atMe" class="chat-session-last-msg at-me-text">[有人@我]</span>
                        <span v-else-if="session.deleted" class="chat-session-last-msg deleted-message">该会话已被删除</span>
                        <span v-else-if="session.hasDraft" class="chat-session-last-msg draft-text">{{ session.lastMessageText }}</span>
                        <span v-else class="chat-session-last-msg">{{ session.lastMessageText }}</span>
                    </div>
                    <span v-if="session.isMuted && !session.deleted" class="mute-icon" style="margin-left: 5px; font-size: 12px;" title="已免打扰"><i class="fas fa-bell-slash"></i></span>
                    <div v-if="session.unreadCount > 0" class="unread-count chat-unread-badge">{{ session.unreadCount > 99 ? '99+' : session.unreadCount }}</div>
                </li>
            </ul>
        </div>
    </div>
  </div>
</template>

<style scoped>
/* 在线用户按钮 */
.section-header {
    position: relative;
}

.section-header .search-container {
    flex: 1;
    min-width: 0;
}

/* chat 列表搜索框右侧没有 "+" 按钮，清除按钮需紧贴搜索框最右侧（覆盖全局 .clear-search-btn 的 right: 40px） */
.section-header #clearChatListSearch {
    right: 8px;
}

.online-users-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: 8px;
    /* 与 .search-container 的 margin-top: 10px 对齐，避免按钮相对搜索框上移 */
    margin-top: 10px;
    padding: 5px 10px;
    border: none;
    border-radius: 6px;
    background-color: #e8f5ee;
    color: #16a34a;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.2s, color 0.2s;
}

/* 文字单独成行盒，确保中文与数字同基线对齐 */
.online-users-btn-text {
    line-height: 1.2;
}

.online-users-btn:hover {
    background-color: #d1fae5;
}

.online-users-btn.active {
    background-color: #16a34a;
    color: #ffffff;
}

.online-dot {
    width: 8px;
    height: 8px;
    min-width: 8px;
    border-radius: 50%;
    background-color: currentColor;
}

/* 在线用户气泡 */
.online-users-bubble {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 220px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    overflow: hidden;
    z-index: 100;
}

.online-users-bubble-header {
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    color: #334155;
    border-bottom: 1px solid #e2e8f0;
}

.online-users-bubble-list {
    max-height: 280px;
    overflow-y: auto;
    padding: 6px;
}

.online-user-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.2s;
}

.online-user-item:hover {
    background-color: #f1f5f9;
}

.online-user-item .user-avatar {
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    border-radius: 50%;
    font-size: 12px;
    cursor: pointer;
}

.online-user-name {
    font-size: 13px;
    color: #1e293b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.online-users-empty {
    padding: 16px 12px;
    text-align: center;
    font-size: 13px;
    color: #94a3b8;
}

/* 头像外层容器（与私信列表一致） */
.user-avatar-wrapper {
    position: relative;
    display: inline-flex;
}

/* 默认头像直接复用全局 .user-avatar：24px 圆形、#3498db 蓝底、白色首字母 */
/* li 基础样式（flex/间距/hover 位移）复用全局 .user-list li */
.user-list .chat-session-item {
    position: relative;
}

.user-list .chat-session-item.active {
    background-color: #dbe4ef;
}

.chat-session-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.chat-session-name {
    font-weight: 500;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #1e293b;
}

.chat-session-last-msg {
    font-size: 12px;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
}

/* 未读角标位置（与私信/群组列表一致） */
.user-list .chat-unread-badge {
    position: static;
    margin-left: auto;
    margin-right: 10px;
    font-size: 11px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
}

/* 在线小点（与私信列表一致） */
.user-avatar-wrapper .online-indicator {
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

/* 已删除会话（与私信/群组列表一致） */
.chat-session-item.deleted-item {
    opacity: 0.6;
    background-color: #fef2f2 !important;
    border-left: 3px solid #ef4444;
}

.chat-session-item.deleted-item:hover {
    background-color: #fee2e2 !important;
}

.chat-session-item.deleted-item .user-avatar {
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

/* 置顶主聊天室与普通聊天之间的分割线 */
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

/* 空列表 */
.user-list .chat-list-empty {
    padding: 12px 4px;
    color: #94a3b8;
    font-size: 13px;
    cursor: default;
}

.user-list .chat-list-empty:hover {
    background-color: transparent;
    transform: none;
}

.draft-text {
    color: #ff0000 !important;
    font-weight: 500;
}

.at-me-text {
    color: #ff4757 !important;
    font-weight: 500;
}

:global(body.dark-mode) .user-list .chat-session-item {
    background-color: #21262d;
    color: #c9d1d9;
}

:global(body.dark-mode) .user-list .chat-session-item:hover {
    background-color: #21262d;
    color: #c9d1d9;
}

:global(body.dark-mode) .user-list .chat-session-item.active {
    background-color: #2c3e50;
}

:global(body.dark-mode) .chat-session-name {
    color: #c9d1d9;
}

:global(body.dark-mode) .chat-session-last-msg {
    color: #8b949e;
}

:global(body.dark-mode) .user-avatar-wrapper .online-indicator {
    border-color: #161b22;
}

:global(body.dark-mode) .chat-session-item.deleted-item {
    background-color: #161b22 !important;
}

:global(body.dark-mode) .chat-session-item.deleted-item:hover {
    background-color: #21262d !important;
}

:global(body.dark-mode) .deleted-icon {
    background: #161b22;
    color: #f85149;
}

:global(body.dark-mode) .chat-unread-badge {
    background: #da3633;
}

:global(body.dark-mode) .user-list .chat-list-divider {
    border-top-color: #30363d;
}

:global(body.dark-mode) .user-list .chat-list-empty {
    color: #8b949e;
}

:global(body.dark-mode) .online-users-btn {
    background: #0f2b1a;
    color: #3fb950;
}

:global(body.dark-mode) .online-users-btn:hover {
    background: #14432a;
}

:global(body.dark-mode) .online-users-btn.active {
    background: #238636;
    color: #ffffff;
}

:global(body.dark-mode) .online-users-bubble {
    background: #161b22;
    border-color: #30363d;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

:global(body.dark-mode) .online-users-bubble-header {
    color: #c9d1d9;
    border-bottom-color: #30363d;
}

:global(body.dark-mode) .online-user-item:hover {
    background: #21262d;
}

:global(body.dark-mode) .online-user-name {
    color: #c9d1d9;
}

:global(body.dark-mode) .online-users-empty {
    color: #8b949e;
}
</style>

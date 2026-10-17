import { defineStore } from 'pinia';
import { ref } from 'vue';
import { sendReadMessageEvent, sendClearGroupUnread, sendClearGlobalUnread, updateUnreadCountsDisplay } from '@/utils/chat';
import { useBaseStore } from './baseStore';

export const useUnreadStore = defineStore('unread', () => {
  const unreadMessages = ref({
    global: 0,
    groups: {},
    private: {}
  });

  const hasUnifiedAtMe = ref(false);

  // ============================================
  // 清除未读事件批量队列
  // 前端把所有需要标记的会话（群组 + 主聊天室）放入列表，
  // 每 10 秒轮询一次，有则逐条发送，没有则什么都不发
  // ============================================
  const pendingUnreadClear = ref([]);
  let unreadClearPollTimer = null;

  function enqueueUnreadClear(type, groupId = null) {
    if (type === 'group' && (groupId === null || groupId === undefined)) return;
    const exists = pendingUnreadClear.value.some(item => {
      if (type === 'global') return item.type === 'global';
      return item.type === 'group' && String(item.groupId) === String(groupId);
    });
    if (exists) return;
    if (type === 'group') {
      pendingUnreadClear.value.push({ type: 'group', groupId });
    } else {
      pendingUnreadClear.value.push({ type: 'global' });
    }
  }

  function flushPendingUnreadClear() {
    const queue = pendingUnreadClear.value;
    if (!queue.length) return;
    while (queue.length) {
      const item = queue.shift();
      if (item.type === 'group') {
        sendClearGroupUnread(item.groupId);
      } else if (item.type === 'global') {
        sendClearGlobalUnread();
      }
    }
  }

  function startUnreadClearPolling() {
    if (unreadClearPollTimer) return;
    unreadClearPollTimer = setInterval(flushPendingUnreadClear, 10000);
  }

  function stopUnreadClearPolling() {
    if (unreadClearPollTimer) {
      clearInterval(unreadClearPollTimer);
      unreadClearPollTimer = null;
    }
  }

  function clearGroupUnread(groupId) {
    loadUnreadCountsFromLocalStorage();
    const groupIdStr = String(groupId);
    let hasUnreadToClear = false;
    if (unreadMessages.value.groups && unreadMessages.value.groups[groupIdStr]) {
      delete unreadMessages.value.groups[groupIdStr];
      hasUnreadToClear = true;
    }
    saveUnreadCountsToLocalStorage();
    if (hasUnreadToClear) enqueueUnreadClear('group', groupId);
  }

  function clearPrivateUnread(userId) {
    loadUnreadCountsFromLocalStorage();
    const userIdStr = String(userId);
    let hasUnreadToClear = false;
    if (unreadMessages.value.private && unreadMessages.value.private[userIdStr]) {
      delete unreadMessages.value.private[userIdStr];
      hasUnreadToClear = true;
    }
    saveUnreadCountsToLocalStorage();
    if (hasUnreadToClear && sendReadMessageEvent) sendReadMessageEvent('private', { friendId: userId });
  }

  function clearGlobalUnread() {
    loadUnreadCountsFromLocalStorage();
    let hasUnreadToClear = unreadMessages.value.global > 0;
    unreadMessages.value.global = 0;
    hasUnifiedAtMe.value = false;
    saveUnreadCountsToLocalStorage();
    if (hasUnreadToClear) enqueueUnreadClear('global');
  }

  function incrementGroupUnread(groupId) {
    loadUnreadCountsFromLocalStorage();
    const groupIdStr = String(groupId);
    if (!unreadMessages.value.groups[groupIdStr]) unreadMessages.value.groups[groupIdStr] = 0;
    unreadMessages.value.groups[groupIdStr]++;
    saveUnreadCountsToLocalStorage();
  }

  function incrementGlobalUnread() {
    loadUnreadCountsFromLocalStorage();
    unreadMessages.value.global++;
    saveUnreadCountsToLocalStorage();
  }

  function incrementPrivateUnread(userId) {
    loadUnreadCountsFromLocalStorage();
    const userIdStr = String(userId);
    if (!unreadMessages.value.private[userIdStr]) unreadMessages.value.private[userIdStr] = 0;
    unreadMessages.value.private[userIdStr]++;
    saveUnreadCountsToLocalStorage();
  }

  function loadUnreadCountsFromLocalStorage() {
    const baseStore = useBaseStore();
    try {
      let userId = baseStore.currentUser?.id || null;
      if (!userId) {
        const storedUserId = localStorage.getItem('chatUserId');
        if (storedUserId) userId = storedUserId;
      }
      if (!userId) return;
      const data = localStorage.getItem(`unread_counts_${userId}`);
      if (data) {
        const counts = JSON.parse(data);
        unreadMessages.value.global = counts.global || 0;
        unreadMessages.value.groups = counts.groups || {};
        unreadMessages.value.private = counts.private || {};
      }
    } catch (err) {}
  }

  function loadUnreadCountsFromStorage() {
    const baseStore = useBaseStore();
    try {
      let userId = baseStore.currentUser?.id || null;
      if (!userId) {
        const storedUserId = localStorage.getItem('chatUserId');
        if (storedUserId) userId = storedUserId;
      }
      if (!userId) return { global: 0, groups: {}, private: {} };
      const data = localStorage.getItem(`unread_counts_${userId}`);
      if (data) return JSON.parse(data);
    } catch (err) {}
    return { global: 0, groups: {}, private: {} };
  }

  function saveUnreadCountsToLocalStorage() {
    const baseStore = useBaseStore();
    try {
      let userId = baseStore.currentUser?.id || null;
      if (!userId) {
        const storedUserId = localStorage.getItem('chatUserId');
        if (storedUserId) userId = storedUserId;
      }
      if (!userId) return;
      const counts = { global: unreadMessages.value.global, groups: unreadMessages.value.groups, private: unreadMessages.value.private };
      localStorage.setItem(`unread_counts_${userId}`, JSON.stringify(counts));
    } catch (err) {}
  }

  function saveUnreadCountsToLocalStorageDirect(counts) {
    const baseStore = useBaseStore();
    try {
      let userId = baseStore.currentUser?.id || null;
      if (!userId) {
        const storedUserId = localStorage.getItem('chatUserId');
        if (storedUserId) userId = storedUserId;
      }
      if (!userId) return;
      localStorage.setItem(`unread_counts_${userId}`, JSON.stringify(counts));
      unreadMessages.value.global = counts.global || 0;
      unreadMessages.value.groups = counts.groups || {};
      unreadMessages.value.private = counts.private || {};
    } catch (err) {}
  }

  function clearAllUnreadCounts() {
    loadUnreadCountsFromLocalStorage();
    unreadMessages.value.global = 0;
    unreadMessages.value.groups = {};
    unreadMessages.value.private = {};
    hasUnifiedAtMe.value = false;
    saveUnreadCountsToLocalStorage();
    if (typeof updateUnreadCountsDisplay === 'function') updateUnreadCountsDisplay();
    return true;
  }

  function setUnifiedHasAtMe() {
    hasUnifiedAtMe.value = true;
  }

  function clearUnifiedHasAtMe() {
    hasUnifiedAtMe.value = false;
  }

  return {
    unreadMessages,
    hasUnifiedAtMe,
    pendingUnreadClear,
    clearGroupUnread,
    clearPrivateUnread,
    clearGlobalUnread,
    enqueueUnreadClear,
    startUnreadClearPolling,
    stopUnreadClearPolling,
    incrementGroupUnread,
    incrementGlobalUnread,
    incrementPrivateUnread,
    loadUnreadCountsFromLocalStorage,
    loadUnreadCountsFromStorage,
    saveUnreadCountsToLocalStorage,
    saveUnreadCountsToLocalStorageDirect,
    clearAllUnreadCounts,
    setUnifiedHasAtMe,
    clearUnifiedHasAtMe
  };
});

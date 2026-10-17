import modal from '../modal.js';

import { toast, getModalId, getModalNameFromId } from './config.js';
import { 
  showSendGroupCardModal, 
  sendGroupCard, 
  loadGroupList, 
  updateGroupList, 
  loadGroupMessages, 
  isGroupMuted, 
  toggleGroupMute 
} from './group.js';
import { loadFriendsList, showUserAvatarPopup } from './private.js';
import { navigateTo, getRouter } from './routerInstance.js';
import {
  useBaseStore,
  useUserStore,
  useFriendStore,
  useGroupStore,
  useUnifiedStore,
  useModalStore,
  useSessionStore,
  useStorageStore,
  useUnreadStore,
  useDraftStore,
  useInputStore
} from '@/stores/index.js';
import { 
  initializeWebSocket, 
  enableMessageSending, 
  disconnectWebSocket,
  setPullingMessages,
  waitForSocketConnection,
  processAndClearBuffers
} from './websocket.js';
import { resetAllStores } from '@/stores/plugins/clearStore.js';
import { getSelfInfo, refreshToken as apiRefreshToken } from '@/api/user.js';

let currentGroupId = null;

function logout() {
  if (disconnectWebSocket) {
    disconnectWebSocket();
  }
  
  const baseStore = useBaseStore();
  const storageStore = useStorageStore();
  
  if (baseStore && baseStore.$pinia) {
    resetAllStores(baseStore.$pinia);
  }
  
  if (storageStore && storageStore.clearAllCache) {
    storageStore.clearAllCache();
  }
  
  localStorage.removeItem('currentSessionToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('chatUserId');
  localStorage.removeItem('nickname');
  localStorage.removeItem('sessionToken');
  localStorage.removeItem('chatSessionToken');
  localStorage.removeItem('mutedGroups');
  localStorage.removeItem('mutedPrivateChats');
  
  navigateTo('/login');
}
let currentGroupName = '';
let currentUser = null;
let currentSessionToken = null;
let currentPrivateChatUserId = null;
let currentPrivateChatUsername = null;
let currentPrivateChatNickname = null;
let currentSendChatType = null;
let selectedGroupIdForCard = null;

async function refreshToken() {
    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    
    const refreshTokenValue = localStorage.getItem('refreshToken');
    const userId = baseStore && baseStore.currentUser ? baseStore.currentUser.id : localStorage.getItem('chatUserId');
    
    if (!userId || !refreshTokenValue) {
        return false;
    }
    
    try {
        const res = await apiRefreshToken(userId, refreshTokenValue);
        const data = res.data;
        
        baseStore.setCurrentSessionToken(data.token);
        
        localStorage.setItem('currentSessionToken', data.token);
        localStorage.setItem('refreshToken', data.refreshToken);
        
        currentSessionToken = data.token;

        return true;
    } catch (err) {
        console.error('刷新 Token 请求失败:', err);
        const errorMessage = err.response?.data?.message || err.message || 'Token 刷新失败';
        console.error('Token 刷新失败:', errorMessage);
        return false;
    }
}

function openModal(modalName, data = null) {
  const modalStore = useModalStore();
  if (modalStore && modalStore.openModal) {
    modalStore.openModal(modalName, data);
  } else {
    const modalId = getModalId(modalName);
    if (modalId) {
      const modalEl = document.getElementById(modalId);
      if (modalEl) {
        modalEl.style.display = 'flex';
      }
    }
  }
}

function closeModal(modalName) {
  const modalStore = useModalStore();
  if (modalStore && modalStore.closeModal) {
    modalStore.closeModal(modalName);
  } else {
    const modalId = getModalId(modalName);
    if (modalId) {
      const modalEl = document.getElementById(modalId);
      if (modalEl) {
        modalEl.style.display = 'none';
      }
    } else {
      const modals = document.querySelectorAll('.modal');
      modals.forEach(modalEl => {
        modalEl.style.display = 'none';
      });
    }
  }
}

function updateUnreadCountsDisplay() {
  const unreadStore = useUnreadStore();
  const unreadMessages = unreadStore?.unreadMessages || { global: 0, groups: {}, private: {} };
  
  const unifiedChatUnreadEl = document.getElementById('unifiedChatUnreadCount');
  if (unifiedChatUnreadEl) {
    if (unreadMessages.global > 0) {
      unifiedChatUnreadEl.textContent = unreadMessages.global;
    } else {
      unifiedChatUnreadEl.textContent = '';
    }
  }

  const groupChatUnreadEl = document.getElementById('groupChatUnreadCount');
  if (groupChatUnreadEl) {
    let totalGroupUnread = 0;
    Object.keys(unreadMessages.groups).forEach(groupId => {
      const groupUnread = unreadMessages.groups[groupId] || 0;
      totalGroupUnread += groupUnread;
    });
    if (totalGroupUnread > 0) {
      groupChatUnreadEl.textContent = totalGroupUnread;
    } else {
      groupChatUnreadEl.textContent = '';
    }
  }

  const privateChatUnreadEl = document.getElementById('privateChatUnreadCount');
  if (privateChatUnreadEl) {
    let totalPrivateUnread = 0;
    Object.keys(unreadMessages.private).forEach(userId => {
      const privateUnread = unreadMessages.private[userId] || 0;
      totalPrivateUnread += privateUnread;
    });
    if (totalPrivateUnread > 0) {
      privateChatUnreadEl.textContent = totalPrivateUnread;
    } else {
      privateChatUnreadEl.textContent = '';
    }
  }

  if (unreadStore) {
    unreadStore.unreadMessages = { ...unreadMessages };
  }
}

function initializeFocusListeners() {
  document.addEventListener('visibilitychange', handlePageVisibilityChange);
  window.addEventListener('focus', handleFocusChange);
  window.addEventListener('blur', handleFocusChange);
  window.addEventListener('pageshow', handlePageShow);
  document.addEventListener('mousemove', onPrivateChatAreaMousemove, { passive: true });
  document.addEventListener('click', onPrivateChatAreaClick, true);
}

// 私信：仅当鼠标在右侧聊天区域(#chat-main)内移动/点击的那一刻，
// 才发送已读并清除前端未读计数（收到私信时一律累加计数，见 websocket.js）
// 触发条件直接发送并清除，不进入列表轮询
function handlePrivateChatAreaInteraction() {
  const router = getRouter();
  const currentPath = router?.currentRoute?.value?.path || window.location.pathname || '';
  const sessionStore = useSessionStore();

  // 支持两种位置的私信：独立私信页 /chat/private，
  // 以及消息页 /chat 右侧嵌入的私信面板（chatPanelType === 'private'）
  const isMainRoute = currentPath === '/chat' || currentPath === '/chat/' ||
    (currentPath.startsWith('/chat') && !currentPath.startsWith('/chat/group') && !currentPath.startsWith('/chat/private'));
  const isPrivateActive = currentPath.startsWith('/chat/private') ||
    (isMainRoute && sessionStore?.chatPanelType === 'private');
  if (!isPrivateActive) return;

  const partnerId = sessionStore?.currentPrivateChatUserId;
  if (!partnerId) return;

  const unreadStore = useUnreadStore();
  const hasUnread = Number(unreadStore?.unreadMessages?.private?.[String(partnerId)] || 0) > 0;
  if (!hasUnread) return;

  // clearPrivateUnread 内部会发送已读并清除计数
  if (unreadStore && unreadStore.clearPrivateUnread) {
    unreadStore.clearPrivateUnread(partnerId);
  }
  updateUnreadCountsDisplay();
}

function onPrivateChatAreaMousemove(e) {
  if (!e.target || !e.target.closest || !e.target.closest('#chat-main')) return;
  handlePrivateChatAreaInteraction();
}

function onPrivateChatAreaClick(e) {
  if (!e.target || !e.target.closest || !e.target.closest('#chat-main')) return;
  handlePrivateChatAreaInteraction();
}

function handlePageShow() {
  setTimeout(() => {
    tryClearUnreadForCurrentRoute();
  }, 300);
}

// 根据当前路由和 sessionStore 清除对应会话的未读计数（不使用内存中的 activePage 变量）
// 注意：路由 /chat/group 和 /chat/private 不带 ID 参数，会话 ID 存储在 sessionStore 中
function tryClearUnreadForCurrentRoute() {
  const unreadStore = useUnreadStore();
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();

  if (!baseStore.currentUser?.id) return false;

  const router = getRouter();
  const currentPath = router?.currentRoute?.value?.path || window.location.pathname || '';
  const isGroupRoute = currentPath.startsWith('/chat/group');
  const isPrivateRoute = currentPath.startsWith('/chat/private');
  const isMainChatRoute = currentPath === '/chat' || currentPath === '/chat/' ||
    (currentPath.startsWith('/chat') && !currentPath.startsWith('/chat/group') && !currentPath.startsWith('/chat/private'));

  if (isMainChatRoute) {
    if (unreadStore && unreadStore.clearGlobalUnread) {
      unreadStore.clearGlobalUnread();
      updateUnreadCountsDisplay();
    }
    // 消息页 /chat 右侧嵌入面板：对齐对应独立页面的聚焦清除行为
    const panelType = sessionStore && sessionStore.chatPanelType;
    if (panelType === 'group' && sessionStore.currentGroupId) {
      // 同 /chat/group 页面：聚焦时清群未读 + 清@标记
      if (unreadStore && unreadStore.clearGroupUnread) {
        unreadStore.clearGroupUnread(sessionStore.currentGroupId);
        updateUnreadCountsDisplay();
      }
      const groupStore = useGroupStore();
      if (groupStore && groupStore.clearGroupHasAtMe) {
        groupStore.clearGroupHasAtMe(sessionStore.currentGroupId);
      }
      return true;
    }
    if (panelType === 'private') {
      // 同 /chat/private 页面：聚焦不清除，只在鼠标于 #chat-main 移动/点击时清除
      // （见 handlePrivateChatAreaInteraction）
      return false;
    }
    return true;
  } else if (isGroupRoute && sessionStore && sessionStore.currentGroupId) {
    if (unreadStore && unreadStore.clearGroupUnread) {
      unreadStore.clearGroupUnread(sessionStore.currentGroupId);
      updateUnreadCountsDisplay();
    }
    // 页面切回且群组已聚焦时，清除被@标记
    const groupStore = useGroupStore();
    if (groupStore && groupStore.clearGroupHasAtMe) {
      groupStore.clearGroupHasAtMe(sessionStore.currentGroupId);
    }
    return true;
  } else if (isPrivateRoute && sessionStore && sessionStore.currentPrivateChatUserId) {
    // 私信：聚焦/页面切回不自动清除未读、不发送已读
    // 只有鼠标在 #chat-main 内移动/点击时才触发（见 handlePrivateChatAreaInteraction）
    return false;
  }

  return false;
}

function handlePageVisibilityChange() {
  if (!document.hidden) {
    tryClearUnreadForCurrentRoute();
  }
}

function handleFocusChange() {
  if (document.hasFocus()) {
    tryClearUnreadForCurrentRoute();
  }
}

function setActiveChat(chatType, id = null, clearUnread = false) {
  const sessionStore = useSessionStore();
  const draftStore = useDraftStore();
  const unreadStore = useUnreadStore();
  
  let oldChatType = null;
  let oldChatId = null;

  // 从sessionStore获取当前会话信息（优先使用具体的ID字段）
  if (sessionStore) {
    if (sessionStore.currentPrivateChatUserId) {
      oldChatType = 'private';
      oldChatId = sessionStore.currentPrivateChatUserId;
    } else if (sessionStore.currentGroupId) {
      oldChatType = 'group';
      oldChatId = sessionStore.currentGroupId;
    } else {
      oldChatType = 'main';
    }
  }
  
  // 保存旧会话草稿：只从仍在 DOM 中的对应输入框读取（可确认内容属于该会话）；
  // 输入框不存在时不读写草稿——inputStore 的输入内容是全局单槽，回退读取会把
  // 其他会话的残留内容误存到当前会话草稿
  if (draftStore && oldChatType && (oldChatId || oldChatType === 'main') && draftStore.saveDraft) {
    let draftContent = null;
    if (oldChatType === 'main') {
      const el = document.getElementById('messageInput');
      // 草稿仅用于侧边栏列表显示，存纯文本
      if (el) draftContent = el.textContent;
    } else if (oldChatType === 'group') {
      const el = document.getElementById('groupMessageInput');
      if (el) draftContent = el.innerHTML;
    } else if (oldChatType === 'private') {
      const el = document.getElementById('privateMessageInput');
      if (el) draftContent = el.innerHTML;
    }
    if (draftContent !== null) {
      draftStore.saveDraft(oldChatType, oldChatId, draftContent);
    }
  }
  
  if (chatType === 'main') {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat('main');
    }
    if (clearUnread && unreadStore && unreadStore.clearGlobalUnread) {
      unreadStore.clearGlobalUnread();
    }
  } else if (chatType === 'group' && id) {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat(`group_${id}`);
    }
    if (clearUnread && unreadStore && unreadStore.clearGroupUnread) {
      unreadStore.clearGroupUnread(id);
    }
  } else if (chatType === 'private' && id) {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat(`private_${id}`);
    }
    if (clearUnread && unreadStore && unreadStore.clearPrivateUnread) {
      unreadStore.clearPrivateUnread(id);
    }
  }
}

function setActiveChatDirect(chatType, id = null, clearUnread = false) {
  const sessionStore = useSessionStore();
  const unreadStore = useUnreadStore();
  
  if (chatType === 'main') {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat('main');
    }
    if (clearUnread && unreadStore && unreadStore.clearGlobalUnread) {
      unreadStore.clearGlobalUnread();
    }
  } else if (chatType === 'group' && id) {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat(`group_${id}`);
    }
    if (clearUnread && unreadStore && unreadStore.clearGroupUnread) {
      unreadStore.clearGroupUnread(id);
    }
  } else if (chatType === 'private' && id) {
    if (sessionStore) {
      sessionStore.setCurrentActiveChat(`private_${id}`);
    }
    if (clearUnread && unreadStore && unreadStore.clearPrivateUnread) {
      unreadStore.clearPrivateUnread(id);
    }
  }
}

async function initializeChat() {
        const sessionStore = useSessionStore();
        const storageStore = useStorageStore();
        const baseStore = useBaseStore();
        
        if (baseStore && baseStore.currentUser && baseStore && baseStore.currentSessionToken) {
            currentUser = baseStore.currentUser;
            currentSessionToken = baseStore.currentSessionToken;
            
            try {
                const res = await getSelfInfo();
                const data = res.data;
                if (data.user) {
                    currentUser = {
                        id: data.user.id,
                        username: data.user.username,
                        nickname: data.user.nickname,
                        gender: data.user.gender,
                        signature: data.user.signature,
                        avatar_url: data.user.avatar_url,
                        friend_verification: data.user.friend_verification
                    };
                    if (baseStore) {
                        baseStore.setCurrentUser(currentUser);
                    }
                }
            } catch (error) {
                console.error('获取用户信息失败:', error);
            }
        }
        else if (!currentUser || !currentSessionToken) {
            let userId = localStorage.getItem('chatUserId') || 
                        localStorage.getItem('userId') ||
                        localStorage.getItem('currentUserId');
            let sessionToken = localStorage.getItem('currentSessionToken');

            if (userId && sessionToken) {
                currentUser = {
                    id: userId
                };
                currentSessionToken = sessionToken;
                
                if (baseStore) {
                    baseStore.setCurrentUser(currentUser);
                    baseStore.setCurrentSessionToken(sessionToken);
                }
                
                try {
                    const response = await getSelfInfo();
                    const data = response.data;
                    if (data.user) {
                        currentUser = {
                            id: data.user.id,
                            username: data.user.username,
                            nickname: data.user.nickname,
                            gender: data.user.gender,
                            signature: data.user.signature,
                            avatar_url: data.user.avatar_url,
                            friend_verification: data.user.friend_verification
                        };
                        if (baseStore) {
                            baseStore.setCurrentUser(currentUser);
                        }
                    }
                } catch (error) {
                    console.error('获取用户信息失败:', error);
                }
            } else {
                console.warn('⚠️ 未找到用户信息，初始化聊天失败');
                return;
            }
        }
        try {
          // 1. 先连接 WebSocket
          if (typeof initializeWebSocket === 'function') initializeWebSocket(); else console.warn('初始化 WebSocket 失败');
          
          // 2. 等待 WebSocket 连接完成（此时已发送 user-joined）
          if (typeof waitForSocketConnection === 'function') await waitForSocketConnection(); else console.warn('等待 WebSocket 连接失败');
          
          if (typeof enableMessageSending === 'function') enableMessageSending(); else console.warn('启用消息发送失败');
          if (typeof initializeFocusListeners === 'function') initializeFocusListeners(); else console.warn('初始化焦点监听失败');
          
          // 3. 设置拉取消息标志，期间 WS 收到的消息进入缓冲队列
          if (typeof setPullingMessages === 'function') setPullingMessages(true);
          
          // 4. 拉取好友列表、群组列表和消息
          if (typeof loadFriendsList === 'function') loadFriendsList(); else console.warn('加载好友列表失败');
          if (typeof loadGroupList === 'function') loadGroupList(); else console.warn('加载群组列表失败');
          
          if (storageStore && typeof storageStore.initializeMessages === 'function') {
            await storageStore.initializeMessages(); 
          } else {
            console.warn('拉取消息失败');
          }
          
          // 5. 处理拉取期间缓冲的 WS 消息（内部会关闭拉取标志）
          if (typeof processAndClearBuffers === 'function') await processAndClearBuffers();

          // 6. 如果路由在主聊天室，绑定一次性点击事件清除未读
          setTimeout(() => {
            const router = getRouter?.();
            const currentPath = router?.currentRoute?.value?.path || window.location.pathname || '';
            if (currentPath === '/chat' || currentPath === '/chat/') {
              const unifiedChatEl = document.querySelector('.chat-content[data-content="unified-chat"]');
              if (unifiedChatEl) {
                const handleClick = function() {
                  const unreadStore = useUnreadStore();
                  if (unreadStore) {
                    unreadStore.clearGlobalUnread();
                    unreadStore.enqueueUnreadClear('global');
                    updateUnreadCountsDisplay();
                  }
                  unifiedChatEl.removeEventListener('click', handleClick);
                };
                unifiedChatEl.addEventListener('click', handleClick, { once: true });
              }
            }
          }, 200);
        } catch (error) {
          console.error('初始化聊天失败:', error);
          // 出错时确保关闭拉取标志
          if (typeof setPullingMessages === 'function') setPullingMessages(false);
        }
}

function adjustChatLayout() {
    const chatContent = document.querySelector('.chat-content.active');
    if (chatContent) {
        chatContent.style.marginBottom = '0';
        chatContent.style.paddingBottom = '0';
        chatContent.style.height = '100%';
        chatContent.style.overflow = 'hidden';

        if (chatContent.dataset.content === 'unified-chat') {
            const markdownToolbar = document.getElementById('markdownToolbar');
            if (markdownToolbar && markdownToolbar.style.display !== 'none') {
                chatContent.style.paddingTop = '60px';
            } else {
                chatContent.style.paddingTop = '0';
            }
        } else if (chatContent.dataset.content === 'group-chat') {
            chatContent.style.paddingTop = '0';
        } else {
            chatContent.style.paddingTop = '0';
        }

        chatContent.style.display = 'none';
        requestAnimationFrame(() => {
            chatContent.style.display = 'flex';
        });
    }
}

function updateGroupMuteIcon(groupItem, groupId) {
    let muteIcon = groupItem.querySelector('.mute-icon');
    if (muteIcon) {
        muteIcon.remove();
    }

    if (isGroupMuted(groupId)) {
        muteIcon = document.createElement('span');
        muteIcon.className = 'mute-icon';
        muteIcon.textContent = '🔕';
        muteIcon.style.marginLeft = '5px';
        muteIcon.style.fontSize = '12px';
        muteIcon.title = '已免打扰';
        groupItem.appendChild(muteIcon);
    }
}

function updateGroupListDisplay() {
    const groupList = document.getElementById('groupList');
    if (!groupList) return;

    const groupItems = groupList.querySelectorAll('li');
    groupItems.forEach(item => {
        const groupId = item.getAttribute('data-group-id');
        updateGroupMuteIcon(item, groupId);
    });
}

export {
  openModal,
  closeModal,
  getModalNameFromId,
  getModalId,
  logout,
  initializeFocusListeners,
  updateUnreadCountsDisplay,
  setActiveChat,
  setActiveChatDirect,
  initializeChat,
  adjustChatLayout,
  updateGroupMuteIcon,
  updateGroupListDisplay,
  currentGroupId,
  currentGroupName,
  currentUser,
  currentSessionToken,
  currentPrivateChatUserId,
  currentPrivateChatUsername,
  currentPrivateChatNickname,
  currentSendChatType,
  selectedGroupIdForCard,
  refreshToken
};

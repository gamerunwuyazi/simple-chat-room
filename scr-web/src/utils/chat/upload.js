import localForage from 'localforage';

import { SERVER_URL, toast } from './config.js';
import {
  useBaseStore,
  useFriendStore,
  useGroupStore,
  usePublicStore,
  useSessionStore,
  useStorageStore,
  getChatSocket
} from '@/stores/index.js';
import { loadMessages } from './websocket.js';
import { refreshTokenWithQueue } from './tokenManager.js';
import { logout } from './ui.js';
import { uploadAvatar } from '@/api/upload.js';

let isLoadingMoreMessages = {
  public: false,
  group: {},
  private: {}
};
let loadingIndicatorTimeout = null;
let scrollingInitialized = {};
let prevPrivateScrollHeight = 0;
let prevPrivateScrollTop = 0;
let prevGroupScrollHeight = 0;
let prevGroupScrollTop = 0;
let prevPublicScrollHeight = 0;
let prevPublicScrollTop = 0;
// 记录触发加载更多的容器引用，用于恢复滚动位置
let loadingContainer = null;
let loadingIsGroup = false;
let loadingIsPrivate = false;

function showError(message) {
  if (toast && toast.error) {
    toast.error(message);
  }
}

function showSuccess(message) {
  if (toast && toast.success) {
    toast.success(message);
  }
}

function uploadWithProgress(url, formData, baseStore, onSuccess, onError) {
  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable && baseStore) {
      const percentComplete = Math.round((e.loaded / e.total) * 100);
      baseStore.uploadProgress = percentComplete;
    }
  });

  xhr.addEventListener('load', async () => {
    if (baseStore) {
      baseStore.showUploadProgress = false;
      baseStore.uploadProgress = 0;
    }

    if (xhr.status === 413) {
      onError('文件过大，请选择小于5MB的文件');
      return;
    }

    if (xhr.status === 401) {
      try {
        const refreshSuccess = await refreshTokenWithQueue();
        if (refreshSuccess) {
          const newToken = localStorage.getItem('currentSessionToken');
          if (newToken && baseStore?.currentUser) {
            const retryXhr = new XMLHttpRequest();
            retryXhr.upload.addEventListener('progress', (e) => {
              if (e.lengthComputable && baseStore) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                baseStore.uploadProgress = percentComplete;
              }
            });

            retryXhr.addEventListener('load', () => {
              if (baseStore) {
                baseStore.showUploadProgress = false;
                baseStore.uploadProgress = 0;
              }

              try {
                const data = JSON.parse(retryXhr.responseText);
                onSuccess(data);
              } catch (e) {
                onError('上传失败，请稍后重试');
              }
            });

            retryXhr.addEventListener('error', () => {
              if (baseStore) {
                baseStore.showUploadProgress = false;
                baseStore.uploadProgress = 0;
              }
              onError('上传失败，请稍后重试');
            });

            retryXhr.open('POST', url);
            retryXhr.setRequestHeader('user-id', baseStore.currentUser.id);
            retryXhr.setRequestHeader('session-token', newToken);
            retryXhr.send(formData);
          } else {
            logout();
            onError('会话已过期，请重新登录');
          }
        } else {
          logout();
          onError('会话已过期，请重新登录');
        }
      } catch (error) {
        console.error('刷新Token失败:', error);
        logout();
        onError('会话已过期，请重新登录');
      }
      return;
    }

    try {
      const data = JSON.parse(xhr.responseText);
      onSuccess(data);
    } catch (e) {
      console.error('解析上传响应失败:', e);
      onError('上传失败，服务器响应异常');
    }
  });

  xhr.addEventListener('error', () => {
    if (baseStore) {
      baseStore.showUploadProgress = false;
      baseStore.uploadProgress = 0;
    }
    onError('网络连接失败，请检查网络后重试');
  });

  xhr.addEventListener('abort', () => {
    if (baseStore) {
      baseStore.showUploadProgress = false;
      baseStore.uploadProgress = 0;
    }
    onError('上传已取消');
  });

  xhr.open('POST', url);
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  xhr.setRequestHeader('user-id', currentUser.id);
  xhr.setRequestHeader('session-token', currentSessionToken);
  xhr.send(formData);
}

function uploadImage(file) {
  const sessionStore = useSessionStore();
  const baseStore = useBaseStore();
  
  const chat = String(sessionStore?.currentActiveChat || 'main');
  
  if (chat.startsWith('private_')) {
    uploadPrivateImage(file);
    return;
  }
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  if (!user || !token) {
    return;
  }
  
  const img = new Image();
  const reader = new FileReader();
  reader.onload = function(e) {
    img.onload = function() {
      const width = img.width;
      const height = img.height;

      const formData = new FormData();
      formData.append('image', file);
      formData.append('userId', user.id);
      formData.append('width', width);
      formData.append('height', height);

      const isGroupChat = chat !== 'main';
      if (isGroupChat) {
        let groupId = chat;
        if (typeof groupId === 'string' && groupId.startsWith('group_')) {
          groupId = groupId.replace('group_', '');
        }
        formData.append('groupId', groupId);
      }

      if (baseStore) {
        baseStore.showUploadProgress = true;
        baseStore.uploadProgress = 0;
      }

      uploadWithProgress(
        `${SERVER_URL}/api/upload`,
        formData,
        baseStore,
        () => {},
        () => showError('上传失败')
      );
    };

    img.onerror = function() {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('userId', user.id);

      const isGroupChat = chat !== 'main';
      if (isGroupChat) {
        let groupId = chat;
        if (typeof groupId === 'string' && groupId.startsWith('group_')) {
          groupId = groupId.replace('group_', '');
        }
        formData.append('groupId', groupId);
      }

      if (baseStore) {
        baseStore.showUploadProgress = true;
        baseStore.uploadProgress = 0;
      }

      uploadWithProgress(
        `${SERVER_URL}/api/upload`,
        formData,
        baseStore,
        () => {},
        () => showError('上传失败')
      );
    };

    img.src = e.target.result;
  };

  reader.readAsDataURL(file);
}

function uploadFile(file) {
  const sessionStore = useSessionStore();
  const baseStore = useBaseStore();
  
  const chat = String(sessionStore?.currentActiveChat || 'main');
  
  if (chat.startsWith('private_')) {
    uploadPrivateFile(file);
    return;
  }
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  if (!user || !token) {
    return;
  }
  
  const formData = new FormData();
  formData.append('image', file);
  formData.append('userId', user.id);

  const isGroupChat = chat !== 'main';
  if (isGroupChat) {
    let groupId = chat;
    if (typeof groupId === 'string' && groupId.startsWith('group_')) {
      groupId = groupId.replace('group_', '');
    }
    formData.append('groupId', groupId);
  }

  if (baseStore) {
    baseStore.showUploadProgress = true;
    baseStore.uploadProgress = 0;
  }

  uploadWithProgress(
    `${SERVER_URL}/api/upload`,
    formData,
    baseStore,
    () => {},
    () => showError('上传失败')
  );
}

function uploadPrivateImage(file) {
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const baseStore = useBaseStore();
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  
  if (!user || !token) return;

  const privateChatUserId = sessionStore?.currentPrivateChatUserId;
  if (!privateChatUserId) return;

  const friendsList = friendStore?.friendsList || [];
  const isFriend = friendsList.some(friend => String(friend.id) === String(privateChatUserId));
  if (!isFriend) {
    showError('您与该用户不是好友，无法发送私信');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);
  formData.append('userId', user.id);
  formData.append('privateChat', true);

  if (baseStore) {
    baseStore.showUploadProgress = true;
    baseStore.uploadProgress = 0;
  }

  uploadWithProgress(
    `${SERVER_URL}/api/upload`,
    formData,
    baseStore,
    (data) => {
      const messageData = {
        userId: Number(user.id),
        content: JSON.stringify({ url: data.url, name: file.name }),
        receiverId: Number(privateChatUserId),
        sessionToken: token,
        messageType: 1
      };

      const chatSocket = getChatSocket();
      if (chatSocket) {
        chatSocket.emit('send-private-message', messageData);
      }
    },
    () => showError('上传失败')
  );
}

function uploadPrivateFile(file) {
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const baseStore = useBaseStore();
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  
  if (!user || !token) return;

  const privateChatUserId = sessionStore?.currentPrivateChatUserId;
  if (!privateChatUserId) return;

  const friendsList = friendStore?.friendsList || [];
  const isFriend = friendsList.some(friend => String(friend.id) === String(privateChatUserId));
  if (!isFriend) {
    showError('您与该用户不是好友，无法发送私信');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('userId', user.id);
  formData.append('privateChat', true);

  if (baseStore) {
    baseStore.showUploadProgress = true;
    baseStore.uploadProgress = 0;
  }

  uploadWithProgress(
    `${SERVER_URL}/api/upload`,
    formData,
    baseStore,
    (data) => {
      const messageData = {
        userId: Number(user.id),
        content: JSON.stringify({ url: data.url, name: file.name, size: file.size }),
        receiverId: Number(privateChatUserId),
        sessionToken: token,
        messageType: 2
      };

      const chatSocket = getChatSocket();
      if (chatSocket) {
        chatSocket.emit('send-private-message', messageData);
      }
    },
    () => showError('上传失败')
  );
}

function uploadVideo(file) {
  const sessionStore = useSessionStore();
  const baseStore = useBaseStore();
  
  const chat = String(sessionStore?.currentActiveChat || 'main');
  
  if (chat.startsWith('private_')) {
    uploadPrivateVideo(file);
    return;
  }
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  if (!user || !token) {
    return;
  }
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('userId', user.id);

  const isGroupChat = chat !== 'main';
  if (isGroupChat) {
    let groupId = chat;
    if (typeof groupId === 'string' && groupId.startsWith('group_')) {
      groupId = groupId.replace('group_', '');
    }
    formData.append('groupId', groupId);
  }

  if (baseStore) {
    baseStore.showUploadProgress = true;
    baseStore.uploadProgress = 0;
  }

  uploadWithProgress(
    `${SERVER_URL}/api/upload`,
    formData,
    baseStore,
    () => {},
    () => showError('上传失败')
  );
}

function uploadPrivateVideo(file) {
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const baseStore = useBaseStore();
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  
  if (!user || !token) return;

  const privateChatUserId = sessionStore?.currentPrivateChatUserId;
  if (!privateChatUserId) return;

  const friendsList = friendStore?.friendsList || [];
  const isFriend = friendsList.some(friend => String(friend.id) === String(privateChatUserId));
  if (!isFriend) {
    showError('您与该用户不是好友，无法发送私信');
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('userId', user.id);
  formData.append('privateChat', true);

  if (baseStore) {
    baseStore.showUploadProgress = true;
    baseStore.uploadProgress = 0;
  }

  uploadWithProgress(
    `${SERVER_URL}/api/upload`,
    formData,
    baseStore,
    (data) => {
      const messageData = {
        userId: Number(user.id),
        content: JSON.stringify({ url: data.url, name: file.name, size: file.size }),
        receiverId: Number(privateChatUserId),
        sessionToken: token,
        messageType: 2
      };

      const chatSocket = getChatSocket();
      if (chatSocket) {
        chatSocket.emit('send-private-message', messageData);
      }
    },
    () => showError('上传失败')
  );
}

function uploadUserAvatar(file) {
  const baseStore = useBaseStore();
  
  const user = baseStore.currentUser;
  const token = baseStore.currentSessionToken;
  
  if (!user || !token) return;
  
  const formData = new FormData();
  formData.append('avatar', file);
  formData.append('userId', user.id);

  uploadAvatar(formData)
    .then(res => { const data = res.data;
      showSuccess('头像上传成功');

      if (data.avatarUrl) {
        if (baseStore && baseStore.currentUser) {
          baseStore.setCurrentUser({
            ...baseStore.currentUser,
            avatar_url: data.avatarUrl
          });
        }

        const currentUserAvatar = document.getElementById('currentUserAvatar');
        if (currentUserAvatar) {
          currentUserAvatar.src = `${SERVER_URL}${data.avatarUrl}`;
          currentUserAvatar.style.display = 'block';
        }

        const currentAvatarImg = document.getElementById('currentAvatarImg');
        if (currentAvatarImg) {
          currentAvatarImg.src = `${SERVER_URL}${data.avatarUrl}`;
        }
      }

      const uploadAvatarButton = document.getElementById('uploadAvatarButton');
      if (uploadAvatarButton) {
        uploadAvatarButton.disabled = true;
      }
    })
    .catch(err => {
      showError(err.response?.data?.message || err.message || '头像上传失败，请重试');
    });
}

function resetLoadingState(containerId) {
  if (containerId) {
    if (containerId === 'public') {
      isLoadingMoreMessages.public = false;
    } else if (containerId === 'group') {
      const sessionStore = useSessionStore();
      if (sessionStore?.currentGroupId) {
        isLoadingMoreMessages.group[sessionStore.currentGroupId] = false;
      }
    } else if (containerId === 'private') {
      const sessionStore = useSessionStore();
      if (sessionStore?.currentPrivateChatUserId) {
        isLoadingMoreMessages.private[sessionStore.currentPrivateChatUserId] = false;
      }
    } else if (containerId.startsWith('group-')) {
      const groupId = containerId.replace('group-', '');
      isLoadingMoreMessages.group[groupId] = false;
    } else if (containerId.startsWith('private-')) {
      const userId = containerId.replace('private-', '');
      isLoadingMoreMessages.private[userId] = false;
    }
  }
  if (loadingIndicatorTimeout) {
    clearTimeout(loadingIndicatorTimeout);
    loadingIndicatorTimeout = null;
  }

  const loadingIndicators = document.querySelectorAll('.loading-indicator');
  loadingIndicators.forEach(indicator => indicator.remove());

  // 恢复滚动位置
  restoreScrollPosition();
}

// 恢复滚动位置，并在仍在顶部时继续触发加载更多
function restoreScrollPosition() {
  const container = loadingContainer;
  if (!container) return;

  const isGroup = loadingIsGroup;
  const isPrivate = loadingIsPrivate;

  let savedHeight = 0;
  let savedTop = 0;
  if (isPrivate) {
    savedHeight = prevPrivateScrollHeight;
    savedTop = prevPrivateScrollTop;
  } else if (isGroup) {
    savedHeight = prevGroupScrollHeight;
    savedTop = prevGroupScrollTop;
  } else {
    savedHeight = prevPublicScrollHeight;
    savedTop = prevPublicScrollTop;
  }

  // 清除保存的位置
  prevPrivateScrollHeight = 0;
  prevPrivateScrollTop = 0;
  prevGroupScrollHeight = 0;
  prevGroupScrollTop = 0;
  prevPublicScrollHeight = 0;
  prevPublicScrollTop = 0;

  if (savedHeight <= 0) return;

  // 使用 requestAnimationFrame 确保 DOM 已更新
  requestAnimationFrame(() => {
    const newScrollHeight = container.scrollHeight;
    const offset = newScrollHeight - savedHeight;
    if (offset > 0) {
      container.scrollTop = savedTop + offset;
    }

    // 如果恢复后仍在顶部，且有更多消息可加载，继续触发加载
    if (container.scrollTop < 50) {
      const sessionStore = useSessionStore();
      let isAllLoaded = false;
      if (isPrivate && sessionStore?.currentPrivateChatUserId) {
        const friendStore = useFriendStore();
        isAllLoaded = friendStore?.isPrivateAllLoaded?.(sessionStore.currentPrivateChatUserId) || false;
      } else if (isGroup && sessionStore?.currentGroupId) {
        const groupStore = useGroupStore();
        isAllLoaded = groupStore?.isGroupAllLoaded?.(sessionStore.currentGroupId) || false;
      } else {
        const publicStore = usePublicStore();
        isAllLoaded = publicStore?.isPublicAllLoaded?.() || false;
      }

      if (!isAllLoaded) {
        // 延迟触发，避免递归栈过深
        setTimeout(() => {
          handleScroll(null, container, isGroup, isPrivate);
        }, 150);
      }
    }
  });
}

async function handleScroll(e, container, isGroup, isPrivate = false) {
  const containerId = isPrivate ? 'private' : (isGroup ? 'group' : 'public');

  if (container.scrollTop < 50) {
    const sessionStore = useSessionStore();
    const baseStore = useBaseStore();
    const friendStore = useFriendStore();
    const groupStore = useGroupStore();
    const publicStore = usePublicStore();
    const storageStore = useStorageStore();
    
    // 前置校验：类型标志和对应 ID 必须匹配，否则直接返回
    if (isPrivate && !sessionStore?.currentPrivateChatUserId) return;
    if (isGroup && !sessionStore?.currentGroupId) return;
    
    let isAllLoaded = false;
    
    const currentPrivateChatUserId = sessionStore?.currentPrivateChatUserId;
    const currentGroupId = sessionStore?.currentGroupId;
    
    if (isPrivate) {
      if (friendStore && friendStore.isPrivateAllLoaded) {
        isAllLoaded = friendStore.isPrivateAllLoaded(currentPrivateChatUserId);
      }
    } else if (isGroup) {
      if (groupStore && groupStore.isGroupAllLoaded) {
        isAllLoaded = groupStore.isGroupAllLoaded(currentGroupId);
      }
    } else {
      if (publicStore && publicStore.isPublicAllLoaded) {
        isAllLoaded = publicStore.isPublicAllLoaded();
      }
    }
    
    if (isAllLoaded) {
      return;
    }
    
    let isCurrentLoading = false;
    if (isPrivate) {
      isCurrentLoading = isLoadingMoreMessages.private[sessionStore?.currentPrivateChatUserId] || false;
    } else if (isGroup) {
      isCurrentLoading = isLoadingMoreMessages.group[sessionStore?.currentGroupId] || false;
    } else {
      isCurrentLoading = isLoadingMoreMessages.public || false;
    }
    
    if (!isCurrentLoading && scrollingInitialized[containerId]) {
      if (isPrivate) {
        isLoadingMoreMessages.private[sessionStore?.currentPrivateChatUserId] = true;
      } else if (isGroup) {
        isLoadingMoreMessages.group[sessionStore?.currentGroupId] = true;
      } else {
        isLoadingMoreMessages.public = true;
      }

      // 保存容器引用，用于恢复滚动位置
      loadingContainer = container;
      loadingIsGroup = isGroup;
      loadingIsPrivate = isPrivate;

      const prevScrollHeight = container.scrollHeight;
      const prevScrollTop = container.scrollTop;

      if (isPrivate) {
        prevPrivateScrollHeight = prevScrollHeight;
        prevPrivateScrollTop = prevScrollTop;
      } else if (isGroup) {
        prevGroupScrollHeight = prevScrollHeight;
        prevGroupScrollTop = prevScrollTop;
      } else {
        prevPublicScrollHeight = prevScrollHeight;
        prevPublicScrollTop = prevScrollTop;
      }

      let olderThan = null;
      let messages = [];

      if (isPrivate && friendStore && friendStore.privateMessages && sessionStore.currentPrivateChatUserId) {
        messages = friendStore.privateMessages[sessionStore.currentPrivateChatUserId] || [];
      } else if (isGroup && groupStore && groupStore.groupMessages && sessionStore.currentGroupId) {
        messages = groupStore.groupMessages[sessionStore.currentGroupId] || [];
      } else if (publicStore && publicStore.publicMessages) {
        messages = publicStore.publicMessages || [];
      }

      if (messages.length > 0) {
        olderThan = messages[0].id;
      }

      let fullMessages = null;
      if (isPrivate && sessionStore?.currentPrivateChatUserId) {
        fullMessages = storageStore && storageStore.fullPrivateMessages && storageStore.fullPrivateMessages[sessionStore.currentPrivateChatUserId];
      } else if (isGroup && sessionStore?.currentGroupId) {
        fullMessages = storageStore && storageStore.fullGroupMessages && storageStore.fullGroupMessages[sessionStore.currentGroupId];
      } else {
        fullMessages = storageStore && storageStore.fullPublicMessages;
      }
      
      if (fullMessages && fullMessages.length > messages.length) {
        const storeIds = new Set(messages.map(m => m.id));
        const newLocalMessages = fullMessages.filter(m => !storeIds.has(m.id) && olderThan !== null && m.id < olderThan);
        
        if (newLocalMessages.length > 0) {
          newLocalMessages.sort((a, b) => b.id - a.id);
          
          const pageSize = 20;
          const messagesToAdd = newLocalMessages.slice(0, pageSize);
          
          messagesToAdd.sort((a, b) => a.id - b.id);
          
          if (isPrivate && sessionStore?.currentPrivateChatUserId) {
            friendStore.prependPrivateMessages(sessionStore.currentPrivateChatUserId, messagesToAdd);
          } else if (isGroup && sessionStore?.currentGroupId) {
            groupStore.prependGroupMessages(sessionStore.currentGroupId, messagesToAdd);
          } else {
            publicStore.prependPublicMessages(messagesToAdd);
          }
          
          resetLoadingState(containerId);
          return;
        }
      }
      
      const currentUserForStorage = baseStore.currentUser;
      const prefix = `chats-${currentUserForStorage?.id || 'guest'}`;
      let localMessages = [];
      
      try {
        let storageKey = '';
        if (isPrivate && sessionStore?.currentPrivateChatUserId) {
          storageKey = `${prefix}-private-${sessionStore.currentPrivateChatUserId}`;
        } else if (isGroup && sessionStore?.currentGroupId) {
          storageKey = `${prefix}-group-${sessionStore.currentGroupId}`;
        } else {
          storageKey = `${prefix}-public`;
        }
        
        const localData = await localForage.getItem(storageKey);
        if (localData && localData.messages) {
          localMessages = localData.messages || [];
          
          const storeIds = new Set(messages.map(m => m.id));
          const newLocalMessages = localMessages.filter(m => !storeIds.has(m.id) && olderThan !== null && m.id < olderThan);
          
          if (newLocalMessages.length > 0) {
            newLocalMessages.sort((a, b) => b.id - a.id);
            
            const pageSize = 20;
            const messagesToAdd = newLocalMessages.slice(0, pageSize);
            
            messagesToAdd.sort((a, b) => a.id - b.id);
            
            if (isPrivate && sessionStore?.currentPrivateChatUserId) {
              friendStore.prependPrivateMessages(sessionStore.currentPrivateChatUserId, messagesToAdd);
            } else if (isGroup && sessionStore?.currentGroupId) {
              groupStore.prependGroupMessages(sessionStore.currentGroupId, messagesToAdd);
            } else {
              publicStore.prependPublicMessages(messagesToAdd);
            }
            
            resetLoadingState(containerId);
            return;
          }
        }
      } catch (err) {
        console.error(`[加载更多] 检查本地消息失败:`, err);
      }
      
      const user = baseStore.currentUser;
      const token = baseStore.currentSessionToken;

      if (user && token) {
        if (loadMessages) {
          if (isGroup && sessionStore?.currentGroupId) {
            loadMessages('group', {
              groupId: sessionStore.currentGroupId,
              limit: 20,
              olderThan: olderThan,
              loadMore: true
            });
          } else if (isPrivate && sessionStore?.currentPrivateChatUserId) {
            loadMessages('private', {
              friendId: sessionStore.currentPrivateChatUserId,
              limit: 20,
              olderThan: olderThan,
              loadMore: true
            });
          } else {
            loadMessages('global', {
              limit: 20,
              olderThan: olderThan,
              loadMore: true
            });
          }
        }

        loadingIndicatorTimeout = setTimeout(() => {
          let stillLoading = false;
          if (isPrivate) {
            stillLoading = isLoadingMoreMessages.private[sessionStore?.currentPrivateChatUserId] || false;
          } else if (isGroup) {
            stillLoading = isLoadingMoreMessages.group[sessionStore?.currentGroupId] || false;
          } else {
            stillLoading = isLoadingMoreMessages.public || false;
          }
          if (stillLoading) {
            const loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.textContent = '加载中...';
            loadingIndicator.style.textAlign = 'center';
            loadingIndicator.style.padding = '10px';
            loadingIndicator.style.color = '#666';
            loadingIndicator.style.fontSize = '14px';
            container.insertBefore(loadingIndicator, container.firstChild);
          }
        }, 500);
      } else {
        resetLoadingState(containerId);
      }
    }
  }
}

function initializeScrollLoading(force = false) {
  const messageContainer = document.getElementById('messageContainer');
  const groupMessageContainer = document.getElementById('groupMessageContainer');
  const privateMessageContainer = document.getElementById('privateMessageContainer');

  function addScrollListener(container, isGroup, isPrivate) {
    if (!container) {
      return;
    }
    
    if (force) {
      container._scrollListenerAdded = false;
    }
    
    if (container._scrollListenerAdded) {
      return;
    }
    
    container._scrollListenerAdded = true;
    
    const scrollHandler = function(e) {
      handleScroll(e, this, isGroup, isPrivate);
    };
    
    container.addEventListener('scroll', scrollHandler);
  }

  addScrollListener(messageContainer, false, false);
  addScrollListener(groupMessageContainer, true, false);
  addScrollListener(privateMessageContainer, false, true);

  setTimeout(() => {
    scrollingInitialized = {
      public: true,
      group: true,
      private: true
    };
  }, 500);
}

function initializeImageClickEvents() {
}

export {
  uploadImage,
  uploadFile,
  uploadVideo,
  uploadPrivateImage,
  uploadPrivateFile,
  uploadPrivateVideo,
  uploadUserAvatar,
  initializeScrollLoading,
  initializeImageClickEvents,
  showError,
  showSuccess,
  resetLoadingState
};

import localForage from 'localforage';

import modal from '../modal.js';

import { SERVER_URL, toast } from './config.js';
import { updateUnreadCountsDisplay, setActiveChatDirect } from './ui.js';
import {
  useBaseStore,
  useFriendStore,
  useSessionStore,
  useUnreadStore,
  useDraftStore,
  useModalStore,
  useStorageStore,
  openUserAvatarPopup,
  closeUserAvatarPopup
} from '@/stores/index.js';
import { unescapeHtml } from './message.js';
import { navigateTo } from './routerInstance.js';
import { getFriendsList, addFriend as apiAddFriend, removeFriend, getUserInfo } from '@/api/friend.js';
import { searchUsers as apiSearchUsers } from '@/api/user.js';

let friendsList = [];

// 已删除会话快照（存 localStorage，独立于 IndexedDB 消息缓存）。
// 用途：清空 IndexedDB 后首次拉取时，仍能根据快照识别并显示已删除会话。
function getDeletedFriendSnapshot() {
  const baseStore = useBaseStore();
  const userId = baseStore.currentUser?.id || 'guest';
  try {
    const v = localStorage.getItem(`chats-${userId}-deleted-friends`);
    return (v && JSON.parse(v)) || {};
  } catch {
    return {};
  }
}

function saveDeletedFriendSnapshot(snapshot) {
  const baseStore = useBaseStore();
  const userId = baseStore.currentUser?.id || 'guest';
  try {
    localStorage.setItem(`chats-${userId}-deleted-friends`, JSON.stringify(snapshot));
  } catch {}
}

function switchToPrivateChat(userId, nickname, username, avatarUrl, options = {}) {
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const unreadStore = useUnreadStore();
  const draftStore = useDraftStore();
  const noNavigate = !!(options && options.noNavigate);
  
  const currentPrivateUserId = sessionStore?.currentPrivateChatUserId;
  if (currentPrivateUserId) {
    const privateMessageInput = document.getElementById('privateMessageInput');
    if (privateMessageInput) {
      const content = privateMessageInput.textContent || privateMessageInput.innerHTML || '';
      if (draftStore) {
        draftStore.saveDraft('private', currentPrivateUserId, content);
      }
    }
    if (draftStore) {
      draftStore.setLastMessageToDraft('private', currentPrivateUserId);
    }
  }
  
  const currentPrivateChatUserId = userId;
  const currentPrivateChatUsername = username;
  const currentPrivateChatNickname = nickname;
  const currentActiveChat = `private_${userId}`;
  
  sessionStore.currentPrivateChatUserId = currentPrivateChatUserId;
  sessionStore.currentPrivateChatUsername = currentPrivateChatUsername;
  sessionStore.currentPrivateChatNickname = currentPrivateChatNickname;
  sessionStore.currentPrivateChatAvatarUrl = avatarUrl;
  sessionStore.currentActiveChat = currentActiveChat;

  if (sessionStore) {
    sessionStore.setCurrentPrivateChatUserId(userId);
    // 进入具体私聊时退出"新的朋友"好友申请面板
    sessionStore.showFriendRequests = false;
  }
  
  if (friendStore && friendStore.setPrivateAllLoaded) {
    friendStore.setPrivateAllLoaded(userId, false);
  }
  
  if (unreadStore && unreadStore.clearPrivateUnread) {
    unreadStore.clearPrivateUnread(userId);
  }

  setActiveChatDirect('private', userId, true);

  // 嵌入模式下不跳转路由，由 /chat 右侧面板切换渲染
  if (!noNavigate) {
    navigateTo('/chat/private');
  }
  
  window.dispatchEvent(new CustomEvent('private-switched'));
  
  if (typeof updateUnreadCountsDisplay === 'function') {
    updateUnreadCountsDisplay();
  }
  
  const hasMessages = friendStore && friendStore.privateMessages && friendStore.privateMessages[userId] && friendStore.privateMessages[userId].length > 0;
  
  return true;
}

function initializePrivateChatInterface() {
  const togglePrivateMarkdownToolbar = document.getElementById('togglePrivateMarkdownToolbar');
  if (togglePrivateMarkdownToolbar) {
    togglePrivateMarkdownToolbar.addEventListener('click', () => {
      const privateMarkdownToolbar = document.getElementById('privateMarkdownToolbar');
      if (privateMarkdownToolbar) {
        privateMarkdownToolbar.style.display = privateMarkdownToolbar.style.display === 'flex' ? 'none' : 'flex';

        const icon = togglePrivateMarkdownToolbar.querySelector('i');
        if (icon) {
          icon.style.transform = privateMarkdownToolbar.style.display === 'flex' ? 'rotate(180deg)' : 'rotate(0deg)';
        }
      }
    });
  }

  const privateChatInterface = document.getElementById('privateChatInterface');
  if (privateChatInterface) {
    privateChatInterface.addEventListener('click', function() {
      const sessionStore = useSessionStore();
      const baseStore = useBaseStore();
      const unreadStore = useUnreadStore();
      
      const currentPrivateChatUserId = sessionStore.currentPrivateChatUserId;
      const currentUser = baseStore.currentUser;
      const currentSessionToken = baseStore.currentSessionToken;
      
      if (currentPrivateChatUserId) {
        if (unreadStore && unreadStore.unreadMessages) {
          delete unreadStore.unreadMessages.private[currentPrivateChatUserId];
        }
        if (typeof updateUnreadCountsDisplay === 'function') {
          updateUnreadCountsDisplay();
        }
      }
    });
  }
}

export function initializePrivateMessageSending() {
}

function loadPrivateChatHistory(userId) {
}

async function loadFriendsList() {
  const baseStore = useBaseStore();
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;

  if (!currentUser || !currentSessionToken) return;

  try {
    const res = await getFriendsList();
    const data = res.data;
    await updateFriendsList(data.friends);
  } catch (e) {
    console.error('加载好友列表失败:', e);
  }

  try {
    if (baseStore.loadFriendRequests) {
      await baseStore.loadFriendRequests();
    }
  } catch (e) {
    console.error('加载好友请求失败:', e);
  }
}

async function updateFriendsList(friends) {
  friendsList = friends;

  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const unreadStore = useUnreadStore();
  
  if (friendStore) {
    const userId = baseStore.currentUser?.id || 'guest';
    const prefix = `chats-${userId}`;

    const existingFriends = friendStore.friendsList || [];
    const existingFriendMap = new Map();
    existingFriends.forEach(f => existingFriendMap.set(String(f.id), f));

    const serverFriendIds = new Set(friends.map(f => String(f.id)));

    // 本次同步过程中统一维护已删除会话快照，末尾一次性写回 localStorage
    let deletedSnapshot = getDeletedFriendSnapshot();

    let chatKeysData = null;
    try {
      chatKeysData = await localForage.getItem(prefix);
    } catch (e) {
      console.error('读取 chatKeys 失败:', e);
    }
    
    const localFriendIdsFromKeys = new Set();
    if (chatKeysData && chatKeysData.chatKeys) {
      chatKeysData.chatKeys.forEach(key => {
        if (key.includes('-private-')) {
          const friendId = key.split('-private-')[1];
          localFriendIdsFromKeys.add(friendId);
        }
      });
    }

    const newChatKeys = chatKeysData && chatKeysData.chatKeys ? [...chatKeysData.chatKeys] : [];
    for (const friend of friends) {
      const friendIdStr = String(friend.id);
      const key = `${prefix}-private-${friendIdStr}`;
      if (!localFriendIdsFromKeys.has(friendIdStr)) {
        newChatKeys.push(key);
        localFriendIdsFromKeys.add(friendIdStr);
      }
    }
    try {
      await localForage.setItem(prefix, { chatKeys: newChatKeys });
    } catch (e) {
      console.error('更新 chatKeys 失败:', e);
    }

    for (const friend of friends) {
      const existingFriend = existingFriendMap.get(String(friend.id));
      // 后端返回 status: 1=正常好友，4=我拉黑对方、5=对方拉黑我、10=互相拉黑（拉黑不影响会话显示），污点状态(0/6/11)=已删除会话
      const isDeletedSession = friend.status !== undefined && friend.status !== 1 && friend.status !== 4 && friend.status !== 5 && friend.status !== 10;

      try {
        const key = `${prefix}-private-${friend.id}`;
        const existingData = await localForage.getItem(key) || { messages: [] };
        const updatedSessionData = { ...existingData };
        if (friend.nickname) updatedSessionData.nickname = friend.nickname;
        if (friend.username) updatedSessionData.username = friend.username;
        if (friend.avatar_url) updatedSessionData.avatarUrl = friend.avatar_url;
        else if (friend.avatarUrl) updatedSessionData.avatarUrl = friend.avatarUrl;
        if (friend.remark !== undefined && friend.remark !== null) {
          updatedSessionData.remark = friend.remark;
        } else if (!updatedSessionData.remark) {
          updatedSessionData.remark = null;
        }

        if (isDeletedSession) {
          // 污点记录：保持已删除会话状态（首次拉取 IndexedDB 为空时也能显示）
          if (!updatedSessionData.deleted_at) {
            updatedSessionData.deleted_at = new Date().toISOString();
          }
          deletedSnapshot[String(friend.id)] = {
            nickname: updatedSessionData.nickname || friend.nickname || '',
            avatarUrl: updatedSessionData.avatarUrl || friend.avatar_url || friend.avatarUrl || null,
            deleted_at: updatedSessionData.deleted_at
          };
        } else {
          delete updatedSessionData.deleted_at;
          // 服务器仍返回该会话（已恢复），清除对应已删除快照
          if (deletedSnapshot[String(friend.id)]) {
            delete deletedSnapshot[String(friend.id)];
          }
        }

        await localForage.setItem(key, updatedSessionData);
      } catch (e) {
        console.error('更新IndexedDB中的好友会话信息失败:', e);
      }
    }

    for (const friendId of localFriendIdsFromKeys) {
      const friendIdStr = String(friendId);
      if (!serverFriendIds.has(friendIdStr)) {
        try {
          const key = `${prefix}-private-${friendId}`;
          const existingData = await localForage.getItem(key);
          if (!existingData?.deleted_at) {
            let updatedSessionData;
            if (existingData) {
              updatedSessionData = { ...existingData };
            } else {
              const existingFriend = existingFriendMap.get(friendIdStr);
              updatedSessionData = { messages: [] };
              if (existingFriend) {
                if (existingFriend.nickname) updatedSessionData.nickname = existingFriend.nickname;
                if (existingFriend.username) updatedSessionData.username = existingFriend.username;
                if (existingFriend.avatar_url) updatedSessionData.avatarUrl = existingFriend.avatar_url;
                else if (existingFriend.avatarUrl) updatedSessionData.avatarUrl = existingFriend.avatarUrl;
              }
            }
            
            if (!updatedSessionData.nickname) {
              try {
                const res = await getUserInfo(friendId);
                if (res.status === 200) {
                  const responseData = res.data;
                  if (responseData.status === 'success' && responseData.user) {
                    if (!updatedSessionData.nickname && responseData.user.nickname) {
                      updatedSessionData.nickname = responseData.user.nickname;
                    }
                    if (!updatedSessionData.avatarUrl && responseData.user.avatar_url) {
                      updatedSessionData.avatarUrl = responseData.user.avatar_url;
                    }
                    if (!updatedSessionData.username && responseData.user.username) {
                      updatedSessionData.username = responseData.user.username;
                    }
                  }
                }
              } catch (e) {
                console.error('获取用户信息失败:', e);
              }
            }
            
            const deletedTime = new Date().toISOString();
            updatedSessionData.deleted_at = deletedTime;
            await localForage.setItem(key, updatedSessionData);
            // 持久化已删除会话快照，确保清空 IndexedDB 后首屏仍能显示
            deletedSnapshot[friendIdStr] = {
              nickname: updatedSessionData.nickname || '',
              avatarUrl: updatedSessionData.avatarUrl || null,
              deleted_at: deletedTime
            };
          }
        } catch (e) {
          console.error('更新好友deleted_at失败:', e);
        }
      }
    }

    const allFriends = [];
    // 构建服务端好友映射，用于合并 is_disturb 等字段
    const serverFriendMap = new Map();
    friends.forEach(f => serverFriendMap.set(String(f.id), f));

    for (const friendId of localFriendIdsFromKeys) {
      try {
        const key = `${prefix}-private-${friendId}`;
        const data = await localForage.getItem(key);
        if (data) {
          let friendNickname = data.nickname || '用户';
          
          if (!data.nickname) {
            try {
              const res = await getUserInfo(friendId);
              if (res.status === 200) {
                const responseData = res.data;
                if (responseData.status === 'success' && responseData.user) {
                  if (!data.nickname && responseData.user.nickname) {
                    friendNickname = responseData.user.nickname;
                    data.nickname = responseData.user.nickname;
                  }
                  if (!data.avatarUrl && responseData.user.avatar_url) {
                    data.avatarUrl = responseData.user.avatar_url;
                  }
                  if (!data.username && responseData.user.username) {
                    data.username = responseData.user.username;
                  }
                  const key = `${prefix}-private-${friendId}`;
                  const updatedData = { ...data };
                  await localForage.setItem(key, updatedData);
                }
              }
            } catch (e) {
              console.error('获取用户信息失败:', e);
            }
          }

          const serverFriend = serverFriendMap.get(friendId);
          const friend = {
            id: friendId,
            nickname: friendNickname,
            username: data.username || 'user',
            avatarUrl: data.avatarUrl ?? null,
            deleted_at: data.deleted_at ?? null,
            remark: data.remark || null,
            is_disturb: serverFriend ? serverFriend.is_disturb : null
          };
          
          if (data.last_message_time) {
            friend.last_message_time = data.last_message_time;
          }
          
          if (data.messages && data.messages.length > 0) {
            const validMessages = data.messages.filter(m => m.messageType !== 101 && m.messageType !== 102 && m.messageType !== 103);
            if (validMessages.length > 0) {
              friend.lastMessage = validMessages[validMessages.length - 1];
              if (!friend.last_message_time) {
                friend.last_message_time = validMessages[validMessages.length - 1].timestamp || new Date().toISOString();
              }
            }
          }
          
          allFriends.push(friend);
        }
      } catch (e) {
        console.error('从IndexedDB加载好友失败:', e);
      }
    }

    // 补入快照中的已删除会话（IndexedDB 已无该会话数据时，首次拉取也能显示）
    const loadedFriendIds = new Set(localFriendIdsFromKeys);
    Object.keys(deletedSnapshot).forEach(friendIdStr => {
      if (!loadedFriendIds.has(friendIdStr)) {
        const meta = deletedSnapshot[friendIdStr] || {};
        allFriends.push({
          id: Number(friendIdStr),
          nickname: meta.nickname || '用户',
          username: 'user',
          avatarUrl: meta.avatarUrl || null,
          deleted_at: meta.deleted_at || new Date().toISOString(),
          remark: null,
          is_disturb: null
        });
      }
    });

    friendStore.friendsList = allFriends;
    friendStore.sortFriendsByLastMessageTime();

    saveDeletedFriendSnapshot(deletedSnapshot);
  }

  if (typeof updateUnreadCountsDisplay === 'function') {
    updateUnreadCountsDisplay();
  }
  if (unreadStore && unreadStore.unreadMessages) {
    unreadStore.unreadMessages = { ...unreadStore.unreadMessages };
  }
}

// 进行中的添加好友请求去重：防止连击/重复触发并发提交，导致后端唯一键冲突
const addingFriendIds = new Set();

export function addFriend(userId, message = '') {
  const baseStore = useBaseStore();
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;

  if (!currentUser || !currentSessionToken) return;
  if (addingFriendIds.has(String(userId))) return;
  addingFriendIds.add(String(userId));

  apiAddFriend(userId, message).then(res => {
    const data = res.data;
    loadFriendsList();
    toast.success(data.message);
  })
  .catch(err => {
    toast.error(err.response?.data?.message || err.message || '操作失败');
  })
  .finally(() => {
    addingFriendIds.delete(String(userId));
  });
}

async function deleteFriend(userId) {
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  const friendStore = useFriendStore();
  const storageStore = useStorageStore();
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  
  if (!currentUser || !currentSessionToken) return;

  const confirmed = await modal.confirm('确定要删除这个好友吗？', '删除好友');
  if (confirmed) {
    removeFriend(userId).then(async res => {
      const data = res.data;
        if (storageStore && storageStore.deleteSingleDeletedSession) {
          // 彻底删除会话（含聊天记录、已删除快照），不留已删除标记
          await storageStore.deleteSingleDeletedSession('private', userId);
        }
        
        loadFriendsList();

        const currentPrivateChatUserId = sessionStore.currentPrivateChatUserId;
        if (currentPrivateChatUserId === userId) {
          const privateChatInterface = document.getElementById('privateChatInterface');
          const privateEmptyState = document.getElementById('privateEmptyState');
          if (privateChatInterface && privateEmptyState) {
            privateChatInterface.style.display = 'none';
            privateEmptyState.style.display = 'flex';
          }
        }

        toast.success('删除好友成功');
      })
      .catch(err => {
        toast.error('删除好友失败: ' + (err.response?.data?.message || err.message || '网络错误'));
      });
  }
}

function showUserProfile(user) {
  const friendStore = useFriendStore();
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  const modalStore = useModalStore();
  
  const currentFriend = friendStore?.friendsList?.find(f => String(f.id) === String(user.id));
  if (currentFriend && currentFriend.deleted_at != null) {
    if (modalStore && modalStore.openModal) {
      modalStore.openModal('userProfile', currentFriend);
    }
    return;
  }
  
  const currentUserInfo = baseStore.currentUser;
  const sessionToken = baseStore.currentSessionToken;

  getUserInfo(user.id).then(res => {
    const data = res.data;
      let fullUser = user;
      if (data.user) {
        fullUser = {
          id: data.user.id,
          username: data.user.username,
          nickname: data.user.nickname,
          gender: data.user.gender !== undefined ? data.user.gender : 0,
          signature: data.user.signature,
          friend_verification: data.user.friend_verification,
          last_online: data.user.last_online,
          avatarUrl: data.user.avatar_url || data.user.avatarUrl || data.user.avatar
        };
      }
      if (modalStore && modalStore.openModal) {
        modalStore.openModal('userProfile', fullUser);
      }
    })
    .catch(_error => {
      console.error('获取用户信息失败:', _error);
      if (modalStore && modalStore.openModal) {
        modalStore.openModal('userProfile', user);
      }
    });
}

function showUserAvatarPopup(event, user) {
  event.stopPropagation();
  openUserAvatarPopup(event, user);
}

function hideUserAvatarPopup() {
  closeUserAvatarPopup();
}

function searchUsers(keyword) {
  const baseStore = useBaseStore();
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  
  if (!currentUser || !currentSessionToken) return;

  apiSearchUsers(keyword).then(res => {
    const data = res.data;
      displaySearchResults(data.users);
    })
    .catch(err => {
      const searchResults = document.getElementById('searchResults');
      if (searchResults) {
        searchResults.innerHTML = '<div class="search-result-item">搜索失败: ' + (err.response?.data?.message || err.message || '未知错误') + '</div>';
      }
    });
}

function displaySearchResults(users) {
  const searchResults = document.getElementById('searchResults');
  if (!searchResults) return;

  const baseStore = useBaseStore();
  const currentUser = baseStore.currentUser;

  searchResults.innerHTML = '';

  if (users.length === 0) {
    searchResults.innerHTML = '<div class="search-result-item">未找到匹配的用户</div>';
    return;
  }

  users.forEach(user => {
    const resultItem = document.createElement('div');
    resultItem.className = 'search-result-item';

    let avatarUrl = '';
    if (user.avatarUrl && typeof user.avatarUrl === 'string') {
      avatarUrl = user.avatarUrl.trim();
    } else if (user.avatar_url && typeof user.avatar_url === 'string') {
      avatarUrl = user.avatar_url.trim();
    } else if (user.avatar && typeof user.avatar === 'string') {
      avatarUrl = user.avatar.trim();
    }

    if (avatarUrl) {
      const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
      if (!avatarUrl.match(imageExtensions) && !avatarUrl.includes('/avatar/') && !avatarUrl.includes('/upload/')) {
        avatarUrl = '';
      }
    }

    const nickname = user.nickname || '';
    const username = user.username || '';

    let avatarHtml = '';
    if (avatarUrl) {
      const isSvgAvatar = /\.svg$/i.test(avatarUrl);
      if (isSvgAvatar) {
        const initials = nickname ? nickname.charAt(0).toUpperCase() : 'U';
        avatarHtml = `<span class="user-avatar">${initials}</span>`;
      } else {
        const fullAvatarUrl = `${SERVER_URL}${avatarUrl}`;
        avatarHtml = `<span class="user-avatar"><img src="${fullAvatarUrl}" alt="${nickname}"></span>`;
      }
    } else {
      const initials = nickname ? nickname.charAt(0).toUpperCase() : 'U';
      avatarHtml = `<span class="user-avatar">${initials}</span>`;
    }

    resultItem.innerHTML = `
      ${avatarHtml}
      <div class="search-result-info">
        <div class="search-result-nickname">${nickname}</div>
        <div class="search-result-username">@${username}</div>
      </div>
      <button class="add-friend-btn" data-user-id="${user.id}" data-user-nickname="${user.nickname}" data-user-avatar="${avatarUrl}">+</button>
    `;

    const addFriendBtn = resultItem.querySelector('.add-friend-btn');
    addFriendBtn.addEventListener('click', () => {
      const defaultMsg = `我是${currentUser?.nickname || '用户'}`;
      if (user.friend_verification === false) {
        // 对方明确未开启好友验证，无需留言，直接发送
        addFriend(user.id, defaultMsg);
      } else {
        // 对方开启了好友验证（或信息未知时回退为弹窗留言，避免遗漏）
        const message = prompt('给对方留言：', defaultMsg);
        if (message !== null) {
          addFriend(user.id, message);
        }
      }
    });

    const resultAvatar = resultItem.querySelector('.user-avatar');
    resultAvatar.addEventListener('click', (e) => {
      e.stopPropagation();
      showUserAvatarPopup(e, user);
    });

    resultItem.addEventListener('click', (e) => {
      if (!e.target.classList.contains('add-friend-btn') && !e.target.closest('.user-avatar')) {
        showUserProfile(user);
      }
    });

    searchResults.appendChild(resultItem);
  });
}

function getMutedPrivateChats() {
    const mutedPrivateChats = localStorage.getItem('mutedPrivateChats');
    return mutedPrivateChats ? JSON.parse(mutedPrivateChats) : [];
}

function isPrivateMuted(userId) {
    try {
      const friendStore = useFriendStore();
      const friend = friendStore.friendsList.find(f => String(f.id) === String(userId));
      return friend ? friend.is_disturb == 1 : false;
    } catch {
      return false;
    }
}

function togglePrivateMute(userId) {
    const mutedPrivateChats = getMutedPrivateChats();
    const userIdStr = userId.toString();
    let updatedChats;

    if (mutedPrivateChats.includes(userIdStr)) {
        updatedChats = mutedPrivateChats.filter(id => id !== userIdStr);
    } else {
        updatedChats = [...mutedPrivateChats, userIdStr];
    }

    localStorage.setItem('mutedPrivateChats', JSON.stringify(updatedChats));
    updateUnreadCountsDisplay();
    return !mutedPrivateChats.includes(userIdStr);
}

export {
  switchToPrivateChat,
  initializePrivateChatInterface,
  loadPrivateChatHistory,
  loadFriendsList,
  updateFriendsList,
  deleteFriend,
  showUserProfile,
  showUserAvatarPopup,
  hideUserAvatarPopup,
  searchUsers,
  displaySearchResults,
  getMutedPrivateChats,
  isPrivateMuted,
  togglePrivateMute
};

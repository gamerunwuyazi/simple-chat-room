import localForage from 'localforage';
import { toRaw } from 'vue';

import modal from '../modal.js';

import { SERVER_URL, io, toast } from './config.js';
import { 
  loadGroupList, 
  updateGroupList,
  isGroupMuted
} from './group.js';
import { loadFriendsList, isPrivateMuted } from './private.js';
import {
  useBaseStore,
  useUserStore,
  useFriendStore,
  useGroupStore,
  usePublicStore,
  useModalStore,
  useSessionStore,
  useStorageStore,
  useUnreadStore,
  useDraftStore,
  useInputStore,
  setChatSocket,
  getChatSocket
} from '@/stores/index.js';
import { refreshTokenWithQueue } from './tokenManager.js';
import { 
  updateUnreadCountsDisplay, 
  logout
} from './ui.js';
import { navigateTo, getRouter } from './routerInstance.js';
import { resetLoadingState } from './upload.js';

// 判断用户当前页面是否在指定会话中（基于路由 + sessionStore，仅判断页面级焦点）
// 浏览器级焦点（document.hidden / document.hasFocus）由调用方单独判断
// 注意：路由 /chat/group 和 /chat/private 不带 ID 参数，会话 ID 存储在 sessionStore 中
function isUserActiveOnChat(chatType, chatId) {
  const sessionStore = useSessionStore();
  const router = getRouter();
  const currentPath = router?.currentRoute?.value?.path || window.location.pathname || '';

  if (chatType === 'public') {
    const isOnMainRoute = currentPath === '/chat' || currentPath === '/chat/' ||
      (currentPath.startsWith('/chat') && !currentPath.startsWith('/chat/group') && !currentPath.startsWith('/chat/private'));
    return isOnMainRoute;
  } else if (chatType === 'group') {
    const isOnGroupRoute = currentPath.startsWith('/chat/group') ||
      currentPath === '/chat/group' ||
      currentPath.startsWith('/chat/group/') ||
      currentPath.startsWith('/chat/group?');
    return isOnGroupRoute && sessionStore && String(sessionStore.currentGroupId) === String(chatId);
  } else if (chatType === 'private') {
    const isOnPrivateRoute = currentPath.startsWith('/chat/private') ||
      currentPath === '/chat/private' ||
      currentPath.startsWith('/chat/private/') ||
      currentPath.startsWith('/chat/private?');
    return isOnPrivateRoute && sessionStore && String(sessionStore.currentPrivateChatUserId) === String(chatId);
  }
  return false;
}


let avatarVersions = {};
let _lastMessageSendTime = 0;
let _messageSendTimeouts = {};

// ============================================
// 私信已读规则：
// 收到私信一律累加未读计数（不因聚焦而跳过）；
// 只有鼠标在右侧聊天区域(#chat-main)内移动/点击的那一刻，
// 才发送已读并清除前端未读计数（见 ui.js handlePrivateChatAreaInteraction）
// ============================================

function updateUserList(users) {
  if (!Array.isArray(users)) {
    console.error('Invalid users data:', users);
    users = [];
  }

  const userStore = useUserStore();
  const baseStore = useBaseStore();
  if (userStore) {
    const currentUserId = baseStore.currentUser?.id;
    
    const processedUsers = users.map(user => ({
      ...user,
      nickname: user.nickname
    }));
    
    const onlineUsers = processedUsers.filter(u => u.isOnline !== false);
    // 离线用户列表过滤掉当前用户
    const offlineUsers = processedUsers.filter(u => u.isOnline === false && String(u.id) !== String(currentUserId));
    userStore.onlineUsers = onlineUsers;
    userStore.offlineUsers = offlineUsers;
  }
}

// 保存 socket 实例以便断开连接
let socket = null;

// ============================================
// 拉取消息时 WS 消息缓冲机制
// 拉取离线消息期间收到的 WS 消息先入队列，拉取完成后再处理
// ============================================
let isPullingMessages = false;
let privateMessagesBuffer = [];
let groupMessagesBuffer = [];

function setPullingMessages(v) {
  isPullingMessages = v;
}

function waitForSocketConnection() {
  return new Promise((resolve) => {
    if (socket && socket.connected) {
      resolve();
    } else {
      socket.once('connect', () => resolve());
    }
  });
}

async function processAndClearBuffers() {
  // 关闭缓冲标志，否则 handler 中再次检查 isPullingMessages 会把消息重新入队
  isPullingMessages = false;

  const groupBuf = [...groupMessagesBuffer];
  groupMessagesBuffer = [];
  const privateBuf = [...privateMessagesBuffer];
  privateMessagesBuffer = [];

  // 通过 socket listeners 直接调用已注册的 handler 处理缓冲消息
  const groupListeners = socket.listeners('message-received');
  for (const msg of groupBuf) {
    for (const listener of groupListeners) {
      await listener(msg);
    }
  }

  const privateListeners = socket.listeners('private-message-received');
  for (const msg of privateBuf) {
    for (const listener of privateListeners) {
      await listener(msg);
    }
  }
}

function initializeWebSocket() {
    // 使用 Socket.io 连接到服务器
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        autoConnect: true
    });

    const userStore = useUserStore();
    const baseStore = useBaseStore();
    if (setChatSocket) {
        setChatSocket(socket);
    }

    // 启动清除未读事件轮询（10 秒一次，队列有内容才发送）
    const unreadStore = useUnreadStore();
    if (unreadStore && unreadStore.startUnreadClearPolling) {
        unreadStore.startUnreadClearPolling();
    }

    // 连接成功事件
    socket.on('connect', async () => {
        baseStore.isConnected = true;
        const sessionStore = useSessionStore();
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;

        if (currentUser && currentSessionToken) {
            // 发送user-joined事件进行认证和加入聊天
            // 后端会从数据库获取用户的真实信息（昵称、头像等）
            const joinedData = {
                userId: currentUser.id ? String(currentUser.id) : null,
                sessionToken: currentSessionToken
            };
            socket.emit('user-joined', joinedData);

            // 如果正在群组聊天，加入群组
            if (sessionStore.currentGroupId) {
                socket.emit('join-group', {
                    groupId: sessionStore.currentGroupId,
                    sessionToken: currentSessionToken,
                    userId: currentUser.id,
                    loadTime: Date.now()
                });
            }

            // 启用消息发送功能
            enableMessageSending();
        }
    });

    // 断开连接事件
    socket.on('disconnect', () => {
        baseStore.isConnected = false;
        // 禁用消息发送功能
        disableMessageSending();
    });

    // 重连成功事件 - 通过 Manager 对象监听
    socket.io.on('reconnect', async () => {
        const baseStore = useBaseStore();
        const storageStore = useStorageStore();
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;
        
        if (currentUser && currentSessionToken) {
            // 重连成功后拉取离线消息
            if (storageStore && storageStore.fetchAndMergeOfflineMessages) {
                try {
                    await storageStore.fetchAndMergeOfflineMessages(false);
                } catch (err) {
                    console.error('重连后拉取离线消息失败:', err);
                }
            }
        }
    });

    // 接收消息事件
    socket.on('message-received', async (message) => {
        // 检查消息中是否包含新的会话令牌
        const sessionStore = useSessionStore();
        if (message.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(message.sessionToken);
        }

        const userStore = useUserStore();
        const baseStore = useBaseStore();
        const friendStore = useFriendStore();
        const groupStore = useGroupStore();
        const publicStore = usePublicStore();
        const storageStore = useStorageStore();
        const unreadStore = useUnreadStore();
        
        // 如果在拉取消息中，将消息放入缓冲队列，等拉取完成后再处理
        if (isPullingMessages) {
            groupMessagesBuffer.push(message);
            return;
        }
        
        // 检查是否是类型101撤回消息
        if (message.messageType === 101) {
            let originalMessageId;
            let recallNickname = null;
            let recallerId = null;
            
            const isGroupRecall = !!message.groupId;

            if (isGroupRecall) {
                try {
                    const parsed = JSON.parse(message.content);
                    if (parsed && parsed.id) {
                        originalMessageId = String(parsed.id).trim();
                        if (parsed.nickname && typeof parsed.nickname === 'object' && !Array.isArray(parsed.nickname)) {
                            const keys = Object.keys(parsed.nickname);
                            if (keys.length > 0) {
                                recallerId = keys[0];
                                recallNickname = parsed.nickname[recallerId];
                            }
                        }
                    }
                } catch (e) {
                    originalMessageId = String(message.content).trim();
                }
            } else {
                originalMessageId = String(message.content).trim();
                recallerId = String(message.userId || message.senderId || '');
                recallNickname = message.nickname;
            }

            if (!originalMessageId || !storageStore) {
                return;
            }

            let computedRecallNickname = recallNickname;
            if (isGroupRecall && recallerId) {
                const members = groupStore.currentGroupMembers;
                if (members && Array.isArray(members) && members.length > 0) {
                    const recaller = members.find(m => String(m.id) === String(recallerId));
                    if (recaller) {
                        computedRecallNickname = recaller.group_nickname || recaller.nickname || recallNickname || '某人';
                    }
                }
            }

            // 先查找并替换引用该被撤回消息的消息
            if (storageStore.fixQuotedMessagesForWithdrawn) {
                if (isGroupRecall) {
                    if (storageStore.fullGroupMessages !== null && storageStore.fullGroupMessages !== undefined && storageStore.fullGroupMessages[message.groupId]) {
                        const messages = storageStore.fullGroupMessages[message.groupId];
                        const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                        updates.forEach(update => {
                            const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                            if (fullIndex !== -1) {
                                messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                            }
                            if (groupStore.groupMessages && groupStore.groupMessages[message.groupId]) {
                                const displayIndex = groupStore.groupMessages[message.groupId].findIndex(m => String(m.id) === String(update.messageId));
                                if (displayIndex !== -1) {
                                    groupStore.groupMessages[message.groupId][displayIndex] = toRaw({ ...toRaw(groupStore.groupMessages[message.groupId][displayIndex]), content: update.newContent });
                                }
                            }
                            groupStore.groupStored[message.groupId] = false;
                        });
                    }
                } else if (message.senderId && message.receiverId) {
                    const currentUser = baseStore.currentUser;
                    const msgSenderId = String(message.senderId);
                    const msgReceiverId = String(message.receiverId);
                    const chatPartnerId = String(currentUser?.id) === msgReceiverId ? msgSenderId : msgReceiverId;

                    if (storageStore.fullPrivateMessages !== null && storageStore.fullPrivateMessages !== undefined && storageStore.fullPrivateMessages[chatPartnerId]) {
                        const messages = storageStore.fullPrivateMessages[chatPartnerId];
                        const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                        updates.forEach(update => {
                            const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                            if (fullIndex !== -1) {
                                messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                            }
                            if (friendStore.privateMessages && friendStore.privateMessages[chatPartnerId]) {
                                const displayIndex = friendStore.privateMessages[chatPartnerId].findIndex(m => String(m.id) === String(update.messageId));
                                if (displayIndex !== -1) {
                                    friendStore.privateMessages[chatPartnerId][displayIndex] = toRaw({ ...toRaw(friendStore.privateMessages[chatPartnerId][displayIndex]), content: update.newContent });
                                }
                            }
                            friendStore.privateStored[chatPartnerId] = false;
                        });
                    }
                } else {
                    if (storageStore.fullPublicMessages !== null && storageStore.fullPublicMessages !== undefined) {
                        const messages = storageStore.fullPublicMessages;
                        const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                        updates.forEach(update => {
                            const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                            if (fullIndex !== -1) {
                                messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                            }
                            if (publicStore.publicMessages) {
                                const displayIndex = publicStore.publicMessages.findIndex(m => String(m.id) === String(update.messageId));
                                if (displayIndex !== -1) {
                                    publicStore.publicMessages[displayIndex] = toRaw({ ...toRaw(publicStore.publicMessages[displayIndex]), content: update.newContent });
                                }
                            }
                            publicStore.publicStored = false;
                        });
                    }
                }
            }

            // 构建撤回人昵称JSON存储格式：{撤回人id:撤回人昵称}
            // 如果没有recallerId，使用message中的userId作为后备
            const fallbackRecallerId = recallerId || String(message.userId || '');
            const fallbackRecallNickname = computedRecallNickname || message.nickname || '某人';
            const recallJson = fallbackRecallerId 
                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname }) 
                : '';

            // 根据被撤回消息ID找到原消息并标记为已撤回
            if (message.groupId) {                
                const groupMessages = storageStore.fullGroupMessages?.[message.groupId];

                if (groupMessages) {
                    const targetMsg = groupMessages.find(m => String(m.id) === originalMessageId);
                    
                    if (targetMsg) {
                        // 确保content使用正确的JSON格式
                        const finalContent = recallJson || (fallbackRecallerId 
                            ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                            : targetMsg.content);  // 如果都为空，保留原内容
                        
                        Object.assign(targetMsg, {
                            isRecalled: true,
                            isSystemMessage: true,
                            content: finalContent,
                            nickname: computedRecallNickname || message.nickname || targetMsg.nickname,
                            avatarUrl: message.avatarUrl || targetMsg.avatarUrl
                        });

                        // 直接更新groupStore中的消息
                        const groupMsgsRecv = groupStore.groupMessages?.[message.groupId];
                        if (groupMsgsRecv) {
                            const displayIdx = groupMsgsRecv.findIndex(m => String(m.id) === originalMessageId);
                            if (displayIdx !== -1) {
                                groupMsgsRecv[displayIdx] = toRaw({ ...toRaw(groupMsgsRecv[displayIdx]), ...targetMsg });
                            }
                        }

                        if (storageStore.saveGroupMessageToIndexedDB) {
                            storageStore.saveGroupMessageToIndexedDB(message.groupId, targetMsg);
                        }
                    }
                }

                if (groupStore && groupStore.groupsList) {
                    const group = groupStore.groupsList.find(g => String(g.id) === String(message.groupId));
                    if (group) {
                        const newTime = new Date(message.timestamp || Date.now()).toISOString();
                        group.last_message_time = newTime;
                        group.session_last_active_time = newTime;
                        group.lastMessage = {
                            ...message,
                            content: recallJson || (fallbackRecallerId 
                                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                : message.content),
                            nickname: computedRecallNickname || message.nickname || targetMsg?.nickname,
                            isRecalled: true
                        };
                        groupStore.sortGroupsByLastMessageTime();
                        if (storageStore.updateSessionLastMessageTime) {
                            storageStore.updateSessionLastMessageTime('group', message.groupId, newTime);
                        }
                    }
                }
            } else if (message.senderId && message.receiverId) {
                const currentUser = baseStore.currentUser;
                const msgSenderId = String(message.senderId);
                const msgReceiverId = String(message.receiverId);
                const chatPartnerId = String(currentUser?.id) === msgReceiverId ? msgSenderId : msgReceiverId;

                const privateMessages = storageStore.fullPrivateMessages?.[chatPartnerId];
                if (privateMessages) {
                    const targetMsg = privateMessages.find(m => String(m.id) === originalMessageId);
                    if (targetMsg) {
                        Object.assign(targetMsg, {
                            isRecalled: true,
                            isSystemMessage: true,
                            content: recallJson,
                            nickname: computedRecallNickname || message.nickname || targetMsg.nickname,
                            avatarUrl: message.avatarUrl || targetMsg.avatarUrl
                        });

                        // 直接更新friendStore中的消息
                        const friendMsgsRecv = friendStore.privateMessages?.[chatPartnerId];
                        if (friendMsgsRecv) {
                            const displayIdx = friendMsgsRecv.findIndex(m => String(m.id) === originalMessageId);
                            if (displayIdx !== -1) {
                                friendMsgsRecv[displayIdx] = toRaw({ ...toRaw(friendMsgsRecv[displayIdx]), ...targetMsg });
                            }
                        }

                        if (storageStore.savePrivateMessageToIndexedDB) {
                            storageStore.savePrivateMessageToIndexedDB(chatPartnerId, targetMsg);
                        }
                    }
                }

                if (friendStore && friendStore.friendsList) {
                    const friend = friendStore.friendsList.find(f => String(f.id) === String(chatPartnerId));
                    if (friend) {
                        const newTime = new Date(message.timestamp || Date.now()).toISOString();
                        friend.last_message_time = newTime;
                        friend.session_last_active_time = newTime;
                        friend.lastMessage = {
                            ...message,
                            content: recallJson,
                            nickname: computedRecallNickname || message.nickname || targetMsg?.nickname
                        };
                        friendStore.sortFriendsByLastMessageTime();
                        if (storageStore.updateSessionLastMessageTime) {
                            storageStore.updateSessionLastMessageTime('friend', chatPartnerId, newTime);
                        }
                    }
                }
            } else {
                const publicMessages = storageStore.fullPublicMessages;
                if (publicMessages) {
                    const targetMsg = publicMessages.find(m => String(m.id) === originalMessageId);
                    if (targetMsg) {
                        const finalContent = recallJson || (fallbackRecallerId 
                            ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                            : targetMsg.content);
                        
                        Object.assign(targetMsg, {
                            isRecalled: true,
                            isSystemMessage: true,
                            content: finalContent,
                            nickname: computedRecallNickname || message.nickname || targetMsg.nickname,
                            avatarUrl: message.avatarUrl || targetMsg.avatarUrl
                        });

                        // 直接更新publicStore中的消息
                        if (publicStore.publicMessages) {
                            const displayIdx = publicStore.publicMessages.findIndex(m => String(m.id) === originalMessageId);
                            if (displayIdx !== -1) {
                                publicStore.publicMessages[displayIdx] = toRaw({ ...toRaw(publicStore.publicMessages[displayIdx]), ...targetMsg });
                            }
                        }

                        if (storageStore.savePublicMessageToIndexedDB) {
                            storageStore.savePublicMessageToIndexedDB(targetMsg);
                        }
                    }
                }
            }

            if (message.id && storageStore.publicAndGroupMinId !== undefined) {
                if (message.id > storageStore.publicAndGroupMinId) {
                    storageStore.publicAndGroupMinId = message.id;
                    if (storageStore.saveMinIds) {
                        storageStore.saveMinIds();
                    }
                }
            }
            return;
        }

        // 检查是否是类型102用户信息更新消息
        if (message.messageType === 102) {
            try {
                const updateData = JSON.parse(message.content);
                const userId = message.userId;

                if (storageStore && storageStore.processUserInfoUpdateForRecallMessages) {
                    storageStore.processUserInfoUpdateForRecallMessages(userId, updateData);
                }

                // 同步撤回消息内容更新到显示 stores（processUserInfoUpdateForRecallMessages 只更新了持久化层）
                if (updateData.nickname && publicStore && publicStore.publicMessages) {
                    publicStore.publicMessages = publicStore.publicMessages.map(msg => {
                        if (msg.isRecalled && String(msg.userId) === String(userId)) {
                            const recallTextMatch = msg.content ? msg.content.match(/^(.+)撤回了一条消息$/) : null;
                            if (recallTextMatch) {
                                return { ...msg, content: `${updateData.nickname}撤回了一条消息` };
                            }
                        }
                        return msg;
                    });
                }
                if (updateData.nickname && groupStore && groupStore.groupMessages) {
                    for (const gId in groupStore.groupMessages) {
                        if (groupStore.groupMessages[gId] && groupStore.groupMessages[gId].length > 0) {
                            groupStore.groupMessages[gId] = groupStore.groupMessages[gId].map(msg => {
                                if (msg.isRecalled && String(msg.userId) === String(userId)) {
                                    const recallTextMatch = msg.content ? msg.content.match(/^(.+)撤回了一条消息$/) : null;
                                    if (recallTextMatch) {
                                        return { ...msg, content: `${updateData.nickname}撤回了一条消息` };
                                    }
                                }
                                return msg;
                            });
                        }
                    }
                }
                if (updateData.nickname && friendStore && friendStore.privateMessages) {
                    const privateMsgs = toRaw(friendStore.privateMessages);
                    Object.keys(privateMsgs).forEach(otherUserId => {
                        const messages = privateMsgs[otherUserId];
                        if (messages && Array.isArray(messages)) {
                            let hasChanges = false;
                            messages.forEach(msg => {
                                if (msg.isRecalled && (String(msg.senderId) === String(userId) || String(msg.userId) === String(userId))) {
                                    const recallTextMatch = msg.content ? msg.content.match(/^(.+)撤回了一条消息$/) : null;
                                    if (recallTextMatch) {
                                        msg.content = `${updateData.nickname}撤回了一条消息`;
                                        hasChanges = true;
                                    }
                                }
                            });
                            if (hasChanges) {
                                friendStore.privateMessages[otherUserId] = [...messages];
                            }
                        }
                    });
                }

                // ========== 处理全局用户信息更新的102消息 ==========

                // 1. 全局昵称更新（原有逻辑）
                if (updateData.type === 'nickname' && updateData.nickname) {
                    if (userStore && userStore.onlineUsers) {
                        const userIndex = userStore.onlineUsers.findIndex(u => String(u.id) === String(userId));
                        if (userIndex !== -1) {
                            userStore.onlineUsers[userIndex].nickname = updateData.nickname;
                        }
                    }
                    if (friendStore && friendStore.friendsList) {
                        const friendIndex = friendStore.friendsList.findIndex(f => String(f.id) === String(userId));
                        if (friendIndex !== -1) {
                            friendStore.friendsList[friendIndex].nickname = updateData.nickname;
                            friendStore.friendsList = [...friendStore.friendsList];
                        }
                    }
                    // 更新 IndexedDB 中的会话信息（无论好友是否已删除）
                    try {
                        const currentUser = baseStore.currentUser;
                        const userIdForStorage = currentUser?.id || 'guest';
                        const prefix = `chats-${userIdForStorage}`;
                        const key = `${prefix}-private-${userId}`;
                        const existingData = await localForage.getItem(key);
                        if (existingData) {
                            const updatedSessionData = { ...existingData };
                            updatedSessionData.nickname = updateData.nickname;
                            await localForage.setItem(key, updatedSessionData);
                        }
                    } catch (e) {
                        console.error('更新IndexedDB中的好友昵称失败:', e);
                    }
                    if (storageStore && storageStore.updateUserInfoInMessages) {
                        storageStore.updateUserInfoInMessages(userId, { nickname: updateData.nickname });
                    }
                    if (userStore && userStore.updateUserInfoInMessages) {
                        userStore.updateUserInfoInMessages(userId, { nickname: updateData.nickname });
                    }
                    if (friendStore && friendStore.privateMessages) {
                        const privateMsgs = toRaw(friendStore.privateMessages);
                        Object.keys(privateMsgs).forEach(otherUserId => {
                            const messages = privateMsgs[otherUserId];
                            if (messages && Array.isArray(messages)) {
                                let hasChanges = false;
                                messages.forEach(msg => {
                                    if (String(msg.senderId) === String(userId)) {
                                        msg.nickname = updateData.nickname;
                                        hasChanges = true;
                                    }
                                });
                                if (hasChanges) {
                                    friendStore.privateMessages[otherUserId] = [...messages];
                                }
                            }
                        });
                    }
                    // 更新 baseStore.currentUser（如果更新的是自己）
                    if (baseStore && baseStore.currentUser && String(baseStore.currentUser.id) === String(userId) && updateData.nickname) {
                        baseStore.setCurrentUser({ ...baseStore.currentUser, nickname: updateData.nickname });
                    }
                    // 更新 groupStore.currentGroupMembers
                    if (groupStore && groupStore.currentGroupMembers && groupStore.currentGroupMembers.length > 0 && updateData.nickname) {
                        let memberChanged = false;
                        groupStore.currentGroupMembers.forEach((m, idx) => {
                            if (String(m.id) === String(userId)) {
                                groupStore.currentGroupMembers[idx].nickname = updateData.nickname;
                                memberChanged = true;
                            }
                        });
                        if (memberChanged) {
                            groupStore.currentGroupMembers = [...groupStore.currentGroupMembers];
                        }
                    }
                    // 更新 sessionStore 当前私聊对象信息
                    if (sessionStore && updateData.nickname) {
                        if (sessionStore.currentPrivateChatUserId && String(sessionStore.currentPrivateChatUserId) === String(userId)) {
                            sessionStore.currentPrivateChatNickname = updateData.nickname;
                        }
                    }
                } else if (updateData.type === 'avatar' && (updateData.avatarUrl || updateData.avatar_url)) {
                    const avatarUrl = updateData.avatarUrl || updateData.avatar_url;
                    if (userStore && userStore.onlineUsers) {
                        const userIndex = userStore.onlineUsers.findIndex(u => String(u.id) === String(userId));
                        if (userIndex !== -1) {
                            userStore.onlineUsers[userIndex].avatar = avatarUrl;
                            userStore.onlineUsers[userIndex].avatarUrl = avatarUrl;
                            userStore.onlineUsers[userIndex].avatar_url = avatarUrl;
                        }
                    }
                    if (friendStore && friendStore.friendsList) {
                        const friendIndex = friendStore.friendsList.findIndex(f => String(f.id) === String(userId));
                        if (friendIndex !== -1) {
                            friendStore.friendsList[friendIndex].avatarUrl = avatarUrl;
                            friendStore.friendsList[friendIndex].avatar_url = avatarUrl;
                            friendStore.friendsList[friendIndex].avatar = avatarUrl;
                            friendStore.friendsList = [...friendStore.friendsList];
                        }
                    }
                    // 更新 IndexedDB 中的会话信息（无论好友是否已删除）
                    try {
                        const currentUser = baseStore.currentUser;
                        const userIdForStorage = currentUser?.id || 'guest';
                        const prefix = `chats-${userIdForStorage}`;
                        const key = `${prefix}-private-${userId}`;
                        const existingData = await localForage.getItem(key);
                        if (existingData) {
                            const updatedSessionData = { ...existingData };
                            updatedSessionData.avatarUrl = avatarUrl;
                            await localForage.setItem(key, updatedSessionData);
                        }
                    } catch (e) {
                        console.error('更新IndexedDB中的好友头像失败:', e);
                    }
                    if (storageStore && storageStore.updateUserInfoInMessages) {
                        storageStore.updateUserInfoInMessages(userId, { avatarUrl });
                    }
                    if (userStore && userStore.updateUserInfoInMessages) {
                        userStore.updateUserInfoInMessages(userId, { avatarUrl });
                    }
                    if (friendStore && friendStore.privateMessages) {
                        const privateMsgs = toRaw(friendStore.privateMessages);
                        Object.keys(privateMsgs).forEach(otherUserId => {
                            const messages = privateMsgs[otherUserId];
                            if (messages && Array.isArray(messages)) {
                                let hasChanges = false;
                                messages.forEach(msg => {
                                    if (String(msg.senderId) === String(userId)) {
                                        msg.avatarUrl = avatarUrl;
                                        hasChanges = true;
                                    }
                                });
                                if (hasChanges) {
                                    friendStore.privateMessages[otherUserId] = [...messages];
                                }
                            }
                        });
                    }
                    // 更新 baseStore.currentUser（如果更新的是自己）
                    if (baseStore && baseStore.currentUser && String(baseStore.currentUser.id) === String(userId)) {
                        baseStore.setCurrentUser({ ...baseStore.currentUser, avatarUrl: avatarUrl });
                    }
                    // 更新 groupStore.currentGroupMembers
                    if (groupStore && groupStore.currentGroupMembers && groupStore.currentGroupMembers.length > 0) {
                        let memberChanged = false;
                        groupStore.currentGroupMembers.forEach((m, idx) => {
                            if (String(m.id) === String(userId)) {
                                groupStore.currentGroupMembers[idx].avatarUrl = avatarUrl;
                                memberChanged = true;
                            }
                        });
                        if (memberChanged) {
                            groupStore.currentGroupMembers = [...groupStore.currentGroupMembers];
                        }
                    }
                    // 更新 sessionStore 当前私聊对象头像
                    if (sessionStore && sessionStore.currentPrivateChatUserId && String(sessionStore.currentPrivateChatUserId) === String(userId)) {
                        sessionStore.currentPrivateChatAvatarUrl = avatarUrl;
                    }
                }
            } catch (e) {
                console.error('解析102消息失败:', e);
            }
            
            // 添加102消息到store（公共消息）
            if (publicStore && publicStore.addPublicMessage) {
                publicStore.addPublicMessage(message);
            }
            
            // 更新对应的 minId
            if (message.id && storageStore && storageStore.publicAndGroupMinId !== undefined) {
                if (message.id > storageStore.publicAndGroupMinId) {
                    storageStore.publicAndGroupMinId = message.id;
                    if (storageStore.saveMinIds) {
                        storageStore.saveMinIds();
                    }
                }
            }
            
            return;
        }
        
        // 更新对应的 minId（只对非撤回消息）
        if (message.id && storageStore && storageStore.publicAndGroupMinId !== undefined) {
            if (message.id > storageStore.publicAndGroupMinId) {
                storageStore.publicAndGroupMinId = message.id;
                if (storageStore.saveMinIds) {
                    storageStore.saveMinIds();
                }
            }
        }
        
        const currentUser = baseStore.currentUser;
        
        // 检查消息是否包含群组 ID
        if (message.groupId) {
            // 添加消息到 store
            if (groupStore && groupStore.addGroupMessage) {
                groupStore.addGroupMessage(message.groupId, message);
            }
            
            // 检查@通知
            if (message.atUserid && currentUser) {
                const atUserIds = Array.isArray(message.atUserid) ? message.atUserid : [message.atUserid];
                const isCurrentUserAt = atUserIds.some(id => String(id) === String(currentUser.id) || String(id) === '-1');
                // 页面聚焦且正处于该群组会话时，仍弹 toast，但不标记@我（避免替换标题）
                const isPageVisibleForAt = !document.hidden && document.hasFocus();
                const isFocusedOnThisGroup = isUserActiveOnChat('group', String(message.groupId)) && isPageVisibleForAt;
                if (isCurrentUserAt) {
                    // 查找群组名称
                    let groupName = '未知群组';
                    if (groupStore && groupStore.groupsList) {
                        const group = groupStore.groupsList.find(g => String(g.id) === String(message.groupId));
                        if (group) {
                            groupName = group.name;
                        }
                    }
                    toast.info(`群组 ${groupName} 有@你的消息`);
                    // 仅在未聚焦于该群组会话时，设置@我标记（用于替换标题）
                    if (!isFocusedOnThisGroup && groupStore && groupStore.setGroupHasAtMe) {
                        groupStore.setGroupHasAtMe(message.groupId);
                    }
                }
            }
            
            // 更新群组最后消息时间并重新排序
            if (groupStore && groupStore.groupsList) {
                const group = groupStore.groupsList.find(g => String(g.id) === String(message.groupId));
                if (group) {
                    const newTime = new Date(message.timestamp || Date.now()).toISOString();
                    group.last_message_time = newTime;
                    group.session_last_active_time = newTime;
                    group.lastMessage = message;
                    groupStore.sortGroupsByLastMessageTime();
                    if (storageStore.updateSessionLastMessageTime) {
                        storageStore.updateSessionLastMessageTime('group', message.groupId, newTime);
                    }
                }
            }
            
            // 更新群组未读计数
            // 核心规则：页面级焦点（路由 + sessionStore）+ 浏览器级焦点（document.hidden / document.hasFocus）

            const isOwnMessage = String(currentUser.id) === String(message.userId);
            const groupIdStr = String(message.groupId);
            const isPageVisible = !document.hidden && document.hasFocus();

            const isGroupMutedLocal = typeof isGroupMuted === 'function' && isGroupMuted(message.groupId);

            // 页面级焦点（路由 + sessionStore）+ 浏览器级焦点
            const isUserFocusedOnThisGroupChat = isUserActiveOnChat('group', groupIdStr) && isPageVisible;
            const shouldAddGroupUnread = !isOwnMessage && !isUserFocusedOnThisGroupChat && !isGroupMutedLocal;

            if (shouldAddGroupUnread) {
                if (unreadStore && unreadStore.incrementGroupUnread) {
                    unreadStore.incrementGroupUnread(message.groupId);
                }
                updateUnreadCountsDisplay();
            } else if (!isOwnMessage && !isGroupMutedLocal) {
                // 跳过添加未读计数时（且非免打扰群组），把该群组放入清除未读队列，由轮询统一发送
                if (unreadStore && unreadStore.enqueueUnreadClear) {
                    unreadStore.enqueueUnreadClear('group', message.groupId);
                }
                updateUnreadCountsDisplay();
            }

            // 如果当前打开的是该群组，将群组移到顶部
            if (isUserFocusedOnThisGroupChat) {
                if (groupStore && groupStore.moveGroupToTop) {
                    groupStore.moveGroupToTop(message.groupId);
                }
            }
        } else {
            // 添加公共消息到 store
            if (publicStore && publicStore.addPublicMessage) {
                publicStore.addPublicMessage(message);
            }
            
            // 检查@通知
            if (message.atUserid && currentUser) {
                const atUserIds = Array.isArray(message.atUserid) ? message.atUserid : [message.atUserid];
                const isCurrentUserAt = atUserIds.some(id => String(id) === String(currentUser.id));
                // 页面聚焦且正处于主聊天室会话时，仍弹 toast，但不标记@我（避免替换标题）
                const isPageVisibleForAt = !document.hidden && document.hasFocus();
                const isFocusedOnPublic = isUserActiveOnChat('public', null) && isPageVisibleForAt;
                if (isCurrentUserAt) {
                    toast.info('主聊天室有@你的消息');
                    // 仅在未聚焦于主聊天室会话时，设置@我标记（用于替换标题）
                    if (!isFocusedOnPublic && unreadStore && unreadStore.setPublicHasAtMe) {
                        unreadStore.setPublicHasAtMe();
                    }
                }
            }
            
            // 更新公共聊天未读计数
            // 核心规则：页面级焦点（路由 + sessionStore）+ 浏览器级焦点（document.hidden / document.hasFocus）

            const isOwnMessage = String(currentUser.id) === String(message.userId);
            const isPageVisible = !document.hidden && document.hasFocus();

            // 页面级焦点（路由 + sessionStore）+ 浏览器级焦点
            const isUserFocusedOnPublicChat = isUserActiveOnChat('public', null) && isPageVisible;
            const shouldAddUnread = !isOwnMessage && !isUserFocusedOnPublicChat;

            if (shouldAddUnread) {
                if (unreadStore && unreadStore.incrementGlobalUnread) {
                    unreadStore.incrementGlobalUnread();
                }
                updateUnreadCountsDisplay();
            } else if (!isOwnMessage) {
                // 跳过添加未读计数时，把主聊天室放入清除未读队列，由轮询统一发送
                if (unreadStore && unreadStore.enqueueUnreadClear) {
                    unreadStore.enqueueUnreadClear('global');
                }
                updateUnreadCountsDisplay();
            }
        }
    });

    // 接收消息发送确认事件 - 根据确认事件渲染消息
    socket.on('message-sent', (data) => {
        const groupStore = useGroupStore();
        const publicStore = usePublicStore();
        const storageStore = useStorageStore();
        const draftStore = useDraftStore();

        // 检查是否包含错误（如速率限制）
        if (data.success === false && data.error) {
            toast && toast.error(data.error.message || '操作失败');
            return;
        }

        // 检查是否包含完整的消息数据
        if (data.message && data.messageId) {
            const confirmedMessage = data.message;
            
            // 检查是否是类型101撤回消息
            if (confirmedMessage.messageType === 101) {
                let originalMessageId;
                let recallNickname = null;
                let recallerId = null;
                
                const isGroupRecall = !!confirmedMessage.groupId;

                if (isGroupRecall) {
                    try {
                        const parsed = JSON.parse(confirmedMessage.content);
                        if (parsed && parsed.id) {
                            originalMessageId = String(parsed.id).trim();
                            if (parsed.nickname && typeof parsed.nickname === 'object' && !Array.isArray(parsed.nickname)) {
                                const keys = Object.keys(parsed.nickname);
                                if (keys.length > 0) {
                                    recallerId = keys[0];
                                    recallNickname = parsed.nickname[recallerId];
                                }
                            }
                        } else {
                            originalMessageId = String(confirmedMessage.content).trim();
                        }
                    } catch (e) {
                        originalMessageId = String(confirmedMessage.content).trim();
                    }
                } else {
                    originalMessageId = String(confirmedMessage.content).trim();
                    recallerId = String(confirmedMessage.userId || confirmedMessage.senderId || '');
                    recallNickname = confirmedMessage.nickname;
                }

                if (!originalMessageId || !storageStore) {
                    return;
                }

                let computedRecallNickname = recallNickname;
                if (isGroupRecall && recallerId) {
                    const members = groupStore.currentGroupMembers;
                    if (members && Array.isArray(members) && members.length > 0) {
                        const recaller = members.find(m => String(m.id) === String(recallerId));
                        if (recaller) {
                            computedRecallNickname = recaller.group_nickname || recaller.nickname || recallNickname || '某人';
                        }
                    }
                }

                // 先查找并替换引用该消息的消息
                if (storageStore.fixQuotedMessagesForWithdrawn) {
                    if (isGroupRecall) {
                        // 群组消息 - 从 fullGroupMessages 中查找
                        if (storageStore.fullGroupMessages !== null && storageStore.fullGroupMessages !== undefined && storageStore.fullGroupMessages[confirmedMessage.groupId]) {
                            const messages = storageStore.fullGroupMessages[confirmedMessage.groupId];
                            const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                            updates.forEach(update => {
                                const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                                if (fullIndex !== -1) {
                                    messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                                }
                                if (groupStore.groupMessages && groupStore.groupMessages[confirmedMessage.groupId]) {
                                    const displayIndex = groupStore.groupMessages[confirmedMessage.groupId].findIndex(m => String(m.id) === String(update.messageId));
                                    if (displayIndex !== -1) {
                                        groupStore.groupMessages[confirmedMessage.groupId][displayIndex] = toRaw({ ...toRaw(groupStore.groupMessages[confirmedMessage.groupId][displayIndex]), content: update.newContent });
                                    }
                                }
                                groupStore.groupStored[confirmedMessage.groupId] = false;
                            });
                        }
                    } else {
                        // 公共消息 - 从 fullPublicMessages 中查找
                        if (storageStore.fullPublicMessages !== null && storageStore.fullPublicMessages !== undefined) {
                            const messages = storageStore.fullPublicMessages;
                            const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                            updates.forEach(update => {
                                const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                                if (fullIndex !== -1) {
                                    messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                                }
                                if (publicStore.publicMessages) {
                                    const displayIndex = publicStore.publicMessages.findIndex(m => String(m.id) === String(update.messageId));
                                    if (displayIndex !== -1) {
                                        publicStore.publicMessages[displayIndex] = toRaw({ ...toRaw(publicStore.publicMessages[displayIndex]), content: update.newContent });
                                    }
                                }
                                publicStore.publicStored = false;
                            });
                        }
                    }
                }

                // 构建撤回人昵称JSON存储格式：{撤回人id:撤回人昵称}
                // 如果没有recallerId，使用confirmedMessage中的userId作为后备
                const fallbackRecallerId = recallerId || String(confirmedMessage.userId || '');
                const fallbackRecallNickname = computedRecallNickname || confirmedMessage.nickname || '某人';
                const recallJson = fallbackRecallerId 
                    ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname }) 
                    : '';

                // 根据被撤回消息ID找到原消息并标记为已撤回
                if (confirmedMessage.groupId) {                    
                    // 群组消息撤回
                    const groupMessages = storageStore.fullGroupMessages?.[confirmedMessage.groupId];
                    if (groupMessages) {
                        const targetMsg = groupMessages.find(m => String(m.id) === originalMessageId);
                        
                        if (targetMsg) {
                            // 确保content使用正确的JSON格式
                            const finalContent = recallJson || (fallbackRecallerId 
                                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                : targetMsg.content);
                            
                            // 标记为已撤回并应用系统样式，使用JSON格式存储
                            Object.assign(targetMsg, {
                                isRecalled: true,
                                isSystemMessage: true,
                                content: finalContent,  // JSON格式：{userId: 昵称}
                                nickname: computedRecallNickname || confirmedMessage.nickname || targetMsg.nickname,
                                avatarUrl: confirmedMessage.avatarUrl || targetMsg.avatarUrl
                            });

                            // 触发UI更新 - 直接更新groupStore中的消息
                            const groupMsgs = groupStore.groupMessages?.[confirmedMessage.groupId];
                            if (groupMsgs) {
                                const displayIndex = groupMsgs.findIndex(m => String(m.id) === originalMessageId);
                                if (displayIndex !== -1) {
                                    groupMsgs[displayIndex] = toRaw({ ...toRaw(groupMsgs[displayIndex]), ...targetMsg });
                                }
                            }

                            // 持久化到IndexedDB（更新现有记录，保持JSON格式）
                            if (storageStore.saveGroupMessageToIndexedDB) {
                                storageStore.saveGroupMessageToIndexedDB(confirmedMessage.groupId, targetMsg);
                            }
                        }
                    }

                    // 更新群组会话的最后消息时间
                    if (groupStore && groupStore.groupsList) {
                        const group = groupStore.groupsList.find(g => String(g.id) === String(confirmedMessage.groupId));
                        if (group) {
                            const newTime = new Date(confirmedMessage.timestamp || Date.now()).toISOString();
                            group.last_message_time = newTime;
                            group.session_last_active_time = newTime;
                            group.lastMessage = {
                                ...confirmedMessage,
                                content: recallJson || (fallbackRecallerId 
                                    ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                    : confirmedMessage.content),  // JSON格式
                                nickname: computedRecallNickname || confirmedMessage.nickname || targetMsg?.nickname,
                                isRecalled: true
                            };
                            groupStore.sortGroupsByLastMessageTime();
                            if (storageStore.updateSessionLastMessageTime) {
                                storageStore.updateSessionLastMessageTime('group', confirmedMessage.groupId, newTime);
                            }
                        }
                    }
                } else {
                    // 公共消息撤回
                    const publicMessages = storageStore.fullPublicMessages;
                    if (publicMessages) {
                        const targetMsg = publicMessages.find(m => String(m.id) === originalMessageId);
                        if (targetMsg) {
                            const finalContent = recallJson || (fallbackRecallerId 
                                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                : targetMsg.content);
                            
                            // 标记为已撤回并应用系统样式，使用JSON格式存储
                            Object.assign(targetMsg, {
                                isRecalled: true,
                                isSystemMessage: true,
                                content: finalContent,  // JSON格式：{userId: 昵称}
                                nickname: computedRecallNickname || confirmedMessage.nickname || targetMsg.nickname,
                                avatarUrl: confirmedMessage.avatarUrl || targetMsg.avatarUrl
                            });

                            // 触发UI更新 - 直接更新publicStore中的消息
                            if (publicStore.publicMessages) {
                                const displayIndex = publicStore.publicMessages.findIndex(m => String(m.id) === originalMessageId);
                                if (displayIndex !== -1) {
                                    publicStore.publicMessages[displayIndex] = toRaw({ ...toRaw(publicStore.publicMessages[displayIndex]), ...targetMsg });
                                }
                            }

                            // 持久化到IndexedDB（更新现有记录，保持JSON格式）
                            if (storageStore.savePublicMessageToIndexedDB) {
                                storageStore.savePublicMessageToIndexedDB(targetMsg);
                            }
                        }
                    }

                    // 更新公共聊天最后消息时间（如果有lastMessage机制）
                }
                return;
            }
            
            // 更新对应的 minId
            if (confirmedMessage.id && storageStore && storageStore.publicAndGroupMinId !== undefined) {
                if (confirmedMessage.id > storageStore.publicAndGroupMinId) {
                    storageStore.publicAndGroupMinId = confirmedMessage.id;
                    if (storageStore.saveMinIds) {
                        storageStore.saveMinIds();
                    }
                }
            }
            
            // 检查消息中是否包含群组 ID
            if (confirmedMessage.groupId) {
                // 群组消息
                const groupId = String(confirmedMessage.groupId);
                
                // 添加确认后的消息到 store
                if (groupStore && groupStore.addGroupMessage) {
                    groupStore.addGroupMessage(groupId, confirmedMessage);
                }
                
                // 更新群组最后消息时间并重新排序（与 message-received 事件保持一致）
                if (groupStore && groupStore.groupsList) {
                    const group = groupStore.groupsList.find(g => String(g.id) === String(groupId));
                    if (group) {
                        const newTime = new Date(confirmedMessage.timestamp || Date.now()).toISOString();
                        group.last_message_time = newTime;
                        group.session_last_active_time = newTime;
                        group.lastMessage = confirmedMessage;
                        groupStore.sortGroupsByLastMessageTime();
                        if (storageStore && storageStore.updateSessionLastMessageTime) {
                            storageStore.updateSessionLastMessageTime('group', groupId, newTime);
                        }
                    }
                }
                
                // 将群组移到列表顶部
                if (groupStore && groupStore.moveGroupToTop) {
                    groupStore.moveGroupToTop(groupId);
                }
                
                // 清空群组草稿
                if (draftStore && draftStore.clearDraft) {
                    draftStore.clearDraft('group', groupId);
                }
            } else {
                // 公共消息
                // 添加确认后的消息到 store
                if (publicStore && publicStore.addPublicMessage) {
                    publicStore.addPublicMessage(confirmedMessage);
                }

                // 更新公共聊天最后消息时间到 IndexedDB
                if (storageStore && storageStore.updateSessionLastMessageTime && confirmedMessage.messageType !== 101 && confirmedMessage.messageType !== 103) {
                    const newTime = new Date(confirmedMessage.timestamp || Date.now()).toISOString();
                    storageStore.updateSessionLastMessageTime('public', null, newTime);
                }
                
                // 清空公共聊天草稿
                const inputStore = useInputStore();
                if (inputStore) {
                    inputStore.mainMessageInput = '';
                }
            }
        }
    });

    // 用户列表更新事件（仅加入聊天室时单播返回的完整在线列表，整体替换）
    socket.on('users-list', (data) => {
        const onlineUsers = Array.isArray(data?.online) ? data.online : [];
        updateUserList(onlineUsers);
    });

    // 用户上线广播事件（含用户信息）。
    // 用户自己加入时也会收到自己的上线广播，但完整列表中已包含自己，按 id 去重避免重复添加
    socket.on('user-online', (data) => {
        if (!data || data.id === undefined || data.id === null) return;
        const idStr = String(data.id);
        const existingIndex = userStore.onlineUsers.findIndex(u => String(u.id) === idStr);
        if (existingIndex === -1) {
            userStore.onlineUsers.push({
                id: data.id,
                nickname: data.nickname,
                avatarUrl: data.avatarUrl,
                gender: data.gender,
                isOnline: true
            });
        }
        // 从离线列表中移除（若存在）
        const offlineIndex = userStore.offlineUsers.findIndex(u => String(u.id) === idStr);
        if (offlineIndex !== -1) {
            userStore.offlineUsers.splice(offlineIndex, 1);
        }
    });

    // 用户下线广播事件（含用户信息）
    socket.on('user-offline', (data) => {
        if (!data || data.id === undefined || data.id === null) return;
        const idStr = String(data.id);
        const onlineIndex = userStore.onlineUsers.findIndex(u => String(u.id) === idStr);
        if (onlineIndex !== -1) {
            userStore.onlineUsers.splice(onlineIndex, 1);
        }
        // 当前离线列表不包含自己，仅补充其他用户
        if (onlineIndex !== -1 && String(baseStore.currentUser?.id) !== idStr) {
            const offlineIndex = userStore.offlineUsers.findIndex(u => String(u.id) === idStr);
            if (offlineIndex === -1) {
                userStore.offlineUsers.push({
                    id: data.id,
                    nickname: data.nickname,
                    avatarUrl: data.avatarUrl,
                    isOnline: false,
                    lastOnline: new Date().toISOString()
                });
            }
        }
    });

    // 群组列表更新事件
    socket.on('group-list', (groups) => {
        updateGroupList(groups);
    });

    // 群组创建事件
    socket.on('group-created', async (data) => {
        const groupStore = useGroupStore();
        const storageStore = useStorageStore();

        // 先等待群组列表刷新完成
        await loadGroupList();

        // 保存群组名称和头像到 IndexedDB
        if (data && data.groupId) {
            try {
                const userId = baseStore.currentUser?.id || 'guest';
                const prefix = `chats-${userId}`;
                const key = `${prefix}-group-${data.groupId}`;
                const existingData = await localForage.getItem(key);
                const updatedSessionData = existingData ? { ...existingData } : { messages: [] };
                if (data.groupName) updatedSessionData.name = data.groupName;
                if (data.groupAvatarUrl) updatedSessionData.avatarUrl = data.groupAvatarUrl;
                else if (data.group_avatar_url) updatedSessionData.avatarUrl = data.group_avatar_url;
                await localForage.setItem(key, updatedSessionData);
            } catch (e) {
                console.error('保存群组信息到 IndexedDB 失败:', e);
            }
        }

        // 更新群组最后消息，保证创建消息参与排序
        if (data && data.createMessage && groupStore && groupStore.groupsList) {
            const group = groupStore.groupsList.find(g => String(g.id) === String(data.groupId));
            if (group) {
                const msg = data.createMessage;
                const newTime = new Date(msg.timestamp || Date.now()).toISOString();
                group.last_message_time = newTime;
                group.session_last_active_time = newTime;
                group.lastMessage = msg;
                groupStore.sortGroupsByLastMessageTime();
                if (storageStore.updateSessionLastMessageTime) {
                    storageStore.updateSessionLastMessageTime('group', data.groupId, newTime);
                }
            }
        }
    });

    // 群组删除事件
    socket.on('group-deleted', (data) => {
        // 加载群组列表
        loadGroupList();
    });

    // 群组解散事件
    socket.on('group-dissolved', async (data) => {
        const groupStore = useGroupStore();
        const baseStore = useBaseStore();
        const unreadStore = useUnreadStore();
        const sessionStore = useSessionStore();

        if (data && data.groupId) {
            if (groupStore && groupStore.markGroupAsDeleted) {
                groupStore.markGroupAsDeleted(data.groupId, true);
            }
            // 把解散状态记录到 IndexedDB
            try {
                const currentUser = baseStore.currentUser;
                const userIdForStorage = currentUser?.id || 'guest';
                const prefix = `chats-${userIdForStorage}`;
                const key = `${prefix}-group-${data.groupId}`;
                const existingData = await localForage.getItem(key);
                if (existingData) {
                    const updatedSessionData = { ...existingData };
                    updatedSessionData.deleted_at = new Date().toISOString();
                    await localForage.setItem(key, updatedSessionData);
                }
            } catch (e) {
                console.error('记录群组解散状态到 IndexedDB 失败:', e);
            }
            // 清除该群组的未读消息记录
            if (unreadStore && unreadStore.clearGroupUnread) {
                unreadStore.clearGroupUnread(data.groupId);
            }
            // 如果当前活动群组就是解散的群组，清空当前群组
            if (sessionStore && String(sessionStore.currentGroupId) === String(data.groupId)) {
                sessionStore.setCurrentGroupId(null);
            }
        }
    });

    // 群组成员添加事件
    socket.on('members-added', (data) => {
        const sessionStore = useSessionStore();

        // 刷新群组列表
        loadGroupList();
        // 如果是当前正在查看的群组，触发事件更新成员列表
        if (data && data.groupId) {
            if (sessionStore && String(sessionStore.currentGroupId) === String(data.groupId)) {
                // 
                window.dispatchEvent(new CustomEvent('group-members-changed', { 
                    detail: { groupId: data.groupId, action: 'added', data: data } 
                }));
            }
        }
    });

    // 群组成员移除事件
    socket.on('member-removed', (data) => {
        const baseStore = useBaseStore();
        const groupStore = useGroupStore();
        const sessionStore = useSessionStore();

        // 刷新群组列表
        loadGroupList();
        // 如果是自己被移除，清空当前群组并标记会话为已删除
        // 注意：后端发送的字段是 memberId，不是 userId
        const removedUserId = data.memberId || data.userId;
        if (data && data.groupId && removedUserId) {
            // 如果是自己被移除，标记会话为已删除
            if (baseStore && String(baseStore.currentUser?.id) === String(removedUserId)) {
                if (groupStore.markGroupAsDeleted) {
                    groupStore.markGroupAsDeleted(data.groupId, false);
                }
                // 如果当前活动群组就是这个群组，清空当前群组
                if (String(sessionStore.currentGroupId) === String(data.groupId)) {
                    sessionStore.setCurrentGroupId(null);
                }
            }
            // 如果是当前正在查看的群组，触发事件更新成员列表
            if (sessionStore && String(sessionStore.currentGroupId) === String(data.groupId)) {
                window.dispatchEvent(new CustomEvent('group-members-changed', { 
                    detail: { groupId: data.groupId, action: 'removed', data: data } 
                }));
            }
        }
    });

    // 好友添加事件
    socket.on('friend-added', async (data) => {
        const baseStore = useBaseStore();
        const friendStore = useFriendStore();

        // 先等待好友列表刷新完成
        await loadFriendsList();
        
        // 保存添加好友的时间到最后消息时间记录
        if (data && data.friendId) {
            // 如果该好友本地已标记删除，则删除deleted_at标记，并保存好友信息
            try {
                const userId = baseStore.currentUser?.id || 'guest';
                const prefix = `chats-${userId}`;
                const key = `${prefix}-private-${data.friendId}`;
                const existingData = await localForage.getItem(key);
                const updatedSessionData = existingData ? { ...existingData } : { messages: [] };
                
                // 保存好友信息到 IndexedDB
                if (data.nickname) updatedSessionData.nickname = data.nickname;
                if (data.username) updatedSessionData.username = data.username;
                if (data.avatarUrl) updatedSessionData.avatarUrl = data.avatarUrl;
                else if (data.avatar_url) updatedSessionData.avatarUrl = data.avatar_url;
                
                // 移除 deleted_at 标记
                delete updatedSessionData.deleted_at;
                
                await localForage.setItem(key, updatedSessionData);
            } catch (e) {
                console.error('更新好友会话信息失败:', e);
            }
            
            if (friendStore.friendsList) {
                const friend = friendStore.friendsList.find(f => String(f.id) === String(data.friendId));
                if (friend && friend.deleted_at) {
                    delete friend.deleted_at;
                }
            }
        }
    });

    // 好友请求列表更新事件
    socket.on('friend-requests-updated', async (data) => {
        const baseStore = useBaseStore();

        // 重新加载好友请求列表
        if (baseStore.loadFriendRequests) {
            await baseStore.loadFriendRequests();
        }
    });

    // 收到新的好友请求通知
    socket.on('friend-request-received', async (data) => {
        const baseStore = useBaseStore();

        // 重新加载收到的好友请求列表
        if (baseStore.loadFriendRequests) {
            await baseStore.loadFriendRequests();
        }
    });

    // 好友请求被拒绝通知
    socket.on('friend-request-rejected', async (data) => {
        const baseStore = useBaseStore();

        // 重新加载发送的好友请求列表
        if (baseStore.loadFriendRequests) {
            await baseStore.loadFriendRequests();
        }
    });

    // 被添加到群组事件
    socket.on('added-to-group', async (data) => {
        const baseStore = useBaseStore();
        const groupStore = useGroupStore();

        // 先等待群组列表刷新完成
        await loadGroupList();
        
        // 如果该群组本地已标记删除，则删除deleted_at标记，并保存群组信息
        if (data && data.groupId) {
            try {
                const userId = baseStore.currentUser?.id || 'guest';
                const prefix = `chats-${userId}`;
                const key = `${prefix}-group-${data.groupId}`;
                const existingData = await localForage.getItem(key);
                const updatedSessionData = existingData ? { ...existingData } : { messages: [] };
                
                // 保存群组信息到 IndexedDB
                if (data.groupName) updatedSessionData.name = data.groupName;
                if (data.groupAvatarUrl) updatedSessionData.avatarUrl = data.groupAvatarUrl;
                
                // 移除 deleted_at 标记
                delete updatedSessionData.deleted_at;
                
                await localForage.setItem(key, updatedSessionData);
            } catch (e) {
                console.error('更新群组会话信息失败:', e);
            }
            
            if (groupStore.groupsList) {
                const group = groupStore.groupsList.find(g => String(g.id) === String(data.groupId));
                if (group && group.deleted_at) {
                    delete group.deleted_at;
                }
            }
        }
    });

    // 好友删除事件
    socket.on('friend-removed', async (data) => {
        const friendStore = useFriendStore();
        const unreadStore = useUnreadStore();
        const sessionStore = useSessionStore();

        if (data && data.friendId) {
            if (friendStore && friendStore.markFriendAsDeleted) {
                friendStore.markFriendAsDeleted(data.friendId);
            }
            // 清除该好友的未读私信消息记录
            if (unreadStore && unreadStore.clearPrivateUnread) {
                unreadStore.clearPrivateUnread(data.friendId);
            }
            // 如果当前打开的私信就是删除的好友，清空当前私信
            if (sessionStore && String(sessionStore.currentPrivateChatUserId) === String(data.friendId)) {
                sessionStore.setCurrentPrivateChatUserId(null);
            }
        }
    });

    // 群管理员变更事件
    socket.on('group-admin-changed', (data) => {
        if (data && data.groupId) {
            window.dispatchEvent(new CustomEvent('group-members-changed', { 
                detail: { groupId: data.groupId, action: 'admin-changed', data: data } 
            }));
        }
    });

    // 头像更新事件
    // 群头像更新事件
    socket.on('group-avatar-updated', async (data) => {
        const groupStore = useGroupStore();
        const storageStore = useStorageStore();
        const baseStore = useBaseStore();
        const modalStore = useModalStore();

        if (data.groupId && data.avatarUrl) {
            // 更新群组列表中的头像
            if (groupStore && groupStore.groupsList) {
                const groupIndex = groupStore.groupsList.findIndex(g => String(g.id) === String(data.groupId));
                if (groupIndex !== -1) {
                    groupStore.groupsList[groupIndex].avatar_url = data.avatarUrl;
                    groupStore.groupsList[groupIndex].avatarUrl = data.avatarUrl;
                    // 触发响应式更新
                    groupStore.groupsList = [...groupStore.groupsList];
                }
            }
            
            // 更新群组消息中该群组的头像（群名片等）
            if (storageStore && storageStore.updateGroupInfoInMessages) {
                storageStore.updateGroupInfoInMessages(data.groupId, { avatarUrl: data.avatarUrl });
            }
            
            // 更新 IndexedDB 中的群组会话信息
            try {
                const currentUser = baseStore.currentUser;
                const userIdForStorage = currentUser?.id || 'guest';
                const prefix = `chats-${userIdForStorage}`;
                const key = `${prefix}-group-${data.groupId}`;
                const existingData = await localForage.getItem(key);
                if (existingData) {
                    const updatedSessionData = { ...existingData };
                    updatedSessionData.avatarUrl = data.avatarUrl;
                    await localForage.setItem(key, updatedSessionData);
                }
            } catch (e) {
                console.error('更新IndexedDB中的群组头像失败:', e);
            }
            
            // 如果当前正在该群组聊天中，更新群组信息模态框中的头像
            if (modalStore && modalStore.modalData && modalStore.modalData.groupInfo && 
                String(modalStore.modalData.groupInfo.id) === String(data.groupId)) {
                modalStore.modalData.groupInfo.avatar_url = data.avatarUrl;
            }
        }
    });

    // 群昵称更新专用事件
    socket.on('group-nickname-updated', async (data) => {
        const groupStore = useGroupStore();
        const baseStore = useBaseStore();
        const storageStore = useStorageStore();

        if (!data.userId || !data.groupId) {
            return;
        }

        const sessionStore = useSessionStore();
        const currentGroupId = sessionStore.currentGroupId;
        const newNickname = data.action === 'update_group_nickname' ? data.newNickname : null;
        const groupNicknameValue = data.groupNickname || data.newNickname;

        // 更新群组最后消息的 groupNickname（无论是否在当前群组）
        if (groupStore && groupStore.groupsList) {
            const group = groupStore.groupsList.find(g => String(g.id) === String(data.groupId));
            if (group && group.lastMessage) {
                const isTargetUserMsg = String(group.lastMessage.userId) === String(data.userId);
                const isType100 = group.lastMessage.messageType === 100;
                const isType101 = group.lastMessage.messageType === 101 || group.lastMessage.isRecalled;

                // 判断是否要更新内容中的昵称：发送者匹配，或 100/101 消息内容中包含该用户
                let shouldUpdateContent = isTargetUserMsg;
                if (isType100 || isType101) {
                    try {
                        const contentParsed = JSON.parse(group.lastMessage.content);
                        if (contentParsed && typeof contentParsed === 'object' && contentParsed[String(data.userId)] !== undefined) {
                            shouldUpdateContent = true;
                        }
                    } catch (e) {}
                }

                if (shouldUpdateContent) {
                    const newDisplayName = groupNicknameValue || data.nickname;

                    // 更新群昵称（所有消息类型都需要）
                    if (isTargetUserMsg) {
                        if (groupNicknameValue) {
                            group.lastMessage.groupNickname = groupNicknameValue;
                        } else {
                            group.lastMessage.groupNickname = null;
                        }
                    }

                    // 101 撤回消息 - 替换内容中的昵称
                    if (isType101) {
                        try {
                            const contentParsed = JSON.parse(group.lastMessage.content);
                            if (contentParsed.id && contentParsed.nickname && typeof contentParsed.nickname === 'object') {
                                contentParsed.nickname[String(data.userId)] = newDisplayName;
                            } else {
                                contentParsed[String(data.userId)] = newDisplayName;
                            }
                            group.lastMessage.content = JSON.stringify(contentParsed);
                        } catch (e) {}
                    }

                    // 100 系统消息 - 替换内容中的昵称
                    if (isType100) {
                        try {
                            const parsed = JSON.parse(group.lastMessage.content);
                            if (parsed && parsed.action && parsed[String(data.userId)] !== undefined) {
                                parsed[String(data.userId)] = newDisplayName;
                                group.lastMessage.content = JSON.stringify(parsed);
                            }
                        } catch {}
                    }
                }
            }
        }

        // 同时更新 storageStore 中的消息
        if (storageStore && storageStore.fullGroupMessages) {
            const groupIdStr = String(data.groupId);
            if (storageStore.fullGroupMessages[groupIdStr]) {
                const messages = storageStore.fullGroupMessages[groupIdStr];
                let updatedCount = 0;
                let lastMessageUpdated = false;
                let newLastMessageContent = null;
                const updatedMessages = [];
                for (const msg of messages) {
                    if (String(msg.userId) === String(data.userId)) {
                        updatedCount++;
                        // 使用 toRaw 确保数据可被 IndexedDB 克隆
                        const rawMsg = toRaw(msg);
                        
                        // 同步更新 stored groupNickname（有群昵称则设置，没有则清除）
                        const groupNicknameValue = data.groupNickname || data.newNickname;
                        if (groupNicknameValue) {
                            rawMsg.groupNickname = groupNicknameValue;
                        } else {
                            rawMsg.groupNickname = null;
                        }

                        if (rawMsg.messageType === 100) {
                            try {
                                const parsed = JSON.parse(rawMsg.content);
                                if (parsed && parsed.action && parsed[String(data.userId)] !== undefined) {
                                    const newDisplayName = groupNicknameValue || data.nickname;
                                    parsed[String(data.userId)] = newDisplayName;
                                    rawMsg.content = JSON.stringify(parsed);
                                }
                            } catch {}
                        }

                        if (rawMsg.isRecalled || rawMsg.messageType === 101) {
                            try {
                                const contentParsed = JSON.parse(rawMsg.content);
                                if (contentParsed && typeof contentParsed === 'object') {
                                    const newDisplayName = groupNicknameValue || data.nickname;
                                    if (contentParsed.id && contentParsed.nickname && typeof contentParsed.nickname === 'object') {
                                        if (contentParsed.nickname[String(data.userId)] !== undefined) {
                                            contentParsed.nickname[String(data.userId)] = newDisplayName;
                                            rawMsg.content = JSON.stringify(contentParsed);
                                        }
                                    } else if (contentParsed[String(data.userId)] !== undefined) {
                                        contentParsed[String(data.userId)] = newDisplayName;
                                        rawMsg.content = JSON.stringify(contentParsed);
                                    }
                                }
                            } catch {}
                        }

                        updatedMessages.push(rawMsg);

                        // 检查是否是最后一条有效消息（非101/102/103类型）
                        const isLastIndex = messages.indexOf(msg) === messages.length - 1;
                        if (isLastIndex && ![101, 102, 103].includes(rawMsg.messageType)) {
                            lastMessageUpdated = true;
                            newLastMessageContent = {
                                ...rawMsg,
                                content: rawMsg.content
                            };
                        }
                    } else if (msg.messageType === 100 || msg.messageType === 101 || msg.isRecalled) {
                        // 非发送者匹配但 100/101 消息内容中包含该用户，只更新内容不更新 groupNickname
                        const rawMsg = toRaw(msg);
                        try {
                            const newDisplayName = data.groupNickname || data.newNickname || data.nickname;
                            const contentParsed = JSON.parse(rawMsg.content);
                            if (contentParsed && typeof contentParsed === 'object') {
                                let contentUpdated = false;
                                if (contentParsed.id && contentParsed.nickname && typeof contentParsed.nickname === 'object') {
                                    if (contentParsed.nickname[String(data.userId)] !== undefined) {
                                        contentParsed.nickname[String(data.userId)] = newDisplayName;
                                        contentUpdated = true;
                                    }
                                } else if (contentParsed[String(data.userId)] !== undefined) {
                                    contentParsed[String(data.userId)] = newDisplayName;
                                    contentUpdated = true;
                                }
                                if (contentUpdated) {
                                    rawMsg.content = JSON.stringify(contentParsed);
                                }
                            }
                        } catch (e) {}
                        updatedMessages.push(rawMsg);
                    } else {
                        updatedMessages.push(msg);
                    }
                }
                storageStore.fullGroupMessages[groupIdStr] = updatedMessages;

                // 如果最后消息被更新且是撤回消息，同步更新群组的lastMessage
                if (lastMessageUpdated && newLastMessageContent && groupStore && groupStore.groupsList) {
                    const group = groupStore.groupsList.find(g => String(g.id) === String(data.groupId));
                    if (group && group.lastMessage) {
                        group.lastMessage = newLastMessageContent;
                    }
                }
            }
        }

        // 强制持久化 + 触发响应式更新（确保 storageStore 循环的变更通过新数组引用触发 Vue 响应式）
        if (data.groupId) {
            const gId = String(data.groupId);
            if (groupStore && groupStore.groupMessages && groupStore.groupMessages[gId]) {
                groupStore.groupMessages[gId] = [...groupStore.groupMessages[gId]];
            }
            if (storageStore) {
                storageStore.saveToStorage();
            }

            // 触发侧边栏响应式更新（确保 group.lastMessage 的嵌套属性变更能被 Vue 检测）
            if (groupStore && groupStore.groupsList) {
                groupStore.groupsList = [...groupStore.groupsList];
            }
        }

        // 仅处理当前群组的成员列表更新
        if (currentGroupId && String(currentGroupId) === String(data.groupId)) {
            if (groupStore && groupStore.currentGroupMembers) {
                const memberIndex = groupStore.currentGroupMembers.findIndex(
                    m => String(m.id) === String(data.userId)
                );

                if (memberIndex !== -1) {
                    groupStore.currentGroupMembers[memberIndex].group_nickname = newNickname;

                    // 触发 Vue 响应式更新
                    groupStore.currentGroupMembers = [...groupStore.currentGroupMembers];
                }
            }
        }
    });

    // IP封禁事件
    socket.on('ip-banned', async (data) => {
        // 显示封禁提示
        let banMessage = `您的 IP 已被封禁\n\n原因：${data.reason || '违反使用规则'}`;
        if (data.expiresAt) {
            const expireDate = new Date(data.expiresAt);
            banMessage += `\n\n解封时间：${expireDate.toLocaleString('zh-CN')}`;
        } else {
            banMessage += '\n\n封禁类型：永久封禁';
        }
        
        try {
            await modal.error(banMessage, 'IP 已被封禁');
        } finally {
            logout();
        }
    });

    // 用户封禁事件
    socket.on('user-banned', async (data) => {
        // 显示封禁提示
        let banMessage = `您的账户已被封禁\n\n原因：${data.reason || '违反使用规则'}`;
        if (data.expiresAt) {
            const expireDate = new Date(data.expiresAt);
            banMessage += `\n\n解封时间：${expireDate.toLocaleString('zh-CN')}`;
        } else {
            banMessage += '\n\n封禁类型：永久封禁';
        }
        
        try {
            await modal.error(banMessage, '账户已被封禁');
        } finally {
            logout();
        }
    });

    // 统一加载消息事件（替代原来的三个事件）
    socket.on('messages-loaded', async (data) => {
        const sessionStore = useSessionStore();
        const publicStore = usePublicStore();
        const groupStore = useGroupStore();
        const baseStore = useBaseStore();
        const friendStore = useFriendStore();
        const unreadStore = useUnreadStore();

        // 检查响应中是否包含新的会话令牌
        if (data.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(data.sessionToken);
        }
        
        if (data.type === 'global') {
            // 全局聊天室消息 - 完全复刻 chat-history 事件
            if (publicStore && data.messages) {
                if (data.loadMore && publicStore.prependPublicMessages) {
                    publicStore.prependPublicMessages(data.messages);
                } else if (publicStore.setPublicMessages) {
                    publicStore.setPublicMessages(data.messages);
                }
                
                // 检查是否加载更多时返回了空数组或消息数少于20条，标记为已全部加载
                if (data.loadMore) {
                    const isAllLoaded = !data.messages || data.messages.length < 20 || data.messages.length === 0;
                    if (isAllLoaded && publicStore.setPublicAllLoaded) {
                        publicStore.setPublicAllLoaded(true);
                    }
                    resetLoadingState('public');
                }
            }

            if (data.groupLastMessageTimes && Object.keys(data.groupLastMessageTimes).length > 0) {
                if (groupStore && groupStore.groupsList) {
                    const userId = baseStore.currentUser?.id || 'guest';
                    const prefix = `chats-${userId}`;
                    
                    const groups = groupStore.groupsList;
                    for (const group of groups) {
                        const lastTime = data.groupLastMessageTimes[group.id];
                        if (lastTime) {
                            const time = lastTime instanceof Date ? lastTime.toISOString() : new Date(lastTime).toISOString();
                            group.last_message_time = time;
                            group.session_last_active_time = time;
                            
                            // 保存到 IndexedDB
                            try {
                                const key = `${prefix}-group-${group.id}`;
                                const existingData = await localForage.getItem(key);
                                if (existingData) {
                                    const updatedData = { ...existingData };
                                    updatedData.last_message_time = time;
                                    await localForage.setItem(key, updatedData);
                                }
                            } catch (e) {
                                console.error('保存群组最后消息时间到IndexedDB失败:', e);
                            }
                        }
                    }
                    groupStore.sortGroupsByLastMessageTime();
                }
            }

            if (data.privateLastMessageTimes && Object.keys(data.privateLastMessageTimes).length > 0) {
                if (friendStore && friendStore.friendsList) {
                    const userId = baseStore.currentUser?.id || 'guest';
                    const prefix = `chats-${userId}`;
                    
                    const friends = friendStore.friendsList;
                    for (const friend of friends) {
                        const lastTime = data.privateLastMessageTimes[friend.id];
                        if (lastTime) {
                            const time = lastTime instanceof Date ? lastTime.toISOString() : new Date(lastTime).toISOString();
                            friend.last_message_time = time;
                            friend.session_last_active_time = time;
                            
                            try {
                                const key = `${prefix}-private-${friend.id}`;
                                const existingData = await localForage.getItem(key);
                                if (existingData) {
                                    const updatedData = { ...existingData };
                                    updatedData.last_message_time = time;
                                    await localForage.setItem(key, updatedData);
                                }
                            } catch (e) {
                                console.error('保存好友最后消息时间到IndexedDB失败:', e);
                            }
                        }
                    }
                    friendStore.sortFriendsByLastMessageTime();
                }
            }

            updateUnreadCountsDisplay();
        } else if (data.type === 'group') {
            // 群组消息 - 完全复刻 group-chat-history 事件
            const groupId = data.groupId || sessionStore.currentGroupId;
            if (groupStore && data.messages && groupId) {
                if (data.loadMore && groupStore.prependGroupMessages) {
                    groupStore.prependGroupMessages(groupId, data.messages);
                } else if (groupStore.setGroupMessages) {
                    groupStore.setGroupMessages(groupId, data.messages);
                }
                
                // 检查是否加载更多时返回了空数组或消息数少于20条，标记为已全部加载
                if (data.loadMore) {
                    const isAllLoaded = !data.messages || data.messages.length < 20 || data.messages.length === 0;
                    if (isAllLoaded && groupStore.setGroupAllLoaded) {
                        groupStore.setGroupAllLoaded(groupId, true);
                    }
                    resetLoadingState('group-' + groupId);
                }
            }

            // 清除该群组的未读计数（免打扰群组除外）
            if (unreadStore && unreadStore.clearGroupUnread && groupId) {
                const group = groupStore.groupsList?.find(g => String(g.id) === String(groupId));
                if (!group || group.is_disturb != 1) {
                    unreadStore.clearGroupUnread(groupId);
                }
            }
            updateUnreadCountsDisplay();
        } else if (data.type === 'private') {
            // 私信消息 - 完全复刻 private-chat-history 事件
            

            let userId = data.friendId || data.userId || sessionStore.currentPrivateChatUserId;
            
            const currentUser = baseStore.currentUser;
            
            if (!userId && data.messages && data.messages.length > 0) {
                const firstMessage = data.messages[0];
                const msgSenderId = String(firstMessage.senderId);
                const msgReceiverId = String(firstMessage.receiverId);
                userId = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
                
            }

            if (data.loadMore && userId) {
                
                const isAllLoaded = !data.messages || data.messages.length < 20 || data.messages.length === 0;
                
                if (isAllLoaded) {
                    if (friendStore && friendStore.setPrivateAllLoaded) {
                        friendStore.setPrivateAllLoaded(userId, true);
                    }
                }
                resetLoadingState('private-' + userId);
            }

            if (friendStore && data.messages && userId) {
                if (data.loadMore && friendStore.prependPrivateMessages) {
                    friendStore.prependPrivateMessages(userId, data.messages);
                } else if (friendStore.setPrivateMessages) {
                    friendStore.setPrivateMessages(userId, data.messages);
                }
            }

            // 清除该私信的未读计数（免打扰私信除外）
            if (unreadStore && unreadStore.clearPrivateUnread && userId) {
                const friend = friendStore.friendsList?.find(f => String(f.id) === String(userId));
                if (!friend || friend.is_disturb != 1) {
                    unreadStore.clearPrivateUnread(userId);
                }
            }
            updateUnreadCountsDisplay();
        }
    });

    // 聊天历史记录事件
    socket.on('chat-history', async (data) => {
        const sessionStore = useSessionStore();
        const publicStore = usePublicStore();
        const groupStore = useGroupStore();
        const baseStore = useBaseStore();
        const friendStore = useFriendStore();
        const unreadStore = useUnreadStore();

        // 检查历史记录响应中是否包含新的会话令牌
        if (data.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(data.sessionToken);
        }

        if (publicStore && data.messages) {
            if (data.loadMore && publicStore.prependPublicMessages) {
                publicStore.prependPublicMessages(data.messages);
            } else if (publicStore.setPublicMessages) {
                publicStore.setPublicMessages(data.messages);
            }
        }

        // 处理群组最后消息时间
        if (data.groupLastMessageTimes && Object.keys(data.groupLastMessageTimes).length > 0) {
            // 更新群组列表中的最后消息时间
            if (groupStore && groupStore.groupsList) {
                const userId = baseStore.currentUser?.id || 'guest';
                const prefix = `chats-${userId}`;
                
                const groups = groupStore.groupsList;
                for (const group of groups) {
                    const lastTime = data.groupLastMessageTimes[group.id];
                    if (lastTime) {
                        const time = lastTime instanceof Date ? lastTime.toISOString() : new Date(lastTime).toISOString();
                        group.last_message_time = time;
                        group.session_last_active_time = time;
                        
                        // 保存到 IndexedDB
                        try {
                            const key = `${prefix}-group-${group.id}`;
                            const existingData = await localForage.getItem(key);
                            if (existingData) {
                                const updatedData = { ...existingData };
                                updatedData.last_message_time = time;
                                await localForage.setItem(key, updatedData);
                            }
                        } catch (e) {
                            console.error('保存群组最后消息时间到IndexedDB失败:', e);
                        }
                    }
                }
                // 重新排序
                groupStore.sortGroupsByLastMessageTime();
            }
        }

        // 处理私信最后消息时间
        if (data.privateLastMessageTimes && Object.keys(data.privateLastMessageTimes).length > 0) {
            // 更新好友列表中的最后消息时间
            if (friendStore && friendStore.friendsList) {
                const userId = baseStore.currentUser?.id || 'guest';
                const prefix = `chats-${userId}`;
                
                const friends = friendStore.friendsList;
                for (const friend of friends) {
                    const lastTime = data.privateLastMessageTimes[friend.id];
                    if (lastTime) {
                        const time = lastTime instanceof Date ? lastTime.toISOString() : new Date(lastTime).toISOString();
                        friend.last_message_time = time;
                        friend.session_last_active_time = time;
                        
                        try {
                            const key = `${prefix}-private-${friend.id}`;
                            const existingData = await localForage.getItem(key);
                            if (existingData) {
                                const updatedData = { ...existingData };
                                updatedData.last_message_time = time;
                                await localForage.setItem(key, updatedData);
                            }
                        } catch (e) {
                            console.error('保存好友最后消息时间到IndexedDB失败:', e);
                        }
                    }
                }
                // 重新排序
                friendStore.sortFriendsByLastMessageTime();
            }
        }

        // 更新未读计数显示
        updateUnreadCountsDisplay();
    });

    // 用户加入聊天室响应事件
    socket.on('user-joined-response', (data) => {
        const sessionStore = useSessionStore();
        const unreadStore = useUnreadStore();

        // 检查响应中是否包含新的会话令牌
        if (data.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(data.sessionToken);
        }

        // 从本地存储加载未读消息计数（不再依赖后端）
        if (unreadStore && unreadStore.loadUnreadMessages) {
            unreadStore.loadUnreadMessages();
        }

        // 更新未读计数显示
        updateUnreadCountsDisplay();
    });

    // 登录成功响应事件
    socket.on('login-success', (data) => {
        const sessionStore = useSessionStore();

        // 检查响应中是否包含新的会话令牌
        if (data.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(data.sessionToken);
        }
    });

    // 连接关闭事件
    socket.on('disconnect', () => {
        baseStore.isConnected = false;
        // 禁用消息发送功能
        disableMessageSending();
    });

    // 连接错误事件
    socket.on('error', () => {
        baseStore.isConnected = false;
        disableMessageSending();
    });

    // 处理原始WebSocket消息
    // 服务器可能会直接发送["session-expired"]格式的消息
    socket.on('message', async (data) => {
        // 检查是否是会话过期消息
        if (Array.isArray(data) && data[0] === 'session-expired') {
            const eventData = data[1];
            await handleSessionExpired(eventData);
        }
    });

    // 会话过期事件
    socket.on('session-expired', async (eventData) => {
        await handleSessionExpired(eventData);
    });

    // 处理会话过期的公共函数
    async function handleSessionExpired(eventData) {
        // 检查是否在发送消息后 5 秒内
        const now = Date.now();
        const lastSendTime = _lastMessageSendTime || 0;
        const isWithin5Seconds = now - lastSendTime < 5000;
        
        if (isWithin5Seconds) {
            // 重置所有消息发送计时器
            if (_messageSendTimeouts) {
                for (const key in _messageSendTimeouts) {
                    clearTimeout(_messageSendTimeouts[key]);
                }
                _messageSendTimeouts = {};
            }
        }
        
        // 检查是否有原始事件信息（无论是否在 5 秒内都要处理）
        if (eventData && eventData.originalEventName && eventData.originalEventData) {
            // 有原始事件信息，刷新 Token 后重新发送
            try {
                const refreshSuccess = await refreshTokenWithQueue();
                
                if (refreshSuccess) {
                    // 刷新成功，更新原始事件数据中的 token 并重新发送
                    const newToken = localStorage.getItem('currentSessionToken');
                    const newEventData = { ...eventData.originalEventData };
                    
                    // 更新 sessionToken
                    if (newToken) {
                        newEventData.sessionToken = newToken;
                    }
                    
                    // 重新发送原始事件
                    socket.emit(eventData.originalEventName, newEventData);
                } else {
                    // 刷新失败才退出登录
                    try {
                        await modal.warning('您的会话已过期或在其他设备登录，请重新登录', '会话过期');
                    } finally {
                        logout();
                    }
                }
            } catch (error) {
                console.error('刷新 Token 失败:', error);
                try {
                    await modal.warning('您的会话已过期或在其他设备登录，请重新登录', '会话过期');
                } finally {
                    logout();
                }
            }
        } else if (!isWithin5Seconds) {
            // 没有原始事件信息且超过 5 秒，正常刷新 Token
            try {
                const refreshSuccess = await refreshTokenWithQueue();
                
                if (!refreshSuccess) {
                    // 刷新失败才退出登录
                    try {
                        await modal.warning('您的会话已过期或在其他设备登录，请重新登录', '会话过期');
                    } finally {
                        logout();
                    }
                }
            } catch (error) {
                console.error('刷新 Token 失败:', error);
                try {
                    await modal.warning('您的会话已过期或在其他设备登录，请重新登录', '会话过期');
                } finally {
                    logout();
                }
            }
        }
    }

    // 账户在其他设备登录事件（顶号）
    socket.on('account-logged-in-elsewhere', async (data) => {
        try {
            await modal.warning(data.message || '您的账号在其他设备上登录，请重新登录', '账号异地登录');
        } finally {
            logout();
        }
    });

    // 账户被封禁事件
    socket.on('account-banned', async (data) => {
        const message = `您的账户已被封禁\n\n${data.message || '无法访问'}`;
        try {
            await modal.error(message, '账户被封禁');
        } finally {
            logout();
        }
    });

    // 监听群组名称更新事件
    socket.on('group-name-updated', async (data) => {
        const baseStore = useBaseStore();
        const sessionStore = useSessionStore();

        // 只有登录状态才刷新群组列表
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;
        if (currentUser && currentSessionToken) {
            loadGroupList();
            
            // 如果有数据并且是当前群组，更新相关状态
            if (data && data.groupId && data.newGroupName) {
                if (sessionStore && String(sessionStore.currentGroupId) === String(data.groupId)) {
                    sessionStore.currentGroupName = data.newGroupName;
                }
                
                // 更新 sessionStore
                if (sessionStore && String(sessionStore.currentGroupId) === String(data.groupId)) {
                    sessionStore.currentGroupName = data.newGroupName;
                }
                
                // 更新 DOM 元素
                const currentGroupNameElement = document.getElementById('currentGroupName');
                if (currentGroupNameElement) {
                    currentGroupNameElement.textContent = data.newGroupName;
                }
                const modalGroupName = document.getElementById('modalGroupName');
                if (modalGroupName) {
                    modalGroupName.textContent = `${data.newGroupName} - 群组信息`;
                }
                
                // 更新 IndexedDB 中的群组会话信息
                try {
                    const userIdForStorage = currentUser?.id || 'guest';
                    const prefix = `chats-${userIdForStorage}`;
                    const key = `${prefix}-group-${data.groupId}`;
                    const existingData = await localForage.getItem(key);
                    if (existingData) {
                        const updatedSessionData = { ...existingData };
                        updatedSessionData.name = data.newGroupName;
                        await localForage.setItem(key, updatedSessionData);
                    }
                } catch (e) {
                    console.error('更新IndexedDB中的群组名称失败:', e);
                }
            }
        }
    });

    // 监听群组公告更新事件
    socket.on('group-description-updated', (data) => {
        const baseStore = useBaseStore();

        // 只有登录状态才刷新群组列表
        const currentUser = baseStore.currentUser;
        const currentSessionToken = baseStore.currentSessionToken;
        if (currentUser && currentSessionToken) {
            loadGroupList();

            // 如果当前正在查看该群组的信息模态框，更新公告显示
            const modal = document.getElementById('groupInfoModal');
            if (modal && modal.style.display === 'flex') {
                const modalGroupNoticeValue = document.getElementById('modalGroupNoticeValue');
                if (modalGroupNoticeValue) {
                    modalGroupNoticeValue.textContent = data.newDescription ? data.newDescription : '暂无群组公告';
                }
            }
        }
    });

    // 私信消息发送确认事件 - 根据确认事件渲染消息
    socket.on('private-message-sent', (data) => {
        const storageStore = useStorageStore();
        const friendStore = useFriendStore();
        const sessionStore = useSessionStore();
        const draftStore = useDraftStore();
        const baseStore = useBaseStore();

        // 检查是否包含错误（如速率限制）
        if (data.success === false && data.error) {
            toast && toast.error(data.error.message || '操作失败');
            return;
        }

        // 检查是否包含完整的消息数据
        if (data.message && data.messageId) {
            const confirmedMessage = data.message;
            
            // 检查是否是类型101撤回消息
            if (confirmedMessage.messageType === 101) {
                let originalMessageId;
                let recallNickname = null;
                let recallerId = null;

                originalMessageId = String(confirmedMessage.content).trim();
                recallerId = String(confirmedMessage.userId || confirmedMessage.senderId || '');
                recallNickname = confirmedMessage.nickname;

                if (!originalMessageId || !storageStore) {
                    return;
                }

                const currentUser = baseStore.currentUser;
                if (currentUser) {
                    // 确定聊天对象ID
                    const msgSenderId = String(confirmedMessage.senderId);
                    const msgReceiverId = String(confirmedMessage.receiverId);
                    const chatPartnerId = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;

                    // 先查找并替换引用该被撤回消息的消息
                    if (storageStore.fixQuotedMessagesForWithdrawn) {
                        if (storageStore.fullPrivateMessages !== null && storageStore.fullPrivateMessages !== undefined && storageStore.fullPrivateMessages[chatPartnerId]) {
                            const messages = storageStore.fullPrivateMessages[chatPartnerId];
                            const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                            updates.forEach(update => {
                                const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                                if (fullIndex !== -1) {
                                    messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                                }
                                if (friendStore.privateMessages && friendStore.privateMessages[chatPartnerId]) {
                                    const displayIndex = friendStore.privateMessages[chatPartnerId].findIndex(m => String(m.id) === String(update.messageId));
                                    if (displayIndex !== -1) {
                                        friendStore.privateMessages[chatPartnerId][displayIndex] = toRaw({ ...toRaw(friendStore.privateMessages[chatPartnerId][displayIndex]), content: update.newContent });
                                    }
                                }
                                friendStore.privateStored[chatPartnerId] = false;
                            });
                        }
                    }

                    // 构建撤回人昵称JSON存储格式：{撤回人id:撤回人昵称}
                    // 如果没有recallerId，使用confirmedMessage中的userId作为后备
                    const fallbackRecallerId = recallerId || String(confirmedMessage.userId || '');
                    const fallbackRecallNickname = recallNickname || confirmedMessage.nickname || '某人';
                    const recallJson = fallbackRecallerId 
                        ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname }) 
                        : '';

                    // 私信消息撤回 - 根据被撤回消息ID找到原消息并标记为已撤回
                    const privateMessages = storageStore.fullPrivateMessages?.[chatPartnerId];
                    if (privateMessages) {
                        const targetMsg = privateMessages.find(m => String(m.id) === originalMessageId);
                        if (targetMsg) {
                            // 确保content使用正确的JSON格式
                            const finalContent = recallJson || (fallbackRecallerId 
                                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                : targetMsg.content);
                            
                            // 标记为已撤回并应用系统样式，使用JSON格式存储
                            Object.assign(targetMsg, {
                                isRecalled: true,
                                isSystemMessage: true,
                                content: finalContent,  // JSON格式：{userId: 昵称}
                                nickname: recallNickname || confirmedMessage.nickname || targetMsg.nickname,
                                avatarUrl: confirmedMessage.avatarUrl || targetMsg.avatarUrl
                            });

                            // 触发UI更新 - 直接更新friendStore中的消息
                            const friendMsgs = friendStore.privateMessages?.[chatPartnerId];
                            if (friendMsgs) {
                                const displayIndex = friendMsgs.findIndex(m => String(m.id) === originalMessageId);
                                if (displayIndex !== -1) {
                                    friendMsgs[displayIndex] = toRaw({ ...toRaw(friendMsgs[displayIndex]), ...targetMsg });
                                }
                            }

                            // 持久化到IndexedDB（更新现有记录，保持JSON格式）
                            if (storageStore.savePrivateMessageToIndexedDB) {
                                storageStore.savePrivateMessageToIndexedDB(chatPartnerId, targetMsg);
                            }
                        }
                    }

                    // 更新私信会话的最后消息时间
                    if (friendStore && friendStore.friendsList) {
                        const friend = friendStore.friendsList.find(f => String(f.id) === String(chatPartnerId));
                        if (friend) {
                            const newTime = new Date(confirmedMessage.timestamp || Date.now()).toISOString();
                            friend.last_message_time = newTime;
                            friend.session_last_active_time = newTime;
                            friend.lastMessage = {
                                ...confirmedMessage,
                                content: recallJson || (fallbackRecallerId 
                                    ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                    : confirmedMessage.content),  // JSON格式
                                nickname: recallNickname || confirmedMessage.nickname || targetMsg?.nickname
                            };
                            friendStore.sortFriendsByLastMessageTime();
                            if (storageStore.updateSessionLastMessageTime) {
                                storageStore.updateSessionLastMessageTime('friend', chatPartnerId, newTime);
                            }
                        }
                    }
                }
                return;
            }
            
            // 更新对应的 minId
            if (confirmedMessage.id && storageStore && storageStore.privateMinId !== undefined) {
                if (confirmedMessage.id > storageStore.privateMinId) {
                    storageStore.privateMinId = confirmedMessage.id;
                    if (storageStore.saveMinIds) {
                        storageStore.saveMinIds();
                    }
                }
            }
            
            // 添加确认后的私信消息到 store
            if (friendStore && friendStore.addPrivateMessage) {
                // 使用消息本身的信息确定聊天对象ID（不依赖sessionStore）
                const msgSenderId = String(confirmedMessage.senderId);
                const msgReceiverId = String(confirmedMessage.receiverId);
                const currentUser = baseStore.currentUser;
                const chatPartnerIdFromMsg = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
                
                friendStore.addPrivateMessage(chatPartnerIdFromMsg, confirmedMessage);
            }
            
            // 更新好友最后消息
            if (friendStore && friendStore.updateFriendLastMessage) {
                // 使用消息本身的信息确定聊天对象ID
                const msgSenderId = String(confirmedMessage.senderId);
                const msgReceiverId = String(confirmedMessage.receiverId);
                const currentUser = baseStore.currentUser;
                const chatPartnerIdForLastMsg = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
                
                friendStore.updateFriendLastMessage(chatPartnerIdForLastMsg, confirmedMessage);
            }
            
            // 更新会话最后消息时间到 IndexedDB
            if (storageStore && storageStore.updateSessionLastMessageTime && confirmedMessage.messageType !== 101 && confirmedMessage.messageType !== 103) {
                // 使用消息本身的信息确定聊天对象ID
                const msgSenderId = String(confirmedMessage.senderId);
                const msgReceiverId = String(confirmedMessage.receiverId);
                const currentUser = baseStore.currentUser;
                const chatPartnerIdForStorage = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
                
                const newTime = new Date(confirmedMessage.timestamp || Date.now()).toISOString();
                storageStore.updateSessionLastMessageTime('friend', chatPartnerIdForStorage, newTime);
            }
            
            // 将私信好友移到列表顶部
            if (friendStore && friendStore.moveFriendToTop) {
                // 使用消息本身的信息确定聊天对象ID
                const msgSenderId = String(confirmedMessage.senderId);
                const msgReceiverId = String(confirmedMessage.receiverId);
                const currentUser = baseStore.currentUser;
                const chatPartnerIdForTop = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
                
                friendStore.moveFriendToTop(chatPartnerIdForTop);
            }
            
            // 清空私信草稿
            if (draftStore && draftStore.clearDraft) {
                const currentPrivateUserId = sessionStore.currentPrivateChatUserId;
                if (currentPrivateUserId) {
                    draftStore.clearDraft('private', currentPrivateUserId);
                }
            }
        }
    });

    // 私信消息接收事件
    socket.on('private-message-received', async (message) => {
        const sessionStore = useSessionStore();
        const baseStore = useBaseStore();
        const storageStore = useStorageStore();
        const friendStore = useFriendStore();
        const userStore = useUserStore();
        const unreadStore = useUnreadStore();

        // 如果在拉取消息中，将消息放入缓冲队列，等拉取完成后再处理
        if (isPullingMessages) {
            privateMessagesBuffer.push(message);
            return;
        }

        // 检查消息中是否包含新的会话令牌
        if (message.sessionToken) {
            // 更新会话令牌
            sessionStore.setCurrentSessionToken(message.sessionToken);
        }

        // 检查是否是类型101撤回消息
        if (message.messageType === 101) {
            // 101消息的content现在是JSON格式：{"id":被撤回消息ID, "nickname":"{撤回人id:撤回人昵称}"}
            // 兼容旧格式：纯数字字符串（被撤回消息ID）
            let originalMessageId;
            let recallNickname = null;
            let recallerId = null;

            originalMessageId = String(message.content).trim();
            recallerId = String(message.userId || message.senderId || '');
            recallNickname = message.nickname;

            if (!originalMessageId || !storageStore) {
                return;
            }

            const currentUser = baseStore.currentUser;
            if (currentUser) {
                // 确定聊天对象ID
                const msgSenderId = String(message.senderId);
                const msgReceiverId = String(message.receiverId);
                const chatPartnerId = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;

                // 先查找并替换引用该被撤回消息的消息
                if (storageStore.fixQuotedMessagesForWithdrawn) {
                    if (storageStore.fullPrivateMessages !== null && storageStore.fullPrivateMessages !== undefined && storageStore.fullPrivateMessages[chatPartnerId]) {
                        const messages = storageStore.fullPrivateMessages[chatPartnerId];
                        const updates = storageStore.fixQuotedMessagesForWithdrawn(originalMessageId, messages);
                        updates.forEach(update => {
                            const fullIndex = messages.findIndex(m => String(m.id) === String(update.messageId));
                            if (fullIndex !== -1) {
                                messages[fullIndex] = toRaw({ ...toRaw(messages[fullIndex]), content: update.newContent });
                            }
                            if (friendStore.privateMessages && friendStore.privateMessages[chatPartnerId]) {
                                const displayIndex = friendStore.privateMessages[chatPartnerId].findIndex(m => String(m.id) === String(update.messageId));
                                if (displayIndex !== -1) {
                                    friendStore.privateMessages[chatPartnerId][displayIndex] = toRaw({ ...toRaw(friendStore.privateMessages[chatPartnerId][displayIndex]), content: update.newContent });
                                }
                            }
                            friendStore.privateStored[chatPartnerId] = false;
                        });
                    }
                }

                // 构建撤回人昵称JSON存储格式：{撤回人id:撤回人昵称}
                // 如果没有recallerId，使用message中的userId作为后备
                const fallbackRecallerId = recallerId || String(message.userId || '');
                const fallbackRecallNickname = recallNickname || message.nickname || '某人';
                const recallJson = fallbackRecallerId 
                    ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname }) 
                    : '';

                // 私信消息撤回 - 根据被撤回消息ID找到原消息并标记为已撤回
                const privateMessages = storageStore.fullPrivateMessages?.[chatPartnerId];
                if (privateMessages) {
                    const targetMsg = privateMessages.find(m => String(m.id) === originalMessageId);
                    if (targetMsg) {
                        // 确保content使用正确的JSON格式
                        const finalContent = recallJson || (fallbackRecallerId 
                            ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                            : targetMsg.content);
                        
                        // 标记为已撤回并应用系统样式，使用JSON格式存储
                        Object.assign(targetMsg, {
                            isRecalled: true,
                            isSystemMessage: true,
                            content: finalContent,  // JSON格式：{userId: 昵称}
                            nickname: recallNickname || message.nickname || targetMsg.nickname,
                            avatarUrl: message.avatarUrl || targetMsg.avatarUrl
                        });

                        // 触发UI更新
                        if (friendStore.updatePrivateMessage) {
                            friendStore.updatePrivateMessage(chatPartnerId, originalMessageId, targetMsg);
                        }

                        // 持久化到IndexedDB（更新现有记录，保持JSON格式）
                        if (storageStore.savePrivateMessageToIndexedDB) {
                            storageStore.savePrivateMessageToIndexedDB(chatPartnerId, targetMsg);
                        }
                    }
                }

                // 更新私信会话的最后消息时间
                if (friendStore && friendStore.friendsList) {
                    const friend = friendStore.friendsList.find(f => String(f.id) === String(chatPartnerId));
                    if (friend) {
                        const newTime = new Date(message.timestamp || Date.now()).toISOString();
                        friend.last_message_time = newTime;
                        friend.session_last_active_time = newTime;
                        friend.lastMessage = {
                            ...message,
                            content: recallJson || (fallbackRecallerId 
                                ? JSON.stringify({ [fallbackRecallerId]: fallbackRecallNickname })
                                : message.content),  // JSON格式
                            nickname: recallNickname || message.nickname || targetMsg?.nickname
                        };
                        friendStore.sortFriendsByLastMessageTime();
                        if (storageStore.updateSessionLastMessageTime) {
                            storageStore.updateSessionLastMessageTime('friend', chatPartnerId, newTime);
                        }
                    }
                }

                // 注意：在线101撤回消息不更新 minId，避免导致minId过大
                // 只有通过拉取离线消息接口获得的101消息才会处理minId
            }
            return;
        }
        
        // 检查是否是类型103已读回执消息
        if (message.messageType === 103) {
            const currentUser = baseStore.currentUser;
            // 确定聊天对象ID
            const msgSenderId = String(message.senderId);
            const msgReceiverId = String(message.receiverId);
            const chatPartnerId = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;
            
            // 获取已读的最后一条消息ID
            const readMessageId = message.content;
            
            // 更新该会话中自己发送的消息的已读状态
            if (friendStore.updatePrivateMessagesReadStatus) {
                friendStore.updatePrivateMessagesReadStatus(chatPartnerId, readMessageId);
            }
            
            // 添加103已读回执消息到IndexedDB（但不加入store）
            friendStore.addPrivateMessage(chatPartnerId, message);
            return;
        }

        // 检查是否是类型102用户信息更新消息
        if (message.messageType === 102) {
            try {
                const updateData = JSON.parse(message.content);
                const userId = message.userId;

                if (storageStore && storageStore.processUserInfoUpdateForRecallMessages) {
                    storageStore.processUserInfoUpdateForRecallMessages(userId, updateData);
                }

                // 全局昵称更新
                if (updateData.type === 'nickname' && updateData.nickname) {
                    if (userStore && userStore.onlineUsers) {
                        const userIndex = userStore.onlineUsers.findIndex(u => String(u.id) === String(userId));
                        if (userIndex !== -1) {
                            userStore.onlineUsers[userIndex].nickname = updateData.nickname;
                        }
                    }
                    if (friendStore && friendStore.friendsList) {
                        const friendIndex = friendStore.friendsList.findIndex(f => String(f.id) === String(userId));
                        if (friendIndex !== -1) {
                            friendStore.friendsList[friendIndex].nickname = updateData.nickname;
                            friendStore.friendsList = [...friendStore.friendsList];
                        }
                    }
                    try {
                        const currentUser = baseStore.currentUser;
                        const userIdForStorage = currentUser?.id || 'guest';
                        const prefix = `chats-${userIdForStorage}`;
                        const key = `${prefix}-private-${userId}`;
                        const existingData = await localForage.getItem(key);
                        if (existingData) {
                            const updatedSessionData = { ...existingData };
                            updatedSessionData.nickname = updateData.nickname;
                            await localForage.setItem(key, updatedSessionData);
                        }
                    } catch (e) {
                        console.error('更新IndexedDB中的好友昵称失败:', e);
                    }
                    if (storageStore && storageStore.updateUserInfoInMessages) {
                        storageStore.updateUserInfoInMessages(userId, { nickname: updateData.nickname });
                    }
                    if (friendStore && friendStore.privateMessages) {
                        const privateMsgs = toRaw(friendStore.privateMessages);
                        Object.keys(privateMsgs).forEach(otherUserId => {
                            const messages = privateMsgs[otherUserId];
                            if (messages && Array.isArray(messages)) {
                                let hasChanges = false;
                                messages.forEach(msg => {
                                    if (String(msg.senderId) === String(userId)) {
                                        msg.nickname = updateData.nickname;
                                        hasChanges = true;
                                    }
                                });
                                if (hasChanges) {
                                    friendStore.privateMessages[otherUserId] = [...messages];
                                }
                            }
                        });
                    }
                } else if (updateData.type === 'avatar' && (updateData.avatarUrl || updateData.avatar_url)) {
                    const avatarUrl = updateData.avatarUrl || updateData.avatar_url;
                    if (userStore && userStore.onlineUsers) {
                        const userIndex = userStore.onlineUsers.findIndex(u => String(u.id) === String(userId));
                        if (userIndex !== -1) {
                            userStore.onlineUsers[userIndex].avatar = avatarUrl;
                            userStore.onlineUsers[userIndex].avatarUrl = avatarUrl;
                            userStore.onlineUsers[userIndex].avatar_url = avatarUrl;
                        }
                    }
                    if (friendStore && friendStore.friendsList) {
                        const friendIndex = friendStore.friendsList.findIndex(f => String(f.id) === String(userId));
                        if (friendIndex !== -1) {
                            friendStore.friendsList[friendIndex].avatarUrl = avatarUrl;
                            friendStore.friendsList[friendIndex].avatar_url = avatarUrl;
                            friendStore.friendsList[friendIndex].avatar = avatarUrl;
                            friendStore.friendsList = [...friendStore.friendsList];
                        }
                    }
                    try {
                        const currentUser = baseStore.currentUser;
                        const userIdForStorage = currentUser?.id || 'guest';
                        const prefix = `chats-${userIdForStorage}`;
                        const key = `${prefix}-private-${userId}`;
                        const existingData = await localForage.getItem(key);
                        if (existingData) {
                            const updatedSessionData = { ...existingData };
                            updatedSessionData.avatarUrl = avatarUrl;
                            await localForage.setItem(key, updatedSessionData);
                        }
                    } catch (e) {
                        console.error('更新IndexedDB中的好友头像失败:', e);
                    }
                    if (storageStore && storageStore.updateUserInfoInMessages) {
                        storageStore.updateUserInfoInMessages(userId, { avatarUrl });
                    }
                    if (userStore && userStore.updateUserInfoInMessages) {
                        userStore.updateUserInfoInMessages(userId, { avatarUrl });
                    }
                    if (friendStore && friendStore.privateMessages) {
                        const privateMsgs = toRaw(friendStore.privateMessages);
                        Object.keys(privateMsgs).forEach(otherUserId => {
                            const messages = privateMsgs[otherUserId];
                            if (messages && Array.isArray(messages)) {
                                let hasChanges = false;
                                messages.forEach(msg => {
                                    if (String(msg.senderId) === String(userId)) {
                                        msg.avatarUrl = avatarUrl;
                                        hasChanges = true;
                                    }
                                });
                                if (hasChanges) {
                                    friendStore.privateMessages[otherUserId] = [...messages];
                                }
                            }
                        });
                    }
                }
            } catch (e) {
                console.error('解析102消息失败:', e);
            }
            // 添加102消息到IndexedDB但不加入显示列表
            friendStore.addPrivateMessage(chatPartnerId, message);
            return;
        }
        
        // 检查消息是否是当前聊天对象的消息，使用字符串比较确保类型一致
        const msgSenderId = String(message.senderId);
        const msgReceiverId = String(message.receiverId);
        const currentUser = baseStore.currentUser;
        
        // 确定聊天对象ID（无论收到还是发送消息，聊天对象都是对方）
        const chatPartnerId = String(currentUser.id) === msgReceiverId ? msgSenderId : msgReceiverId;

        // 定义一些变量在后面使用
        const isOwnMessage = String(currentUser.id) === String(msgSenderId);
        const isWithdrawMessage = message.messageType === 101;
        const isReadReceiptMessage = message.messageType === 103;

        // 页面级焦点（路由 + sessionStore）
        const isUserOnThisPrivateChat = isUserActiveOnChat('private', chatPartnerId);
        
        if (message.id && storageStore && storageStore.privateMinId !== undefined) {
            if (message.id > storageStore.privateMinId) {
                storageStore.privateMinId = message.id;
                if (storageStore.saveMinIds) {
                    storageStore.saveMinIds();
                }
            }
        }
        
        // 如果当前页面在该私信会话，将好友移到顶部（仅需页面级焦点）
        if (isUserOnThisPrivateChat) {
            if (friendStore && friendStore.moveFriendToTop) {
                friendStore.moveFriendToTop(chatPartnerId);
            }
        }

        // 先添加消息到 store
        if (friendStore && friendStore.addPrivateMessage) {
            friendStore.addPrivateMessage(chatPartnerId, message);
        }

        // 更新好友最后消息时间并重新排序（排除101撤回消息和103已读回执消息）
        if (friendStore && friendStore.friendsList && !isWithdrawMessage && !isReadReceiptMessage) {
            const friend = friendStore.friendsList.find(f => String(f.id) === String(chatPartnerId));
            if (friend) {
                const newTime = new Date(message.timestamp || Date.now()).toISOString();
                friend.last_message_time = newTime;
                friend.session_last_active_time = newTime;
                friend.lastMessage = message;
                friendStore.sortFriendsByLastMessageTime();
                if (storageStore.updateSessionLastMessageTime) {
                    storageStore.updateSessionLastMessageTime('friend', chatPartnerId, newTime);
                }
            }
        }

        // 更新未读计数
        // 核心规则：基于路由 + sessionStore 判断用户是否正在关注该私信会话
        // 排除自己发送的消息，排除101撤回消息和103已读回执消息
        // 排除已设置免打扰的私信

        // 检查对方是否已被设置为免打扰
        const isPrivateMutedLocal = typeof isPrivateMuted === 'function' && isPrivateMuted(chatPartnerId);

        // 判断是否应该添加未读计数（不因聚焦而跳过，聚焦与否只影响移到顶部等展示逻辑）
        const shouldAddPrivateUnread = !isOwnMessage && !isWithdrawMessage && !isReadReceiptMessage && !isPrivateMutedLocal;

        if (shouldAddPrivateUnread) {
            // 更新未读消息计数 - 使用 chatPartnerId 作为键
            if (unreadStore && unreadStore.incrementPrivateUnread) {
                unreadStore.incrementPrivateUnread(chatPartnerId);
            }
            updateUnreadCountsDisplay();
        }
        // 已读事件的发送与未读计数的清除，统一由鼠标在 #chat-main 内移动/点击触发（见 ui.js handlePrivateChatAreaInteraction）
    });

    // 私信消息已读事件
    socket.on('private-message-read', async (data) => {
        const friendStore = useFriendStore();
        const sessionStore = useSessionStore();
        const storageStore = useStorageStore();

        if (!data || !data.fromUserId || !data.friendId) return;

        // fromUserId: 读消息的人（对方）
        // friendId: 收到已读事件的人（自己）
        const readerId = data.fromUserId;
        const myId = data.friendId;

        // 更新自己发给对方的消息为已读（display store）
        let hasDisplayUpdates = false;
        if (friendStore && friendStore.privateMessages && friendStore.privateMessages[readerId]) {
            const messages = friendStore.privateMessages[readerId];
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (String(msg.senderId) === String(myId) && String(msg.receiverId) === String(readerId)) {
                    if (msg.isRead !== 1) {
                        messages[i] = { ...msg, isRead: 1 };
                        hasDisplayUpdates = true;
                    }
                }
            }
            if (hasDisplayUpdates) {
                friendStore.privateMessages[readerId] = [...messages];
            }
        }

        // 同步更新 fullPrivateMessages[readerId]（独立于 display store 更新）
        let hasFullUpdates = false;
        if (storageStore && storageStore.fullPrivateMessages && storageStore.fullPrivateMessages[readerId]) {
            const fullMessages = storageStore.fullPrivateMessages[readerId];
            for (let i = 0; i < fullMessages.length; i++) {
                const msg = fullMessages[i];
                if (String(msg.senderId) === String(myId) && String(msg.receiverId) === String(readerId)) {
                    if (msg.isRead !== 1) {
                        fullMessages[i] = { ...msg, isRead: 1 };
                        hasFullUpdates = true;
                    }
                }
            }
        }

        // 更新 IndexedDB 中的消息（独立于内存 store 更新）
        if (hasFullUpdates && storageStore && storageStore.getStorageKeyPrefix) {
            try {
                const prefix = storageStore.getStorageKeyPrefix();
                const key = `${prefix}-private-${readerId}`;
                const existingData = await localForage.getItem(key);
                if (existingData && existingData.messages) {
                    const dbMessages = existingData.messages;
                    let dbHasUpdates = false;
                    for (let i = 0; i < dbMessages.length; i++) {
                        const msg = dbMessages[i];
                        if (String(msg.senderId) === String(myId) && String(msg.receiverId) === String(readerId)) {
                            if (msg.isRead !== 1) {
                                dbMessages[i] = { ...msg, isRead: 1 };
                                dbHasUpdates = true;
                            }
                        }
                    }
                    if (dbHasUpdates) {
                        await localForage.setItem(key, { ...existingData, messages: dbMessages });
                    }
                }
            } catch (e) {
                console.error('更新IndexedDB中的私信已读状态失败:', e);
            }
        }
    });

    // 好友列表更新事件
    socket.on('friend-list-updated', async () => {
        // 更新好友列表
        await loadFriendsList();
    });

    // 保存socket实例
    // 暴露发送已读消息事件函数

    // ModalManager已移至Vue组件ChatModal.vue中实现

    // 图片预览功能已移至Vue组件ChatModal.vue中实现
}

// 统一加载消息函数（支持全局、群组、私信）
function loadMessages(type, options = {}) {
    if (!socket) return;
    const baseStore = useBaseStore();
    const sessionStore = useSessionStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    
    const data = {
        type: type,
        userId: currentUser.id,
        sessionToken: currentSessionToken,
        limit: options.limit || 20,
        loadMore: options.loadMore || false
    };
    
    if (options.olderThan) {
        data.olderThan = options.olderThan;
    }
    
    if (type === 'group' && options.groupId) {
        data.groupId = options.groupId;
    }
    
    if (type === 'private' && options.friendId) {
        data.friendId = options.friendId;
    }
    
    socket.emit('load-messages', data);
}

// ============================================
// WebSocket 连接管理辅助函数
// 包含消息发送启用/禁用、用户/IP状态检查、离线用户管理
// ============================================

/**
 * 启用消息发送功能（启用输入框和按钮）
 */
function enableMessageSending() {
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');
    const imageUploadButton = document.getElementById('imageUploadButton');
    const fileUploadButton = document.getElementById('fileUploadButton');

    if (messageInput) {
        messageInput.removeAttribute('disabled');
        messageInput.placeholder = '输入消息...';
    }

    if (sendButton) {
        sendButton.removeAttribute('disabled');
    }

    if (imageUploadButton) {
        imageUploadButton.removeAttribute('disabled');
    }

    if (fileUploadButton) {
        fileUploadButton.removeAttribute('disabled');
    }

    // 启用群组消息发送功能
    const groupMessageInput = document.getElementById('groupMessageInput');
    const sendGroupMessageBtn = document.getElementById('sendGroupMessage');
    const groupImageUploadButton = document.getElementById('groupImageUploadButton');
    const groupFileUploadButton = document.getElementById('groupFileUploadButton');

    if (groupMessageInput) {
        groupMessageInput.removeAttribute('disabled');
        groupMessageInput.placeholder = '输入群组消息...';
    }

    if (sendGroupMessageBtn) {
        sendGroupMessageBtn.removeAttribute('disabled');
    }

    if (groupImageUploadButton) {
        groupImageUploadButton.removeAttribute('disabled');
    }

    if (groupFileUploadButton) {
        groupFileUploadButton.removeAttribute('disabled');
    }
}

/**
 * 禁用消息发送功能（禁用输入框和按钮）
 */
function disableMessageSending() {
    // 只有当用户未登录时才禁用消息发送功能
    // 已登录用户即使WebSocket连接暂时断开，也应该保持输入框可用
    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;
    if (!currentUser || !currentSessionToken) {
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const imageUploadButton = document.getElementById('imageUploadButton');
        const fileUploadButton = document.getElementById('fileUploadButton');

        if (messageInput) {
            messageInput.setAttribute('disabled', 'disabled');
            messageInput.placeholder = '请先登录';
        }

        if (sendButton) {
            sendButton.setAttribute('disabled', 'disabled');
        }

        if (imageUploadButton) {
            imageUploadButton.setAttribute('disabled', 'disabled');
        }

        if (fileUploadButton) {
            fileUploadButton.setAttribute('disabled', 'disabled');
        }

        // 禁用群组消息发送功能
        const groupMessageInput = document.getElementById('groupMessageInput');
        const sendGroupMessageBtn = document.getElementById('sendGroupMessage');
        const groupImageUploadButton = document.getElementById('groupImageUploadButton');
        const groupFileUploadButton = document.getElementById('groupFileUploadButton');

        if (groupMessageInput) {
            groupMessageInput.setAttribute('disabled', 'disabled');
            groupMessageInput.placeholder = '请先登录';
        }

        if (sendGroupMessageBtn) {
            sendGroupMessageBtn.setAttribute('disabled', 'disabled');
        }

        if (groupImageUploadButton) {
            groupImageUploadButton.setAttribute('disabled', 'disabled');
        }

        if (groupFileUploadButton) {
            groupFileUploadButton.setAttribute('disabled', 'disabled');
        }
    }
}

// 断开 WebSocket 连接
function disconnectWebSocket() {
    const baseStore = useBaseStore();
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    if (baseStore) {
        baseStore.isConnected = false;
    }
    // 停止清除未读事件轮询
    const unreadStore = useUnreadStore();
    if (unreadStore && unreadStore.stopUnreadClearPolling) {
        unreadStore.stopUnreadClearPolling();
    }
}

// 发送已读消息事件
function sendReadMessageEvent(type, options = {}) {
    if (!socket) {
        console.warn('WebSocket 未连接，无法发送已读消息事件');
        return;
    }

    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;

    if (!currentUser || !currentSessionToken) {
        console.warn('用户未登录，无法发送已读消息事件');
        return;
    }

    const data = {
        type: type,
        userId: currentUser.id,
        sessionToken: currentSessionToken
    };

    if (type === 'private' && options.friendId) {
        data.friendId = options.friendId;
    } else if (type === 'group' && options.groupId) {
        data.groupId = options.groupId;
    }

    socket.emit('message-read', data);
}

function sendClearGroupUnread(groupId) {
    if (!socket) {
        console.warn('WebSocket 未连接，无法发送清除群组未读事件');
        return;
    }

    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;

    if (!currentUser || !currentUser.id || !currentSessionToken) {
        return;
    }

    socket.emit('clear-group-unread', {
        userId: currentUser.id,
        sessionToken: currentSessionToken,
        groupId: groupId
    });
}

function sendClearGlobalUnread() {
    if (!socket) {
        console.warn('WebSocket 未连接，无法发送清除主聊天室未读事件');
        return;
    }

    const baseStore = useBaseStore();
    const currentUser = baseStore.currentUser;
    const currentSessionToken = baseStore.currentSessionToken;

    if (!currentUser || !currentUser.id || !currentSessionToken) {
        return;
    }

    socket.emit('clear-global-unread', {
        userId: currentUser.id,
        sessionToken: currentSessionToken
    });
}

export {
  initializeWebSocket,
  enableMessageSending,
  disableMessageSending,
  disconnectWebSocket,
  avatarVersions,
  sendReadMessageEvent,
  sendClearGroupUnread,
  sendClearGlobalUnread,
  loadMessages,
  setPullingMessages,
  waitForSocketConnection,
  processAndClearBuffers
};
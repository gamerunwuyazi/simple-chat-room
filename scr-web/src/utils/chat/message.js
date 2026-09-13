import { toast } from './config.js';
import {
  useBaseStore,
  useSessionStore,
  useDraftStore,
  useInputStore,
  getChatSocket
} from '@/stores/index.js';

const _messageSendTimeouts = {};
let _lastMessageSendTime = 0;

export function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function unescapeHtml(html) {
  const text = document.createElement('textarea');
  text.innerHTML = html;
  return text.value;
}

function setCursorToEnd(element) {
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(element);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function formatFileSize(bytes) {
  if (bytes < 1024) {
    return bytes + ' B';
  } else if (bytes < 1048576) {
    return (bytes / 1024).toFixed(2) + ' KB';
  } else if (bytes < 1073741824) {
    return (bytes / 1048576).toFixed(2) + ' MB';
  } else {
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }
}

export function clearContentEditable(element) {
  if (!element) return;
  element.innerHTML = '';
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
  element.textContent = '';
  
  const inputStore = useInputStore();
  if (inputStore) {
    if (element.id === 'messageInput') {
      inputStore.mainMessageInput = '';
    } else if (element.id === 'groupMessageInput') {
      inputStore.groupMessageInput = '';
    } else if (element.id === 'privateMessageInput') {
      inputStore.privateMessageInput = '';
    }
  }
}

export function sendMessage() {
  const messageInput = document.getElementById('messageInput');
  if (!messageInput) return;
  
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = messageInput.innerHTML;
  
  const atUserElements = tempDiv.querySelectorAll('.chat-at-user');
  atUserElements.forEach(el => {
    const textNode = document.createTextNode(el.textContent);
    el.parentNode.replaceChild(textNode, el);
  });
  
  let content = tempDiv.innerHTML.trim();
  if (content) {
    content = content.replace(/<div>/g, '\n').replace(/<\/div>/g, '').replace(/<br>/g, '\n').replace(/<br\s*\/?>/g, '\n');
    content = content.trim();
    content = unescapeHtml(content);
  }
  if (!content) {
    content = tempDiv.textContent.trim() || '';
  }
  
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  const draftStore = useDraftStore();
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  const chatSocket = getChatSocket();

  if (content && chatSocket) {
    const activeChat = sessionStore.currentActiveChat || 'main';
    let groupId = null;
    if (activeChat !== 'main') {
      if (activeChat.startsWith('group_')) {
        groupId = activeChat.replace('group_', '');
      } else {
        groupId = activeChat;
      }
    }
    
    const inputStore = useInputStore();
    const quotedMessage = inputStore?.quotedMessage;
    
    const showMarkdownToolbar = document.querySelector('.toggle-btn')?.textContent?.includes('隐藏') || false;
    
    const atUserElements = messageInput.querySelectorAll('.chat-at-user');
    const atUserIds = [];
    atUserElements.forEach(el => {
      if (el.dataset.id) {
        atUserIds.push(el.dataset.id);
      }
    });
    
    let messageContent = content;
    if (quotedMessage) {
      let quotedContent = quotedMessage.content;
      if (quotedMessage.messageType === 4) {
        try {
          const parsed = typeof quotedMessage.content === 'string' ? JSON.parse(quotedMessage.content) : quotedMessage.content;
          quotedContent = parsed.text || parsed.content || quotedMessage.content;
        } catch {}
      }
      messageContent = JSON.stringify({
        type: 'quoted',
        text: content,
        quoted: {
          id: quotedMessage.id,
          userId: quotedMessage.userId,
          content: quotedContent,
          messageType: quotedMessage.messageType || 0
        },
        markdone: showMarkdownToolbar
      });
    }
    
    const messageData = {
      content: messageContent,
      groupId: groupId,
      sessionToken: currentSessionToken,
      userId: currentUser.id,
      at_userid: atUserIds
    };
    
    if (quotedMessage) {
      messageData.messageType = 4;
    } else if (showMarkdownToolbar) {
      messageData.messageType = 5;
    }
    
    clearContentEditable(messageInput);
    
    const failedContent = content;
    const timeoutKey = 'sendMessage_' + Date.now();
    const sendTime = Date.now();
    
    _lastMessageSendTime = sendTime;
    
    _messageSendTimeouts[timeoutKey] = setTimeout(() => {
      const input = document.getElementById('messageInput');
      if (input) {
        input.innerHTML = failedContent;
        setCursorToEnd(input);
      }
      toast.error('消息发送超时，请检查网络后重试');
      delete _messageSendTimeouts[timeoutKey];
    }, 5000);
    
    const messageSentHandler = (data) => {
      if (data.success === false && data.error) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('message-sent', messageSentHandler);
        
        const input = document.getElementById('messageInput');
        if (input) {
          input.innerHTML = failedContent;
          setCursorToEnd(input);
        }
        // 错误提示由 websocket.js 全局 message-sent handler 统一弹出，避免与这里重复弹两次
        return;
      }
      
      if (data.message && data.messageId) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('message-sent', messageSentHandler);
      }
    };
    chatSocket.on('message-sent', messageSentHandler);
    
    chatSocket.emit('send-message', messageData);
    
    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

export function sendGroupMessage() {
  const sessionStore = useSessionStore();
  const baseStore = useBaseStore();
  const draftStore = useDraftStore();
  
  const currentGroupId = sessionStore.currentGroupId;
  if (!currentGroupId) {
    console.warn('⚠️  无法发送群组消息 - 未选择群组');
    return;
  }

  const groupMessageInput = document.getElementById('groupMessageInput');
  if (!groupMessageInput) {
    console.error('❌ 无法获取群组消息输入框 - 元素不存在');
    return;
  }

  let content = '';
  if (groupMessageInput.tagName === 'DIV' && groupMessageInput.isContentEditable) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = groupMessageInput.innerHTML;
    
    const atUserElements = tempDiv.querySelectorAll('.chat-at-user');
    atUserElements.forEach(el => {
      const textNode = document.createTextNode(el.textContent);
      el.parentNode.replaceChild(textNode, el);
    });
    
    let htmlContent = tempDiv.innerHTML.trim();
    if (htmlContent) {
      htmlContent = htmlContent.replace(/<div>/g, '\n').replace(/<\/div>/g, '').replace(/<br>/g, '\n').replace(/<br\s*\/?>/g, '\n');
      content = htmlContent.trim();
      content = unescapeHtml(content);
    }
    if (!content) {
      content = tempDiv.textContent.trim();
    }
  } else {
    content = groupMessageInput.value || groupMessageInput.innerHTML || '';
    content = content.trim();
  }

  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  const chatSocket = getChatSocket();

  if (content && chatSocket) {
    const inputStore = useInputStore();
    const quotedMessage = inputStore?.quotedMessage;
    
    const showMarkdownToolbar = document.querySelector('.toggle-btn')?.textContent?.includes('隐藏') || false;
    
    const atUserElements = groupMessageInput.querySelectorAll('.chat-at-user');
    const atUserIds = [];
    atUserElements.forEach(el => {
      if (el.dataset.id) {
        atUserIds.push(el.dataset.id);
      }
    });
    
    let messageContent = content;
    if (quotedMessage) {
      let quotedContent = quotedMessage.content;
      if (quotedMessage.messageType === 4) {
        try {
          const parsed = typeof quotedMessage.content === 'string' ? JSON.parse(quotedMessage.content) : quotedMessage.content;
          quotedContent = parsed.text || parsed.content || quotedMessage.content;
        } catch {}
      }
      messageContent = JSON.stringify({
        type: 'quoted',
        text: content,
        quoted: {
          id: quotedMessage.id,
          userId: quotedMessage.userId,
          content: quotedContent,
          messageType: quotedMessage.messageType || 0
        },
        markdone: showMarkdownToolbar
      });
    }
    
    const messageData = {
      groupId: Number(currentGroupId),
      content: messageContent,
      sessionToken: currentSessionToken,
      userId: Number(currentUser.id),
      at_userid: atUserIds.map(id => Number(id))
    };
    
    if (quotedMessage) {
      messageData.messageType = 4;
    } else if (showMarkdownToolbar) {
      messageData.messageType = 5;
    }
    
    if (groupMessageInput.tagName === 'TEXTAREA') {
      groupMessageInput.value = '';
    } else {
      clearContentEditable(groupMessageInput);
    }
    
    const failedContent = content;
    const timeoutKey = 'sendGroupMessage_' + Date.now();
    
    _messageSendTimeouts[timeoutKey] = setTimeout(() => {
      const input = document.getElementById('groupMessageInput');
      if (input) {
        if (input.tagName === 'TEXTAREA') {
          input.value = failedContent;
          input.focus();
          input.setSelectionRange(failedContent.length, failedContent.length);
        } else {
          input.innerHTML = failedContent;
          setCursorToEnd(input);
        }
      }
      toast.error('消息发送超时，请检查网络后重试');
      delete _messageSendTimeouts[timeoutKey];
    }, 5000);
    
    const messageSentHandler = (data) => {
      if (data.success === false && data.error) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('message-sent', messageSentHandler);
        
        const input = document.getElementById('groupMessageInput');
        if (input) {
          if (input.tagName === 'TEXTAREA') {
            input.value = failedContent;
            input.focus();
            input.setSelectionRange(failedContent.length, failedContent.length);
          } else {
            input.innerHTML = failedContent;
            setCursorToEnd(input);
          }
        }
        // 错误提示由 websocket.js 全局 message-sent handler 统一弹出，避免重复弹两次
        return;
      }
      
      if (data.message && data.messageId && String(data.message.groupId) === String(currentGroupId)) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('message-sent', messageSentHandler);
        
        if (draftStore && draftStore.clearDraft) {
          draftStore.clearDraft('group', currentGroupId);
        }
      }
    };
    chatSocket.on('message-sent', messageSentHandler);
    
    chatSocket.emit('send-message', messageData);
    
    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

export function sendPrivateMessage() {
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  const draftStore = useDraftStore();
  
  const currentUser = baseStore.currentUser;
  const currentSessionToken = baseStore.currentSessionToken;
  const currentPrivateChatUserId = sessionStore.currentPrivateChatUserId;
  
  if (!currentUser || !currentSessionToken || !currentPrivateChatUserId) return;

  const privateMessageInput = document.getElementById('privateMessageInput');
  if (!privateMessageInput) return;

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = privateMessageInput.innerHTML;
  
  const atUserElements = tempDiv.querySelectorAll('.chat-at-user');
  atUserElements.forEach(el => {
    const textNode = document.createTextNode(el.textContent);
    el.parentNode.replaceChild(textNode, el);
  });
  
  let content = tempDiv.innerHTML.trim();
  if (content) {
    content = content.replace(/<div>/g, '\n').replace(/<\/div>/g, '').replace(/<br>/g, '\n').replace(/<br\s*\/?>/g, '\n');
    content = content.trim();
    content = unescapeHtml(content);
  }
  if (!content) {
    content = tempDiv.textContent.trim();
  }
  if (!content) return;
  
  const inputStore = useInputStore();
  const quotedMessage = inputStore?.quotedMessage;

  const showMarkdownToolbar = document.querySelector('#privateInputButtons .toggle-btn')?.textContent?.includes('隐藏') || false;
  
  const atUserIds = [];
  atUserElements.forEach(el => {
    if (el.dataset.id) {
      atUserIds.push(el.dataset.id);
    }
  });

  let messageContent = content;
  if (quotedMessage) {
    let quotedContent = quotedMessage.content;
    if (quotedMessage.messageType === 4) {
      try {
        const parsed = typeof quotedMessage.content === 'string' ? JSON.parse(quotedMessage.content) : quotedMessage.content;
        quotedContent = parsed.text || parsed.content || quotedMessage.content;
      } catch {}
    }
    messageContent = JSON.stringify({
      content: content,
      quotedMessage: {
        id: quotedMessage.id,
        userId: quotedMessage.userId,
        content: quotedContent,
        messageType: quotedMessage.messageType || 0
      },
      markdone: showMarkdownToolbar
    });
  }
  
  const messageData = {
    userId: currentUser.id,
    content: messageContent,
    receiverId: currentPrivateChatUserId,
    sessionToken: currentSessionToken,
    at_userid: atUserIds
  };
  
  if (quotedMessage) {
    messageData.message_type = 4;
  } else if (showMarkdownToolbar) {
    messageData.message_type = 5;
  }
  
  const chatSocket = getChatSocket();
  if (chatSocket) {
    clearContentEditable(privateMessageInput);
    
    const failedContent = content;
    const timeoutKey = 'sendPrivateMessage_' + Date.now();
    
    _messageSendTimeouts[timeoutKey] = setTimeout(() => {
      const input = document.getElementById('privateMessageInput');
      if (input) {
        input.innerHTML = failedContent;
        setCursorToEnd(input);
      }
      toast.error('消息发送超时，请检查网络后重试');
      delete _messageSendTimeouts[timeoutKey];
    }, 5000);
    
    const privateMessageSentHandler = (data) => {
      if (data.success === false && data.error) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('private-message-sent', privateMessageSentHandler);
        
        const input = document.getElementById('privateMessageInput');
        if (input) {
          input.innerHTML = failedContent;
          setCursorToEnd(input);
        }
        // 错误提示由 websocket.js 全局 private-message-sent handler 统一弹出，避免重复弹两次
        return;
      }
      
      if (data.message && data.messageId) {
        const timeout = _messageSendTimeouts[timeoutKey];
        if (timeout) {
          clearTimeout(timeout);
          delete _messageSendTimeouts[timeoutKey];
        }
        chatSocket.off('private-message-sent', privateMessageSentHandler);
        
        if (draftStore && draftStore.clearDraft) {
          draftStore.clearDraft('private', currentPrivateChatUserId);
        }
      }
    };
    chatSocket.on('private-message-sent', privateMessageSentHandler);
    
    chatSocket.emit('send-private-message', messageData);
    
    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

/**
 * 将消息列表按日历日期（年/月/日）分组，用于渲染日期分隔标签（参考微信）
 * 规则：相邻消息的日历日期不同才算跨天，而非间隔超过24小时
 * 以分组代替逐条 v-if 判断，避免每条消息都产生一个占位节点
 * @param {Array} messages 按时间正序排列的消息列表
 * @param {boolean} allLoaded 历史消息是否已全部加载
 * @returns {Array} [{ key, label, showDivider, messages }]
 */
export function buildDateSegments(messages, allLoaded = false) {
  const segments = [];
  for (const msg of messages) {
    const d = new Date(msg.timestamp);
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const last = segments[segments.length - 1];
    if (last && last.key === dayKey) {
      last.messages.push(msg);
    } else {
      segments.push({
        key: dayKey,
        label: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
        showDivider: true,
        messages: [msg]
      });
    }
  }
  // 首段日期仅在确认历史消息已全部加载时显示：
  // 否则上方可能还存在同天的更早消息，顶部日期会在加载更多时反复增删导致闪现
  if (segments.length > 0 && !allLoaded) {
    segments[0].showDivider = false;
  }
  return segments;
}

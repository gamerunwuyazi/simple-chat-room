import {
  useBaseStore,
  useSessionStore,
  useInputStore,
  getChatSocket
} from '@/stores/index.js';
import { sendTracked } from './messageStatus.js';

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
    
    _lastMessageSendTime = Date.now();
    
    // 输入框已清空，失败不再回填；气泡保留在列表尾部，点图标用同一 clientMsgId 重发
    sendTracked({
      scope: 'group',
      targetId: groupId,
      payload: messageData,
      content,
      messageType: messageData.messageType || 0
    });
    
    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

export function sendGroupMessage() {
  const sessionStore = useSessionStore();
  const baseStore = useBaseStore();
  
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
    
    sendTracked({
      scope: 'group',
      targetId: currentGroupId,
      payload: messageData,
      content,
      messageType: messageData.messageType || 0
    });
    
    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

export function sendPrivateMessage() {
  const baseStore = useBaseStore();
  const sessionStore = useSessionStore();
  
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
    
    sendTracked({
      scope: 'private',
      targetId: currentPrivateChatUserId,
      payload: messageData,
      content,
      messageType: messageData.message_type || 0
    });

    if (quotedMessage) {
      inputStore?.clearQuotedMessage();
    }
  }
}

/**
 * 格式化消息时间戳：日期前缀按需拼接（与当前日期比较），时间精度只到分钟
 * 今天不显示日期；一周内显示周几；一年内显示月日；跨年显示年月日
 * @param {Date} date 消息时间
 * @returns {string} 如 "周三 14:30" / "9月20日 14:30" / "2025年9月1日 14:30" / "14:30"
 */
export function formatMessageTime(date) {
  // 精度只到分钟，不显示秒
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 按自然日计算相差天数（今天为 0）
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (dayDiff <= 0) return time;
  if (dayDiff < 7) {
    // 一周内：显示周几
    return `周${'日一二三四五六'[date.getDay()]} ${time}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

<template>
  <div class="chat-content" data-content="private-chat">
    <!-- 新的朋友：好友申请面板（微信风格，点击私信侧边栏置顶项打开） -->
    <FriendRequestsPanel v-if="sessionStore.showFriendRequests" />

    <!-- 黑名单：已拉黑用户面板（点击私信侧边栏置顶项打开） -->
    <BlackListPanel v-else-if="sessionStore.showBlackList" />

    <div v-else-if="!isPrivateChatVisible" class="empty-chat-state">
      <h3>选择一个好友开始聊天</h3>
      <p>请从左侧好友列表中选择一个好友，开始私聊会话</p>
    </div>

    <div v-else class="private-chat-interface">
      <div class="private-header">
        <div class="private-user-info">
          <div class="private-user-avatar">
            <img v-if="currentUserAvatarUrl" :src="currentUserAvatarUrl" alt="用户头像" class="user-avatar-img" loading="lazy" width="40" height="40" style="aspect-ratio: 1/1; object-fit: cover;">
            <span v-else class="user-initials">{{ currentUserInitials }}</span>
          </div>
          <div class="private-user-details">
            <h2>{{ displayCurrentUserName }}</h2>
            <div class="user-status">
              {{ isUserOnline(sessionStore.currentPrivateChatUserId) ? '在线' : '离线' }}
            </div>
          </div>
        </div>
        <div class="private-actions">
          <button id="privateUserInfoButton" title="查看用户资料" @click="handlePrivateUserInfoClick"><i class="fas fa-circle-info"></i></button>
        </div>
      </div>

      <div class="markdown-toolbar private-markdown-toolbar" v-if="showMarkdownToolbar">
        <button class="markdown-btn" @click="insertMarkdown('**', '**', '粗体文本')">粗体</button>
        <button class="markdown-btn" @click="insertMarkdown('_', '_', '斜体文本')">斜体</button>
        <button class="markdown-btn" @click="insertMarkdown('`', '`', '代码')">代码</button>
        <button class="markdown-btn" @click="insertMarkdown('```\n', '\n```', '代码块')">代码块</button>
        <button class="markdown-btn" @click="insertMarkdown('# ', '', '标题')">标题</button>
        <button class="markdown-btn" @click="insertMarkdown('- ', '', '列表项')">列表</button>
        <button class="markdown-btn" @click="insertMarkdown('> ', '', '引用文本')">引用</button>
        <button class="markdown-btn" @click="insertMarkdown('[链接描述](', ')', '链接文本')">链接</button>
        <button class="markdown-btn" @click="insertMarkdown('![图片描述](', ')', '图片URL')">图片</button>
      </div>

      <div id="privateMessageContainer" ref="privateMessageContainerRef">
        <template v-if="privateMessages.length !== 0 || pendingMessages.length !== 0">
          <PrivateMessageItem
            v-for="message in privateMessages"
            :key="message.id"
            :message="message"
            :is-own="isOwnMessage(message)"
          />
          <PendingBubble
            v-for="item in pendingMessages"
            :key="item.clientMsgId"
            :content="item.content"
            :message-type="item.messageType"
            :status="item.status"
            :error="item.error"
            @retry="handlePendingRetry(item.clientMsgId)"
          />
        </template>
        <div v-else class="empty-state">
          <h3>暂无私信</h3>
          <p>发送第一条消息开始聊天吧!</p>
        </div>
      </div>

      <TypingIndicator :names="typingNames" peer />
      <div class="input-area">
        <QuotedMessagePreview v-if="inputStore.quotedMessage" :quoted-message="inputStore.quotedMessage" @close="inputStore.clearQuotedMessage()" />
        <div class="input-container" id="privateInputContainer"
          @drop="handlePrivateDrop"
          @dragover="handlePrivateDragOver"
          @dragenter="handlePrivateDragEnter"
          @dragleave="handlePrivateDragLeave">
          <div 
            ref="privateMessageInputRef"
            id="privateMessageInput" 
            class="editable-div" 
            placeholder="发送消息（Ctrl+Enter或Shift+Enter换行  打开md工具栏即可支持Markdown语法）" 
            contenteditable="true"
            @keydown="handlePrivateMessageInputKeydown"
            @input="handlePrivateMessageInput"
            @paste="handlePrivatePaste"
          ></div>
          <div v-if="isDragOver" class="drop-overlay">
            <div class="drop-content">
              <i class="fas fa-cloud-upload-alt"></i>
              <p>松开即可发送</p>
            </div>
          </div>
        </div>
        <div class="input-buttons" id="privateInputButtons">
          <button id="sendPrivateMessage" @click="handleSendPrivateMessage">发送</button>
          <button id="privateMoreButton" class="more-button" title="更多功能" @click="toggleMoreFunctions">
            <i class="fas fa-ellipsis" aria-hidden="true"></i> <span class="button-text">更多</span>
          </button>
          <button class="emoji-button" title="表情" @click.stop="showEmoji = !showEmoji">
            <i class="far fa-smile" aria-hidden="true"></i>
          </button>
          <button class="toggle-btn" 
            @click="toggleMarkdownToolbar">
            <i v-if="!showMarkdownToolbar" class="fas fa-chevron-down"></i>
            <i v-else class="fas fa-chevron-up"></i>
            {{ showMarkdownToolbar ? ' 隐藏Markdown工具栏' : ' MD' }}
          </button>
        </div>
        <div v-if="showMoreFunctions" class="more-functions" id="privateMoreFunctions">
          <button id="privateImageUploadButton" title="上传图片" @click="handlePrivateImageUploadClick">
            <i class="fas fa-image"></i> <span class="button-text">发送图片</span>
          </button>
          <button id="privateFileUploadButton" title="上传文件" @click="handlePrivateFileUploadClick">
          <i class="fas fa-file-upload"></i> <span class="button-text">发送文件</span>
        </button>
        <button id="privateVideoUploadButton" title="上传视频" @click="handlePrivateVideoUploadClick">
          <i class="fas fa-video"></i> <span class="button-text">发送视频</span>
        </button>
          <button id="privateSendGroupCardButton" title="发送群名片" @click="handleSendGroupCard">
            <i class="fas fa-address-card"></i> <span class="button-text">发送群名片</span>
          </button>
          <button id="privateSearchMessageButton" title="查找消息" @click="openSearchModal">
            <i class="fas fa-search"></i> <span class="button-text">查找消息</span>
          </button>
        </div>
        <input v-if="showImageInput" type="file" ref="privateImageInputRef" id="privateImageInput" style="display: none;" accept="image/*" @change="handlePrivateImageUpload" @cancel="handlePrivateImageCancel">
        <input v-if="showFileInput" type="file" ref="privateFileInputRef" id="privateFileInput" style="display: none;" @change="handlePrivateFileUpload" @cancel="handlePrivateFileCancel">
        <input v-if="showVideoInput" type="file" ref="privateVideoInputRef" id="privateVideoInput" style="display: none;" accept="video/*" @change="handlePrivateVideoUpload" @cancel="handlePrivateVideoCancel">
      </div>

      <div v-if="inputStore.showUploadProgress" class="upload-progress" id="privateUploadProgress">
        <div class="upload-progress-bar" id="privateUploadProgressBar" :style="{ width: inputStore.uploadProgress + '%' }"></div>
      </div>

      <EmojiPanel v-model:visible="showEmoji" @select="insertPrivateEmoji" />

      <SearchMessageModal
        v-model="showSearchModal"
        :search-results="searchResults"
        :is-searching="isSearching"
        :has-searched="hasSearched"
        :is-loading-more="isLoadingMore"
        :has-more="hasMore"
        @search="executeSearch"
        @navigate-prev="navigateToPrevSearchResult"
        @navigate-next="navigateToNextSearchResult"
        @scroll-to-message="scrollToMessage"
        @load-more="loadMore"
      >
        <template #results="{ results, onClick }">
          <PrivateMessageItem
            v-for="result in results"
            :key="result.id"
            :message="result"
            :is-search-result="true"
            @click="onClick(result)"
          />
        </template>
      </SearchMessageModal>
    </div>
  </div>
</template>

<style scoped>
.search-results {
  margin-top: 15px;
  max-height: 500px;
  overflow-y: auto;
}

.search-results-count {
  font-size: 14px;
  color: #666;
  margin-bottom: 10px;
  padding: 0 10px;
}

.search-results-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.search-results-list :deep(.message) {
  cursor: pointer;
  transition: background-color 0.2s;
  border-radius: 8px;
  padding: 10px;
}

.search-results-list :deep(.message:hover) {
  background-color: #f5f5f5;
}
</style>

<script setup>
import localForage from "localforage";
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { useRoute } from "vue-router";

import PrivateMessageItem from "@/components/MessageItem/PrivateMessageItem.vue";
import PendingBubble from "@/components/MessageStatus/PendingBubble.vue";
import TypingIndicator from "@/components/MessageStatus/TypingIndicator.vue";
import { useMessageStatusStore } from "@/stores/messageStatusStore";
import { useTypingStore } from "@/stores/typingStore";
import { notifyTyping, stopTyping, typingSetting } from "@/utils/chat/typing.js";
import { resend as resendMessage } from "@/utils/chat/messageStatus.js";
import QuotedMessagePreview from "@/components/MessageItem/QuotedMessagePreview.vue";
import FriendRequestsPanel from "@/components/FriendRequestsPanel.vue";
import BlackListPanel from "@/components/BlackListPanel.vue";
import { useBaseStore } from "@/stores/baseStore";
import { useUserStore } from "@/stores/userStore";
import { useFriendStore } from "@/stores/friendStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useInputStore } from "@/stores/inputStore";
import { useDraftStore } from "@/stores/draftStore";
import { useGroupStore } from "@/stores/groupStore";
import { useUnifiedStore } from "@/stores/unifiedStore";
import {
  setActiveChat,
  loadPrivateChatHistory,
  initializeImageClickEvents,
  initializePrivateChatInterface,
  initializeScrollLoading,
  uploadPrivateImage,
  uploadPrivateFile,
  uploadPrivateVideo,
  sendPrivateMessage,
  showSendGroupCardModal,
  showUserProfile,
  resetLoadingState
} from "@/utils/chat";
import { useMessageHighlight } from "@/composables/useMessageHighlight";
import { useSearchNavigation } from "@/composables/useSearchNavigation";
import { useMessageBrowse } from "@/composables/useMessageBrowse";
import SearchMessageModal from "@/components/SearchMessageModal.vue";
import EmojiPanel from "@/components/EmojiPanel.vue";

const baseStore = useBaseStore();
const userStore = useUserStore();
const friendStore = useFriendStore();
const sessionStore = useSessionStore();
const inputStore = useInputStore();
const messageStatusStore = useMessageStatusStore();
const typingStore = useTypingStore();

const typingNames = computed(() => {
  // 设置页关掉「显示自己正在输入」后，也不再显示别人的输入提示
  if (!typingSetting.value) return [];
  return sessionStore.currentPrivateChatUserId
    ? typingStore.list('private', sessionStore.currentPrivateChatUserId, baseStore.currentUser?.id)
    : [];
});

function handlePendingRetry(clientMsgId) {
  resendMessage(clientMsgId);
}
const draftStore = useDraftStore();
const { scrollAndHighlight } = useMessageHighlight();
const { currentSearchIndex, navigateToNextSearchResult: navNext, navigateToPrevSearchResult: navPrev } = useSearchNavigation();

function navigateToNextSearchResult() {
  navNext(searchResults.value, scrollToMessage);
}

function navigateToPrevSearchResult() {
  navPrev(searchResults.value, scrollToMessage);
}
const groupStore = useGroupStore();
const unifiedStore = useUnifiedStore();
const SERVER_URL = baseStore.SERVER_URL || import.meta.env.VITE_SERVER_URL || '';

let restoringPrivateDraft = false;
let scrollingInitialized = { private: false };
let privateChatAllLoaded = {};

const route = useRoute();
const privateMessageInputRef = ref(null);
const privateImageInputRef = ref(null);
const privateFileInputRef = ref(null);
const privateVideoInputRef = ref(null);
const privateMessageContainerRef = ref(null);
const isDragOver = ref(false);
const showImageInput = ref(false);
const showFileInput = ref(false);
const showVideoInput = ref(false);
let dragCounter = 0;
let previousPrivateMessageLength = 0;

const currentUserId = computed(() => baseStore.currentUser?.id);

const privateMessages = computed(() => {
  return friendStore.privateMessages[sessionStore.currentPrivateChatUserId] || [];
});

// 发送状态按 messageId 交接：真实消息渲染出来之前，气泡不撤（列表刷新也不重置动画）
const privateMessageIds = computed(() => privateMessages.value.map((message) => message.id));
const pendingMessages = computed(() => (
  sessionStore.currentPrivateChatUserId
    ? messageStatusStore.listVisible('private', sessionStore.currentPrivateChatUserId, privateMessageIds.value)
    : []
));
watch(privateMessageIds, (ids) => {
  messageStatusStore.pruneRendered('private', sessionStore.currentPrivateChatUserId, ids);
});

function isOwnMessage(message) {
  if (!currentUserId.value) return false;
  return String(message.userId) === String(currentUserId.value) || 
         (message.user && String(message.user.id) === String(currentUserId.value)) ||
         String(message.senderId) === String(currentUserId.value);
}

function scrollToBottom() {
  nextTick(() => {
    if (privateMessageContainerRef.value) {
      privateMessageContainerRef.value.scrollTop = privateMessageContainerRef.value.scrollHeight;
    }
  });
}

function isNearBottom() {
  if (!privateMessageContainerRef.value) return false;
  const container = privateMessageContainerRef.value;
  const threshold = 150;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

const isPrivateChatVisible = ref(false);
const currentUserName = ref('好友昵称');
const currentUserAvatarUrl = ref('');
const currentUserInitials = ref('U');
const showMarkdownToolbar = ref(false);
const showEmoji = ref(false);

function insertPrivateEmoji(emoji) {
  const input = privateMessageInputRef.value;
  if (!input) return;
  input.focus();
  document.execCommand('insertText', false, emoji);
  handlePrivateMessageInput();
}
const showMoreFunctions = ref(false);

const displayCurrentUserName = computed(() => {
  const userId = sessionStore.currentPrivateChatUserId;
  if (userId && friendStore.friendsList) {
    const currentFriend = friendStore.friendsList.find(f => String(f.id) === String(userId));
    if (currentFriend && currentFriend.remark && currentFriend.remark.trim()) {
      return currentFriend.remark.trim();
    }
  }
  return sessionStore.currentPrivateChatNickname || currentUserName.value || '好友昵称';
});

function applySavedPrivateState() {
  if (sessionStore.currentPrivateChatUserId) {
    // 模拟真实打开会话：清除该私聊未读并设置发送类型等会话状态
    setActiveChat('private', sessionStore.currentPrivateChatUserId, true);
    isPrivateChatVisible.value = true;
    currentUserName.value = sessionStore.currentPrivateChatNickname;
    sessionStore.currentSendChatType = 'private';

    const avatarUrl = sessionStore.currentPrivateChatAvatarUrl;
    if (avatarUrl) {
      currentUserAvatarUrl.value = avatarUrl.startsWith('http') ? avatarUrl : `${SERVER_URL}${avatarUrl}`;
    } else {
      currentUserAvatarUrl.value = '';
      const displayName = displayCurrentUserName.value;
      currentUserInitials.value = displayName ? displayName.charAt(0).toUpperCase() : 'U';
    }
    
    initializePrivateChatInterface();
    
    const draftContent = draftStore.getDraft('private', sessionStore.currentPrivateChatUserId);
    if (draftContent) {
      restoringPrivateDraft = true;
      nextTick(() => {
        const messageInput = document.getElementById('privateMessageInput');
        if (messageInput) {
          messageInput.innerHTML = draftContent;
          draftStore.saveDraft('private', sessionStore.currentPrivateChatUserId, '');
          draftStore.tempRestoreLastMessage('private', sessionStore.currentPrivateChatUserId);
        }
        restoringPrivateDraft = false;
      });
    }
    
    nextTick(() => {
      initializeScrollLoading(true);
    });
  }
}

function toggleMarkdownToolbar() {
  showMarkdownToolbar.value = !showMarkdownToolbar.value;
}

function toggleMoreFunctions() {
  showMoreFunctions.value = !showMoreFunctions.value;
}

function handlePrivateMessageInput() {
  if (privateMessageInputRef.value) {
    const input = privateMessageInputRef.value;
    
    const textContent = input.textContent;
    const htmlContent = input.innerHTML;
    
    if (textContent === '' && (!htmlContent || htmlContent === '<br>' || htmlContent === '<br/>' || htmlContent === '<br />')) {
      input.innerHTML = '';
      inputStore.privateMessageInput = '';
      stopTyping('private', sessionStore.currentPrivateChatUserId);
      return;
    }

    notifyTyping('private', sessionStore.currentPrivateChatUserId);
    
    if (restoringPrivateDraft) {
      return;
    }
    
    inputStore.privateMessageInput = input.textContent || input.innerHTML;
    
    const maxHeight = 180;
    if (input.scrollHeight > maxHeight) {
      input.style.overflowY = 'auto';
    } else {
      input.style.overflowY = 'hidden';
    }
    
    input.scrollTop = input.scrollHeight;
  }
}

function isMobileDevice() {
  return window.innerWidth <= 768;
}

function handlePrivateMessageInputKeydown(e) {
  const isMobile = isMobileDevice();
  
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
    if (isMobile) {
      return;
    }
    e.preventDefault();
    handleSendPrivateMessage();
  } else if (e.key === 'Enter' && (e.ctrlKey || (isMobile && !e.shiftKey))) {
    e.preventDefault();
    insertPrivateNewLine();
  } else if (e.key === 'm' && e.ctrlKey) {
    e.preventDefault();
    toggleMarkdownToolbar();
  }
}

function handleSendPrivateMessage() {
  sendPrivateMessage();
  stopTyping('private', sessionStore.currentPrivateChatUserId);
  scrollToBottom();
}

function handleSendGroupCard() {
  showSendGroupCardModal('private');
}

function handlePrivateUserInfoClick() {
  const user = {
    id: sessionStore.currentPrivateChatUserId,
    nickname: sessionStore.currentPrivateChatNickname,
    username: sessionStore.currentPrivateChatUsername,
    avatarUrl: sessionStore.currentPrivateChatAvatarUrl
  };
  
  showUserProfile(user);
}

function insertMarkdown(prefix, suffix, sample) {
  if (!privateMessageInputRef.value) return;
  
  const input = privateMessageInputRef.value;
  input.focus();
  
  const selection = window.getSelection();
  const range = selection.getRangeAt(0);
  
  let selectedText = range.toString();
  if (!selectedText) selectedText = sample;
  
  const textNode = document.createTextNode(prefix + selectedText + suffix);
  range.deleteContents();
  range.insertNode(textNode);
  
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPrivateNewLine() {
  if (!privateMessageInputRef.value) return;
  
  const input = privateMessageInputRef.value;
  
  if (input.tagName === 'DIV' && input.isContentEditable) {
    document.execCommand('insertHTML', false, '<br><br>');
  }
}

function handlePrivatePaste(e) {
  const items = e.clipboardData.items;
  let hasImageOrFile = false;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        uploadPrivateImage(file);
      }
      hasImageOrFile = true;
      break;
    } else if (item.type === 'application/octet-stream') {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        uploadPrivateFile(file);
      }
      hasImageOrFile = true;
      break;
    }
  }
  
  if (!hasImageOrFile) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain') || e.clipboardData.getData('text');
    if (text) {
      document.execCommand('insertText', false, text);
    }
  }
}

function handlePrivateDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

function handlePrivateDragEnter(e) {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    isDragOver.value = true;
  }
}

function handlePrivateDragLeave(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    isDragOver.value = false;
  }
}

function handlePrivateDrop(e) {
  e.preventDefault();
  dragCounter = 0;
  isDragOver.value = false;
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        uploadPrivateImage(file);
      } else {
        uploadPrivateFile(file);
      }
    }
    return;
  }
  
  const items = e.dataTransfer.items;
  if (items) {
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          if (file.type.startsWith('image/')) {
            uploadPrivateImage(file);
          } else {
            uploadPrivateFile(file);
          }
        }
        return;
      }
    }
  }
  
  const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
  if (text) {
    const privateMessageInput = document.getElementById('privateMessageInput');
    if (privateMessageInput) {
      privateMessageInput.focus();
      document.execCommand('insertText', false, text);
    }
  }
}

function handlePrivateImageUploadClick() {
  showImageInput.value = true;
  nextTick(() => {
    if (privateImageInputRef.value) {
      privateImageInputRef.value.click();
    }
  });
}

function handlePrivateFileUploadClick() {
  showFileInput.value = true;
  nextTick(() => {
    if (privateFileInputRef.value) {
      privateFileInputRef.value.click();
    }
  });
}

function handlePrivateImageUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadPrivateImage(file);
  }
  showImageInput.value = false;
  if (privateImageInputRef.value) {
    privateImageInputRef.value.value = '';
  }
}

function handlePrivateImageCancel() {
  showImageInput.value = false;
}

function handlePrivateFileUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadPrivateFile(file);
  }
  showFileInput.value = false;
  if (privateFileInputRef.value) {
    privateFileInputRef.value.value = '';
  }
}

function handlePrivateFileCancel() {
  showFileInput.value = false;
}

function handlePrivateVideoUploadClick() {
  showVideoInput.value = true;
  nextTick(() => {
    if (privateVideoInputRef.value) {
      privateVideoInputRef.value.click();
    }
  });
}

function handlePrivateVideoUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadPrivateVideo(file);
  }
  showVideoInput.value = false;
  if (privateVideoInputRef.value) {
    privateVideoInputRef.value.value = '';
  }
}

function handlePrivateVideoCancel() {
  showVideoInput.value = false;
}

const showSearchModal = ref(false);
const searchKeyword = ref('');

// 查找消息：浏览（无关键词按类型）+ 关键词查找都走后端 /api/messages/browse，
// scope=private 且只能查自己与当前好友的私信，权限边界由后端校验
const {
  searchResults,
  isSearching,
  hasSearched,
  isLoadingMore,
  hasMore,
  executeSearch: runMessageBrowse,
  loadMore
} = useMessageBrowse(() => ({
  scope: 'private',
  peerId: sessionStore.currentPrivateChatUserId
}));

function openSearchModal() {
  showSearchModal.value = true;
  showMoreFunctions.value = false;
}

function closeSearchModal() {
  showSearchModal.value = false;
  searchKeyword.value = '';
  searchResults.value = [];
}

async function executeSearch(keyword, types = []) {
  searchKeyword.value = String(keyword || '').trim();
  await runMessageBrowse(keyword, types);
  if (!searchKeyword.value) return;

  // 关键词模式：为命中的旧消息补充上下文到主列表，保证点击结果可以跳转定位
  try {
    const friendId = sessionStore.currentPrivateChatUserId;
    const prefix = `chats-${baseStore.currentUser?.id || 'guest'}`;
    const storageKey = `${prefix}-private-${friendId}`;

    const storageData = await localForage.getItem(storageKey);
    const allMessages = storageData?.messages || [];
    if (allMessages.length === 0 || searchResults.value.length === 0) return;

    const localMatched = searchResults.value.filter(
      (r) => allMessages.some((m) => m.id === r.id) && r.messageType !== 101 && r.messageType !== 102 && r.messageType !== 103
    );
    if (localMatched.length === 0) return;

    const minMatchedId = Math.min(...localMatched.map(m => m.id));

    const storeMessages = friendStore.privateMessages[friendId] || [];
    if (storeMessages.length === 0) return;
    const storeMinId = Math.min(...storeMessages.map(m => m.id));

    const startId = Math.max(1, minMatchedId - 20);
    const endId = storeMinId - 1;

    if (startId <= endId) {
      const messagesToAdd = allMessages
        .filter(msg => msg.id >= startId && msg.id <= endId && msg.messageType !== 101 && msg.messageType !== 102 && msg.messageType !== 103)
        .sort((a, b) => a.id - b.id);

      friendStore.prependPrivateMessages(friendId, messagesToAdd);
    }
  } catch (err) {
    console.error('补充搜索结果上下文失败:', err);
  }
}

function highlightKeyword(content) {
  if (!content || !searchKeyword.value) {
    if (!content) return content;
    const div = document.createElement('div');
    div.textContent = content;
    return div.innerHTML;
  }
  
  const keyword = searchKeyword.value.trim();
  
  const div = document.createElement('div');
  div.textContent = content;
  let escapedContent = div.innerHTML;
  
  const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escapedContent.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } else {
    return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}

function scrollToMessage(message) {
  closeSearchModal();
  const targetElement = privateMessageContainerRef.value?.querySelector(`[data-id="${message.id}"]`);
  if (targetElement) scrollAndHighlight(targetElement);
}

function isUserOnline(userId) {
  return userStore.onlineUsers.some(user => String(user.id) === String(userId));
}

function handlePrivateSwitched() {
  if (sessionStore.currentPrivateChatUserId) {
    isPrivateChatVisible.value = true;
    currentUserName.value = sessionStore.currentPrivateChatNickname;

    const avatarUrl = sessionStore.currentPrivateChatAvatarUrl;
    if (avatarUrl) {
      currentUserAvatarUrl.value = avatarUrl.startsWith('http') ? avatarUrl : `${SERVER_URL}${avatarUrl}`;
    } else {
      currentUserAvatarUrl.value = '';
      const displayName = displayCurrentUserName.value;
      currentUserInitials.value = displayName ? displayName.charAt(0).toUpperCase() : 'U';
    }
    
    restoringPrivateDraft = true;
    
    nextTick(() => {
      const messageInput = document.getElementById('privateMessageInput');
      if (messageInput) {
        messageInput.innerHTML = '';
        
        const draftContent = draftStore.getDraft('private', sessionStore.currentPrivateChatUserId);
        if (draftContent) {
          messageInput.innerHTML = draftContent;
          
          draftStore.saveDraft('private', sessionStore.currentPrivateChatUserId, '');
          draftStore.tempRestoreLastMessage('private', sessionStore.currentPrivateChatUserId);
          
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(messageInput);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        
        restoringPrivateDraft = false;
      }
    });
    
    setTimeout(() => {
      initializeScrollLoading(true);
    }, 100);
  }
}

onMounted(() => {
  applySavedPrivateState();
  
  setTimeout(() => {
    initializeScrollLoading(true);
  }, 100);

  setTimeout(() => {
    initializeImageClickEvents();
  }, 500);

  window.addEventListener('private-switched', handlePrivateSwitched);

  scrollToBottom();
  
  document.addEventListener('click', function(e) {
    const copyButton = e.target.closest('.copy-button');
    if (copyButton) {
      const code = copyButton.getAttribute('data-code');
      if (code) {
        const decodedCode = decodeURIComponent(code);
        const unescapedCode = decodedCode
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ');
        navigator.clipboard.writeText(unescapedCode).then(() => {
          const notice = copyButton.closest('.highlight-tools').querySelector('.copy-notice');
          if (notice) {
            notice.textContent = '已复制';
            notice.style.color = '#4CAF50';
            setTimeout(() => {
              notice.textContent = '';
            }, 2000);
          }
        }).catch(err => {
          console.error('复制失败:', err);
        });
      }
    }
  });
});

onUnmounted(() => {
  window.removeEventListener('private-switched', handlePrivateSwitched);
  // 离开私聊时保存草稿（消息页嵌入面板或独立路由页卸载均触发，此时 ref 仍指向输入框）
  const privateUserId = sessionStore.currentPrivateChatUserId;
  const inputEl = privateMessageInputRef.value;
  if (privateUserId && inputEl && !restoringPrivateDraft) {
    const content = inputEl.textContent || inputEl.innerHTML || '';
    draftStore.saveDraft('private', privateUserId, content);
    draftStore.setLastMessageToDraft('private', privateUserId);
  }
});

watch(
  () => sessionStore.currentPrivateChatUserId,
  (newUserId, oldUserId) => {
    if (newUserId && newUserId !== oldUserId) {
      if (scrollingInitialized) {
        scrollingInitialized.private = false;
      }
      if (privateChatAllLoaded && privateChatAllLoaded[newUserId] === undefined) {
        privateChatAllLoaded[newUserId] = false;
      }
      
      if (privateMessageInputRef.value) {
        privateMessageInputRef.value.innerHTML = '';
      }
      
      nextTick(() => {
        if (privateMessageContainerRef.value) {
          privateMessageContainerRef.value.scrollTop = 0;
        }
        scrollToBottom();
        setTimeout(() => {
          initializeScrollLoading(true);
        }, 100);
        setTimeout(() => {
          if (scrollingInitialized) {
            scrollingInitialized.private = true;
          }
        }, 600);
      });
    }
    if (!newUserId) {
      isPrivateChatVisible.value = false;
    }
  }
);

watch(
  () => privateMessages.value,
  (newMessages, oldMessages) => {
    // 加载更多（prepend）：首条消息 id 变化且末条不变，说明上方插入了更早的历史消息
    const isPrepend = oldMessages && oldMessages.length > 0
      && newMessages.length > oldMessages.length
      && String(newMessages[0].id) !== String(oldMessages[0].id)
      && String(newMessages[newMessages.length - 1].id) === String(oldMessages[oldMessages.length - 1].id);
    if (isPrepend) {
      // DOM 更新前捕获当前滚动位置（watch 默认 pre-flush，此时 DOM 还是旧的）
      const container = privateMessageContainerRef.value;
      const oldScrollHeight = container ? container.scrollHeight : undefined;
      const oldScrollTop = container ? container.scrollTop : undefined;
      // DOM 更新后、浏览器绘制前恢复位置，消除加载更多时顶部内容闪现一帧的问题
      nextTick(() => {
        const wrap = privateMessageContainerRef.value;
        if (wrap && oldScrollHeight !== undefined && oldScrollTop !== undefined) {
          wrap.scrollTop = wrap.scrollHeight - oldScrollHeight + oldScrollTop;
        }
      });
    } else if (newMessages.length > previousPrivateMessageLength) {
      if (isNearBottom()) {
        scrollToBottom();
      }
    }
    previousPrivateMessageLength = newMessages.length;
  },
  { deep: true }
);

watch(
  () => route.path,
  (newPath, oldPath) => {
    if (oldPath && oldPath.startsWith('/chat/private') && !newPath.startsWith('/chat/private')) {
      const currentPrivateUserId = sessionStore.currentPrivateChatUserId;
      if (currentPrivateUserId) {
        const privateMessageInput = document.getElementById('privateMessageInput');
        if (privateMessageInput) {
          const content = privateMessageInput.textContent || privateMessageInput.innerHTML || '';
          draftStore.saveDraft('private', currentPrivateUserId, content);
          draftStore.setLastMessageToDraft('private', currentPrivateUserId);
        }
      }
    }
    
    if (newPath.startsWith('/chat/private')) {
      if (scrollingInitialized) {
        scrollingInitialized.private = false;
      }
      
      const draftContent = draftStore.getDraft('private', sessionStore.currentPrivateChatUserId);
      if (draftContent) {
        restoringPrivateDraft = true;
        nextTick(() => {
          const messageInput = document.getElementById('privateMessageInput');
          if (messageInput) {
            messageInput.innerHTML = draftContent;
            draftStore.saveDraft('private', sessionStore.currentPrivateChatUserId, '');
            draftStore.tempRestoreLastMessage('private', sessionStore.currentPrivateChatUserId);
          }
          restoringPrivateDraft = false;
        });
      }
      
      scrollToBottom();
      inputStore.clearQuotedMessage();
      groupStore.clearOtherGroupMessages(null);
      friendStore.clearOtherPrivateMessages(sessionStore.currentPrivateChatUserId);
      unifiedStore.clearUnifiedMessagesExceptRecent();
      nextTick(() => {
        initializeScrollLoading(true);
      });
      setTimeout(() => {
        if (scrollingInitialized) {
          scrollingInitialized.private = true;
        }
      }, 600);
    }
  }
);
</script>

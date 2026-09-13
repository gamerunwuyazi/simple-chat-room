<template>
  <div class="chat-content" data-content="public-chat">
    <div id="markdownToolbar" class="markdown-toolbar" v-if="showMarkdownToolbar">
      <button class="markdown-btn" @click="insertMarkdown('**', '**', '粗体文本')">粗体</button>
      <button class="markdown-btn" @click="insertMarkdown('_', '_', '斜体文本')">斜体</button>
      <button class="markdown-btn" @click="insertMarkdown('`', '`', '代码')">代码</button>
      <button class="markdown-btn" @click="insertMarkdown('```\n', '\n```', '代码块')">代码块</button>
      <button class="markdown-btn" @click="insertMarkdown('# ', '', '标题')">标题</button>
      <button class="markdown-btn" @click="insertMarkdown('- ', '', '列表项')">列表</button>
      <button class="markdown-btn" @click="insertMarkdown('> ', '', '引用文本')">引用</button>
      <button class="markdown-btn" @click="insertMarkdown('[链接描述](', ')', '链接文本')">链接</button>
      <button class="markdown-btn" @click="insertMarkdown('![图片无法显示时的文字](', ')', '图片URL')">图片</button>
    </div>

    <div id="messageContainer" ref="messageContainerRef">
      <template v-if="publicStore.publicMessages.length !== 0">
        <template v-for="segment in publicMessageSegments" :key="segment.key">
          <div v-if="segment.showDivider" class="date-divider">{{ segment.label }}</div>
          <PublicMessageItem
            v-for="message in segment.messages"
            :key="message.id"
            :message="message"
            :is-own="isOwnMessage(message)"
          />
        </template>
      </template>
      <div v-else class="empty-state" id="emptyState">
        <h3>暂无消息</h3>
        <p>发送第一条消息开始聊天吧!</p>
      </div>
    </div>

    <div class="input-area">
      <QuotedMessagePreview v-if="inputStore.quotedMessage" :quoted-message="inputStore.quotedMessage" @close="inputStore.clearQuotedMessage()" />
      <div class="input-container" id="mainInputContainer" 
        @drop="handleDrop"
        @dragover="handleDragOver"
        @dragenter="handleDragEnter"
        @dragleave="handleDragLeave">
        <div 
          ref="messageInputRef"
          id="messageInput" 
          class="editable-div" 
          placeholder="发送消息（Ctrl+Enter或Shift+Enter换行  打开md工具栏即可支持Markdown语法）" 
          contenteditable="true"
          @keydown="handleMessageInputKeydown"
          @input="handleMessageInput"
          @paste="handlePaste"
          @compositionstart="isComposing = true"
          @compositionend="handleCompositionEnd"
        ></div>
        <div v-if="showAtPicker" class="at-picker" :style="{ top: atPickerPosition.top + 'px', left: atPickerPosition.left + 'px' }">
          <div 
            v-for="(user, index) in filteredAtSuggestions" 
            :key="user.id"
            class="at-picker-item"
            :class="{ selected: index === selectedAtIndex }"
            @click="selectAtUser(user)"
          >
            <div class="user-avatar-wrapper">
              <component 
                :is="getAvatarIsImage(user) ? 'img' : 'div'"
                :src="getAvatarIsImage(user) ? getFullAvatarUrl(user) : undefined"
                :alt="user.nickname"
                class="user-avatar"
                :class="{ 'default-avatar': !getAvatarIsImage(user) }"
                @error="handleAvatarError(user.id)"
              >
                {{ !getAvatarIsImage(user) ? getUserInitials(user) : '' }}
              </component>
            </div>
            <span class="at-picker-nickname">{{ user.nickname }}</span>
          </div>
          <div v-if="filteredAtSuggestions.length === 0" class="at-picker-empty">暂无在线用户</div>
        </div>
        <div v-if="isDragOver" class="drop-overlay">
          <div class="drop-content">
            <i class="fas fa-cloud-upload-alt"></i>
            <p>松开即可发送</p>
          </div>
        </div>
      </div>
      <div class="input-buttons" id="mainInputButtons">
        <button id="sendButton" @click="handleSendMessage">发送</button>
        <button id="moreButton" class="more-button" title="更多功能" @click="toggleMoreFunctions">
          ⋯ <span class="button-text">更多</span>
        </button>
        <button class="toggle-btn" 
          @click="toggleMarkdownToolbar">
          <i v-if="!showMarkdownToolbar" class="fas fa-chevron-down"></i>
          <i v-else class="fas fa-chevron-up"></i>
          {{ showMarkdownToolbar ? ' 隐藏Markdown工具栏' : ' MD' }}
        </button>
      </div>
      <div v-if="showMoreFunctions" class="more-functions" id="mainMoreFunctions">
        <button id="imageUploadButton" title="上传图片" @click="handleImageUploadClick">
          <i class="fas fa-image"></i> <span class="button-text">发送图片</span>
        </button>
        <button id="fileUploadButton" title="上传文件" @click="handleFileUploadClick">
          <i class="fas fa-file-upload"></i> <span class="button-text">发送文件</span>
        </button>
        <button id="videoUploadButton" title="上传视频" @click="handleVideoUploadClick">
          <i class="fas fa-video"></i> <span class="button-text">发送视频</span>
        </button>
        <button id="sendGroupCardButton" title="发送群名片" @click="handleSendGroupCard">
          <i class="fas fa-address-card"></i> <span class="button-text">发送群名片</span>
        </button>
        <button id="searchMessageButton" title="查找消息" @click="openSearchModal">
          <i class="fas fa-search"></i> <span class="button-text">查找消息</span>
        </button>
      </div>
      <input v-if="showImageInput" type="file" ref="imageInputRef" id="imageInput" style="display: none;" accept="image/*" @change="handleImageUpload" @cancel="handleImageCancel">
      <input v-if="showFileInput" type="file" ref="fileInputRef" id="fileInput" style="display: none;" @change="handleFileUpload" @cancel="handleFileCancel">
      <input v-if="showVideoInput" type="file" ref="videoInputRef" id="videoInput" style="display: none;" accept="video/*" @change="handleVideoUpload" @cancel="handleVideoCancel">
    </div>

    <div v-if="inputStore.showUploadProgress" class="upload-progress" id="uploadProgress">
      <div class="upload-progress-bar" id="uploadProgressBar" :style="{ width: inputStore.uploadProgress + '%' }"></div>
    </div>

    <SearchMessageModal
      v-model="showSearchModal"
      :search-results="searchResults"
      :is-searching="isSearching"
      :has-searched="hasSearched"
      @search="executeSearch"
      @navigate-prev="navigateToPrevSearchResult"
      @navigate-next="navigateToNextSearchResult"
      @scroll-to-message="scrollToMessage"
    >
      <template #results="{ results, onClick }">
        <PublicMessageItem
          v-for="result in results"
          :key="result.id"
          :message="result"
          :is-search-result="true"
          @click="onClick(result)"
        />
      </template>
    </SearchMessageModal>
  </div>
</template>

<style scoped>
.chat-at-user {
  color: #00f;
  border-radius: 3px;
}

.at-picker {
  position: fixed;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-height: 250px;
  overflow-y: auto;
  z-index: 10000;
  min-width: 200px;
}

.at-picker-item {
  padding: 10px 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.at-picker-item:last-child {
  border-bottom: none;
}

.at-picker-item:hover,
.at-picker-item.selected {
  background: #f5f5f5;
}

.user-avatar-wrapper {
  position: relative;
  display: inline-flex;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background-color: #e0e0e0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  color: #666;
  font-size: 14px;
  object-fit: cover;
}

.at-picker-nickname {
  font-weight: 500;
  color: #333;
}

.at-picker-empty {
  padding: 15px;
  text-align: center;
  color: #999;
}

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
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useRoute } from "vue-router";

import PublicMessageItem from "@/components/MessageItem/PublicMessageItem.vue";
import QuotedMessagePreview from "@/components/MessageItem/QuotedMessagePreview.vue";
import { useBaseStore } from "@/stores/baseStore";
import { useUserStore } from "@/stores/userStore";
import { usePublicStore } from "@/stores/publicStore";
import { useInputStore } from "@/stores/inputStore";
import { useDraftStore } from "@/stores/draftStore";
import { useGroupStore } from "@/stores/groupStore";
import { useFriendStore } from "@/stores/friendStore";
import { useUnreadStore } from "@/stores/unreadStore";
import { 
  uploadImage,
  uploadFile,
  uploadVideo,
  initializeScrollLoading,
  sendMessage,
  showSendGroupCardModal,
  resetLoadingState,
  updateUnreadCountsDisplay
} from "@/utils/chat";
import { clearContentEditable, buildDateSegments } from "@/utils/chat/message.js";
import { useMessageHighlight } from "@/composables/useMessageHighlight";
import { useSearchNavigation } from "@/composables/useSearchNavigation";
import SearchMessageModal from "@/components/SearchMessageModal.vue";

const baseStore = useBaseStore();
const userStore = useUserStore();
const publicStore = usePublicStore();
const inputStore = useInputStore();
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
const friendStore = useFriendStore();
const unreadStore = useUnreadStore();
const route = useRoute();

// 按天分组渲染日期分隔标签，避免每条消息都产生一个 v-if 占位节点
const publicMessageSegments = computed(() => buildDateSegments(publicStore.publicMessages, publicStore.isPublicAllLoaded()));

let scrollingInitialized = { public: false };

const messageInputRef = ref(null);
const imageInputRef = ref(null);
const fileInputRef = ref(null);
const videoInputRef = ref(null);
const messageContainerRef = ref(null);
const isDragOver = ref(false);
const showImageInput = ref(false);
const showFileInput = ref(false);
const showVideoInput = ref(false);
let dragCounter = 0;
let previousPublicMessageLength = 0;

const currentUserId = computed(() => baseStore.currentUser?.id);

function isOwnMessage(message) {
  if (!currentUserId.value) return false;
  return String(message.userId) === String(currentUserId.value) || 
         (message.user && String(message.user.id) === String(currentUserId.value));
}

function scrollToBottom() {
  nextTick(() => {
    if (messageContainerRef.value) {
      messageContainerRef.value.scrollTop = messageContainerRef.value.scrollHeight;
    }
  });
}

function isNearBottom() {
  if (!messageContainerRef.value) return false;
  const container = messageContainerRef.value;
  const threshold = 150;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

watch(
  () => publicStore.publicMessages,
  (newMessages, oldMessages) => {
    // 加载更多（prepend）：首条消息 id 变化且末条不变，说明上方插入了更早的历史消息
    const isPrepend = oldMessages && oldMessages.length > 0
      && newMessages.length > oldMessages.length
      && String(newMessages[0].id) !== String(oldMessages[0].id)
      && String(newMessages[newMessages.length - 1].id) === String(oldMessages[oldMessages.length - 1].id);
    if (isPrepend) {
      // DOM 更新前捕获当前滚动位置（watch 默认 pre-flush，此时 DOM 还是旧的）
      const container = messageContainerRef.value;
      const oldScrollHeight = container ? container.scrollHeight : undefined;
      const oldScrollTop = container ? container.scrollTop : undefined;
      // DOM 更新后、浏览器绘制前恢复位置：向上补偿上方新增内容的高度差，
      // 消除加载更多时顶部内容（含日期分隔）闪现一帧的问题
      nextTick(() => {
        const wrap = messageContainerRef.value;
        if (wrap && oldScrollHeight !== undefined && oldScrollTop !== undefined) {
          wrap.scrollTop = wrap.scrollHeight - oldScrollHeight + oldScrollTop;
        }
      });
    } else if (newMessages.length > previousPublicMessageLength) {
      if (isNearBottom()) {
        scrollToBottom();
      }
    }
    previousPublicMessageLength = newMessages.length;
  },
  { deep: true }
);

watch(
  () => route.path,
  (newPath, oldPath) => {
    if ((oldPath === '/chat' || oldPath === '/chat/') && (newPath !== '/chat' && newPath !== '/chat/')) {
      const mainMessageInput = document.getElementById('messageInput');
      if (mainMessageInput) {
        inputStore.mainMessageInput = mainMessageInput.innerHTML;
      }
    }
    
    if (newPath === '/chat' || newPath === '/chat/') {
      if (scrollingInitialized) {
        scrollingInitialized.public = false;
      }
      
      if (inputStore.mainMessageInput) {
        nextTick(() => {
          const mainMessageInput = document.getElementById('messageInput');
          if (mainMessageInput) {
            mainMessageInput.innerHTML = inputStore.mainMessageInput;
            inputStore.mainMessageInput = '';
          }
        });
      }
      
      scrollToBottom();
      setTimeout(() => {
        scrollToBottom();
      }, 200);
      setTimeout(() => {
        scrollToBottom();
      }, 500);
      inputStore.clearQuotedMessage();
      groupStore.clearOtherGroupMessages(null);
      friendStore.clearOtherPrivateMessages(null);
      publicStore.clearPublicMessagesExceptRecent();
      nextTick(() => {
        initializeScrollLoading(true);
      });
      setTimeout(() => {
        if (scrollingInitialized) {
          scrollingInitialized.public = true;
        }
      }, 600);

      // 切换到主聊天室时绑定一次性点击事件清除未读
      setTimeout(() => {
        bindOneTimePublicUnreadClear();
      }, 100);
    }
  }
);

onMounted(() => {
  if (scrollingInitialized) {
    scrollingInitialized.public = false;
  }
  
  nextTick(() => {
    if (inputStore.mainMessageInput) {
      const mainMessageInput = document.getElementById('messageInput');
      if (mainMessageInput) {
        mainMessageInput.innerHTML = inputStore.mainMessageInput;
        inputStore.mainMessageInput = '';
      }
    }
  });
  
  scrollToBottom();
  
  setTimeout(() => {
    initializeScrollLoading(true);
  }, 100);
  setTimeout(() => {
    if (scrollingInitialized) {
      scrollingInitialized.public = true;
    }
  }, 600);
  
  function hideAtPickerOnClick(e) {
    if (!showAtPicker.value) return;
    const atPicker = document.querySelector('.at-picker');
    const messageInput = document.getElementById('messageInput');
    if (atPicker && messageInput && 
        !atPicker.contains(e.target) && 
        !messageInput.contains(e.target)) {
      showAtPicker.value = false;
    }
  }
  
  document.addEventListener('click', function(e) {
    hideAtPickerOnClick(e);
    
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
  
  document.addEventListener('contextmenu', function(e) {
    hideAtPickerOnClick(e);
  });

  // 初始化时绑定一次性点击事件清除主聊天室未读
  setTimeout(() => {
    bindOneTimePublicUnreadClear();
  }, 300);
});

function bindOneTimePublicUnreadClear() {
  const isMainChat = route.path === '/chat' || route.path === '/chat/';
  if (!isMainChat) return;

  const publicChatEl = document.querySelector('.chat-content[data-content="public-chat"]');
  if (!publicChatEl) return;

  function onFirstClick() {
    if (unreadStore) {
      unreadStore.clearGlobalUnread();
      unreadStore.enqueueUnreadClear('global');
      updateUnreadCountsDisplay();
    }
    publicChatEl.removeEventListener('click', onFirstClick);
  }
  publicChatEl.addEventListener('click', onFirstClick, { once: true });
}

const showMarkdownToolbar = ref(false);
const showMoreFunctions = ref(false);
const showAtPicker = ref(false);
const atPickerPosition = ref({ top: 0, left: 0 });
const atSuggestions = ref([]);
const filteredAtSuggestions = ref([]);
const selectedAtIndex = ref(0);
const atTriggerPosition = ref(0);
const isComposing = ref(false);
const avatarLoadFailedMap = ref({});

function getAvatarIsImage(user) {
  return getFullAvatarUrl(user) !== '' && !avatarLoadFailedMap.value[user.id];
}

function getFullAvatarUrl(user) {
  const avatarUrl = user.avatarUrl;
  if (!avatarUrl) return '';
  if (/^\.(svg)$/i.test(avatarUrl) || avatarUrl.includes('.svg')) return '';
  return avatarUrl.startsWith('http') ? avatarUrl : `${baseStore.SERVER_URL}${avatarUrl}`;
}

function getUserInitials(user) {
  const nickname = user.nickname || 'U';
  return nickname.charAt(0).toUpperCase();
}

function handleAvatarError(userId) {
  avatarLoadFailedMap.value[userId] = true;
}

function toggleMarkdownToolbar() {
  showMarkdownToolbar.value = !showMarkdownToolbar.value;
}

function toggleMoreFunctions() {
  showMoreFunctions.value = !showMoreFunctions.value;
}

function handleMessageInput() {
  if (messageInputRef.value) {
    const input = messageInputRef.value;
    
    const textContent = input.textContent;
    const htmlContent = input.innerHTML;
    
    if (textContent === '' && (!htmlContent || htmlContent === '<br>' || htmlContent === '<br/>' || htmlContent === '<br />')) {
      input.innerHTML = '';
      showAtPicker.value = false;
      inputStore.mainMessageInput = '';
      return;
    }
    
    inputStore.mainMessageInput = input.innerHTML;
    
    const maxHeight = 180;
    if (input.scrollHeight > maxHeight) {
      input.style.overflowY = 'auto';
    } else {
      input.style.overflowY = 'hidden';
    }
    
    if (isComposing.value) {
      return;
    }
    
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const textNode = range.startContainer;
      
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const text = textNode.textContent;
        const cursorPos = range.startOffset;
        
        const textBeforeCursor = text.substring(0, cursorPos);
        const atIndex = textBeforeCursor.lastIndexOf('@');
        
        if (atIndex !== -1) {
          const textAfterAt = textBeforeCursor.substring(atIndex + 1);
          if (!textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
            atTriggerPosition.value = atIndex;
            
            atTriggerInfo = {
              textNode: textNode,
              atIndex: atIndex,
              cursorPos: cursorPos
            };
            
            const allOnlineUsers = userStore.onlineUsers || [];
            atSuggestions.value = allOnlineUsers
              .filter(user => user && String(user.id) !== String(baseStore.currentUser?.id))
              .map(user => ({
                id: user.id,
                nickname: user.nickname || user.name || '未知用户',
                username: user.nickname || user.name || String(user.id),
                avatarUrl: user.avatarUrl || user.avatar_url || null
              }))
              .filter(u => u.username);
            
            const searchText = textAfterAt.toLowerCase();
            if (searchText) {
              filteredAtSuggestions.value = atSuggestions.value
                .map(user => {
                  const nicknameLower = (user.nickname || '').toLowerCase();
                  const usernameLower = (user.username || '').toLowerCase();
                  
                  let score = 0;
                  if (nicknameLower === searchText || usernameLower === searchText) {
                    score = 100;
                  } else if (nicknameLower.startsWith(searchText) || usernameLower.startsWith(searchText)) {
                    score = 80;
                  } else if (nicknameLower.includes(searchText) || usernameLower.includes(searchText)) {
                    score = 60;
                  } else {
                    score = 0;
                  }
                  
                  return { ...user, score };
                })
                .filter(user => user.score > 0)
                .sort((a, b) => b.score - a.score);
            } else {
              filteredAtSuggestions.value = [...atSuggestions.value];
            }
            
            if (filteredAtSuggestions.value.length > 0) {
              const inputRect = messageInputRef.value.getBoundingClientRect();
              const pickerMaxHeight = 250;
              const estimatedHeight = Math.min(filteredAtSuggestions.value.length * 45 + 20, pickerMaxHeight);
              atPickerPosition.value = {
                top: inputRect.top - estimatedHeight,
                left: inputRect.left
              };
            }
            
            selectedAtIndex.value = 0;
            showAtPicker.value = filteredAtSuggestions.value.length > 0;
          } else {
            showAtPicker.value = false;
          }
        } else {
          showAtPicker.value = false;
        }
      } else {
        showAtPicker.value = false;
      }
    }
  }
}

function handleCompositionEnd() {
  isComposing.value = false;
  handleMessageInput();
}

function isMobileDevice() {
  return window.innerWidth <= 768;
}

function handleMessageInputKeydown(e) {
  if (showAtPicker.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedAtIndex.value = (selectedAtIndex.value + 1) % filteredAtSuggestions.value.length;
      return;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedAtIndex.value = (selectedAtIndex.value - 1 + filteredAtSuggestions.value.length) % filteredAtSuggestions.value.length;
      return;
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (filteredAtSuggestions.value.length > 0) {
        selectAtUser(filteredAtSuggestions.value[selectedAtIndex.value]);
      }
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showAtPicker.value = false;
      return;
    }
  }
  
  if (e.key === 'Backspace') {
    setTimeout(() => {
      if (!messageInputRef.value) return;
      const s = messageInputRef.value.innerHTML.trim();
      if (s === '' || s === '<br>' || s === '<div>&nbsp;</div>') {
        clearContentEditable(messageInputRef.value);
      }
    }, 0);
  }
  
  const isMobile = isMobileDevice();
  
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
    if (isMobile) {
      return;
    }
    e.preventDefault();
    handleSendMessage();
  } else if (e.key === 'Enter' && (e.ctrlKey || (isMobile && !e.shiftKey))) {
    e.preventDefault();
    insertNewLine();
  } else if (e.key === 'm' && e.ctrlKey) {
    e.preventDefault();
    toggleMarkdownToolbar();
  }
}

function handleSendMessage() {
  sendMessage();
  scrollToBottom();
}

let atTriggerInfo = null;

function selectAtUser(user) {
  if (!messageInputRef.value) return;
  
  const input = messageInputRef.value;
  const selection = window.getSelection();
  
  input.focus();
  
  if (atTriggerInfo && atTriggerInfo.textNode && atTriggerInfo.atIndex !== -1) {
    const textNode = atTriggerInfo.textNode;
    const atIndex = atTriggerInfo.atIndex;
    const cursorPos = atTriggerInfo.cursorPos;
    
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      
      range.setStart(textNode, atIndex);
      range.setEnd(textNode, cursorPos);
      range.deleteContents();
      range.collapse(true);
      
      const element = document.createElement('SPAN');
      element.className = 'chat-at-user';
      element.dataset.id = user.id;
      element.contentEditable = 'false';
      element.innerText = `@${user.username}`;
      range.insertNode(element);
      
      range.setStartAfter(element);
      range.collapse(true);
      
      const textNodeSpace = document.createTextNode(' ');
      range.insertNode(textNodeSpace);
      
      range.setStartAfter(textNodeSpace);
      range.collapse(true);
      
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    
    let textNode = range.startContainer;
    let cursorPos = range.startOffset;
    let atIndex = -1;
    
    while (textNode && textNode.nodeType !== Node.TEXT_NODE) {
      if (textNode.previousSibling) {
        textNode = textNode.previousSibling;
        while (textNode.lastChild) {
          textNode = textNode.lastChild;
        }
        if (textNode.nodeType === Node.TEXT_NODE) {
          cursorPos = textNode.textContent.length;
        }
      } else {
        textNode = textNode.parentNode;
      }
    }
    
    if (textNode && textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent;
      const textBeforeCursor = text.substring(0, cursorPos);
      atIndex = textBeforeCursor.lastIndexOf('@');
      
      if (atIndex !== -1) {
        range.setStart(textNode, atIndex);
        range.setEnd(textNode, cursorPos);
        range.deleteContents();
        range.collapse(true);
        
        const element = document.createElement('SPAN');
        element.className = 'chat-at-user';
        element.dataset.id = user.id;
        element.contentEditable = 'false';
        element.innerText = `@${user.username}`;
        range.insertNode(element);
        
        range.setStartAfter(element);
        range.collapse(true);
        
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }
  
  atTriggerInfo = null;
  showAtPicker.value = false;
  inputStore.mainMessageInput = input.innerHTML;
  input.focus();
}

function handleSendGroupCard() {
  showSendGroupCardModal('main');
}

function insertMarkdown(prefix, suffix, sample) {
  if (!messageInputRef.value) return;
  
  const input = messageInputRef.value;
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

function insertNewLine() {
  if (!messageInputRef.value) return;
  
  const input = messageInputRef.value;
  
  if (input.tagName === 'DIV' && input.isContentEditable) {
    document.execCommand('insertHTML', false, '<br><br>');
  } else {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    
    const br = document.createElement('br');
    range.deleteContents();
    range.insertNode(br);
    
    range.setStartAfter(br);
    range.setEndAfter(br);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function handlePaste(e) {
  const items = e.clipboardData.items;
  let hasImageOrFile = false;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        uploadImage(file);
      }
      hasImageOrFile = true;
      break;
    } else if (item.type === 'application/octet-stream') {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        uploadFile(file);
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

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

function handleDragEnter(e) {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    isDragOver.value = true;
  }
}

function handleDragLeave(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    isDragOver.value = false;
  }
}

function handleDrop(e) {
  e.preventDefault();
  dragCounter = 0;
  isDragOver.value = false;
  
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        uploadImage(file);
      } else {
        uploadFile(file);
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
            uploadImage(file);
          } else {
            uploadFile(file);
          }
        }
        return;
      }
    }
  }
  
  const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
  if (text) {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      messageInput.focus();
      document.execCommand('insertText', false, text);
    }
  }
}

function handleImageUploadClick() {
  showImageInput.value = true;
  nextTick(() => {
    if (imageInputRef.value) {
      imageInputRef.value.click();
    }
  });
}

function handleFileUploadClick() {
  showFileInput.value = true;
  nextTick(() => {
    if (fileInputRef.value) {
      fileInputRef.value.click();
    }
  });
}

function handleImageUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadImage(file);
  }
  showImageInput.value = false;
  if (imageInputRef.value) {
    imageInputRef.value.value = '';
  }
}

function handleImageCancel() {
  showImageInput.value = false;
}

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadFile(file);
  }
  showFileInput.value = false;
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
}

function handleFileCancel() {
  showFileInput.value = false;
}

function handleVideoUploadClick() {
  showVideoInput.value = true;
  nextTick(() => {
    if (videoInputRef.value) {
      videoInputRef.value.click();
    }
  });
}

function handleVideoUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadVideo(file);
  }
  showVideoInput.value = false;
  if (videoInputRef.value) {
    videoInputRef.value.value = '';
  }
}

function handleVideoCancel() {
  showVideoInput.value = false;
}

const showSearchModal = ref(false);
const searchKeyword = ref('');
const searchResults = ref([]);
const isSearching = ref(false);
const hasSearched = ref(false);

function openSearchModal() {
  showSearchModal.value = true;
  showMoreFunctions.value = false;
}

function closeSearchModal() {
  showSearchModal.value = false;
  searchKeyword.value = '';
  searchResults.value = [];
  hasSearched.value = false;
}

async function executeSearch(keyword) {
  if (!keyword || !keyword.trim()) return;
  searchKeyword.value = keyword;
  
  isSearching.value = true;
  hasSearched.value = false;
  searchResults.value = [];
  
  try {
    const prefix = `chats-${baseStore.currentUser?.id || 'guest'}`;
    const storageKey = `${prefix}-public`;
    
    const storageData = await localForage.getItem(storageKey);
    const allMessages = storageData?.messages || [];
    const keyword = searchKeyword.value.trim().toLowerCase();
    
    const matchedMessages = allMessages
      .filter(msg => {
        if (msg.messageType === 101 || msg.messageType === 102 || msg.messageType === 103) return false;
        const content = msg.content?.toLowerCase() || '';
        const nickname = msg.nickname?.toLowerCase() || '';
        return content.includes(keyword) || nickname.includes(keyword);
      });
    
    if (matchedMessages.length > 0) {
      searchResults.value = [...matchedMessages].reverse();
      
      const minMatchedId = Math.min(...matchedMessages.map(m => m.id));
      
      const storeMessages = publicStore.publicMessages;
      if (storeMessages.length > 0) {
        const storeMinId = Math.min(...storeMessages.map(m => m.id));
        
        const startId = Math.max(1, minMatchedId - 20);
        const endId = storeMinId - 1;
        
        if (startId <= endId) {
          const messagesToAdd = allMessages
            .filter(msg => msg.id >= startId && msg.id <= endId && msg.messageType !== 101 && msg.messageType !== 102 && msg.messageType !== 103)
            .sort((a, b) => a.id - b.id);
          
          publicStore.prependPublicMessages(messagesToAdd);
        }
      }
    }
    
    hasSearched.value = true;
  } catch (err) {
    console.error('搜索失败:', err);
  } finally {
    isSearching.value = false;
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
  const messageElement = document.querySelector(`[data-id="${message.id}"]`);
  if (messageElement) {
    scrollAndHighlight(messageElement);
    return;
  }
  const allMessages = publicStore.publicMessages;
  const messageIndex = allMessages.findIndex(m => m.id === message.id);
  if (messageIndex !== -1 && messageContainerRef.value) {
    const messageElements = messageContainerRef.value.querySelectorAll('.message');
    const targetElement = messageElements[messageIndex];
    if (targetElement) scrollAndHighlight(targetElement);
  }
}


</script>

<template>
  <div class="chat-content" data-content="group-chat">
    <div v-if="!isGroupChatVisible" class="empty-chat-state">
      <h3>选择一个群组开始聊天</h3>
      <p>请从左侧群组列表中选择一个群组，开始群聊会话</p>
    </div>

    <div v-else class="group-chat-interface">
      <div class="group-header">
        <h2>{{ displayGroupName }}</h2>
        <div class="group-actions">
          <button id="groupInfoButton" @click="handleGroupInfoClick">群组信息</button>
        </div>
      </div>

      <div class="markdown-toolbar group-markdown-toolbar" v-if="showMarkdownToolbar">
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

      <div id="groupMessageContainer" ref="groupMessageContainerRef">
        <template v-if="groupMessages.length !== 0">
          <GroupMessageItem
            v-for="message in groupMessages"
            :key="message.id"
            :message="message"
            :is-own="isOwnMessage(message)"
          />
        </template>
        <div v-else class="empty-state">
          <h3>暂无群消息</h3>
          <p>发送第一条消息开始群聊吧!</p>
        </div>
      </div>
      <div class="input-area">
        <QuotedMessagePreview v-if="inputStore.quotedMessage" :quoted-message="inputStore.quotedMessage" @close="inputStore.clearQuotedMessage()" />
        <div class="input-container"
          @drop="handleGroupDrop"
          @dragover="handleGroupDragOver"
          @dragenter="handleGroupDragEnter"
          @dragleave="handleGroupDragLeave">
          <div class="editable-div"
            id="groupMessageInput" 
            @keydown="handleGroupMessageInputKeydown"
            @paste="handleGroupPaste"
            ref="groupMessageInputRef"
            contenteditable="true"
            placeholder="发送消息（Ctrl+Enter或Shift+Enter换行  打开md工具栏即可支持Markdown语法）"
            @input="handleGroupMessageInput"
            @compositionstart="isComposing = true"
            @compositionend="handleGroupCompositionEnd"
          ></div>
          <div v-if="showAtPicker" class="at-picker" :style="{ top: atPickerPosition.top + 'px', left: atPickerPosition.left + 'px' }">
            <div 
              v-for="(user, index) in filteredAtSuggestions" 
              :key="user.id"
              class="at-picker-item"
              :class="{ selected: index === selectedAtIndex, 'all-members': user.isAll }"
              @click="selectGroupAtUser(user)"
            >
              <div class="user-avatar-wrapper">
                <template v-if="user.isAll">
                  <div class="all-members-avatar" style="width: 32px; height: 32px; border-radius: 50%; background-color: #4CAF50; display: flex; align-items: center; justify-content: center; font-weight: bold; color: white; font-size: 12px;">
                    全
                  </div>
                </template>
                <template v-else>
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
                  <div v-if="user.isOnline" class="online-indicator"></div>
                </template>
              </div>
              <span class="at-picker-nickname">{{ user.nickname }}</span>
            </div>
            <div v-if="filteredAtSuggestions.length === 0" class="at-picker-empty">暂无群成员</div>
          </div>
          <div v-if="isDragOver" class="drop-overlay">
            <div class="drop-content">
              <i class="fas fa-cloud-upload-alt"></i>
              <p>松开即可发送</p>
            </div>
          </div>
        </div>
        <div class="input-buttons" id="groupInputButtons">
          <button id="sendGroupMessage" @click="handleSendGroupMessage">发送</button>
          <button id="groupMoreButton" class="more-button" title="更多功能" @click="toggleMoreFunctions">
            ⋯ <span class="button-text">更多</span>
          </button>
          <button class="toggle-btn" 
            @click="toggleMarkdownToolbar">
            <i v-if="!showMarkdownToolbar" class="fas fa-chevron-down"></i>
            <i v-else class="fas fa-chevron-up"></i>
            {{ showMarkdownToolbar ? ' 隐藏Markdown工具栏' : ' MD' }}
          </button>
        </div>
        <div v-if="showMoreFunctions" class="more-functions" id="groupMoreFunctions">
          <button id="groupImageUploadButton" title="上传图片" @click="handleGroupImageUploadClick">
            <i class="fas fa-image"></i> <span class="button-text">发送图片</span>
          </button>
          <button id="groupFileUploadButton" title="上传文件" @click="handleGroupFileUploadClick">
          <i class="fas fa-file-upload"></i> <span class="button-text">发送文件</span>
        </button>
        <button id="groupVideoUploadButton" title="上传视频" @click="handleGroupVideoUploadClick">
          <i class="fas fa-video"></i> <span class="button-text">发送视频</span>
        </button>
          <button id="sendGroupCardButtonGroup" title="发送群名片" @click="handleSendGroupCard">
            <i class="fas fa-address-card"></i> <span class="button-text">发送群名片</span>
          </button>
          <button id="groupSearchMessageButton" title="查找消息" @click="openSearchModal">
            <i class="fas fa-search"></i> <span class="button-text">查找消息</span>
          </button>
        </div>
        <input v-if="showImageInput" type="file" ref="groupImageInputRef" id="groupImageInput" style="display: none;" accept="image/*" @change="handleGroupImageUpload" @cancel="handleGroupImageCancel">
        <input v-if="showFileInput" type="file" ref="groupFileInputRef" id="groupFileInput" style="display: none;" @change="handleGroupFileUpload" @cancel="handleGroupFileCancel">
        <input v-if="showVideoInput" type="file" ref="groupVideoInputRef" id="groupVideoInput" style="display: none;" accept="video/*" @change="handleGroupVideoUpload" @cancel="handleGroupVideoCancel">
      </div>

      <div v-if="inputStore.showUploadProgress" class="upload-progress" id="groupUploadProgress">
        <div class="upload-progress-bar" id="groupUploadProgressBar" :style="{ width: inputStore.uploadProgress + '%' }"></div>
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
          <GroupMessageItem
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

.at-picker-item.all-members {
  background: linear-gradient(135deg, #e8f5e9 0%, #c8e6c9 100%);
  border-bottom: 2px solid #4CAF50;
}

.at-picker-item.all-members:hover,
.at-picker-item.all-members.selected {
  background: linear-gradient(135deg, #c8e6c9 0%, #a5d6a7 100%);
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

.online-indicator {
  position: absolute;
  right: -2px;
  bottom: 0;
  width: 10px;
  height: 10px;
  background: limegreen;
  border-radius: 50%;
  border: 2px solid white;
  z-index: 1;
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
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { useRoute } from "vue-router";

import GroupMessageItem from "@/components/MessageItem/GroupMessageItem.vue";
import QuotedMessagePreview from "@/components/MessageItem/QuotedMessagePreview.vue";
import { useBaseStore } from "@/stores/baseStore";
import { useUserStore } from "@/stores/userStore";
import { useGroupStore } from "@/stores/groupStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useInputStore } from "@/stores/inputStore";
import { useDraftStore } from "@/stores/draftStore";
import { useFriendStore } from "@/stores/friendStore";
import { usePublicStore } from "@/stores/publicStore";
import { useModalStore } from "@/stores/modalStore";
import { 
  setActiveChat, 
  loadGroupMessages, 
  initializeScrollLoading, 
  uploadImage, 
  uploadFile, 
  uploadVideo, 
  clearContentEditable,
  sendGroupMessage,
  showSendGroupCardModal,
  resetLoadingState,
  switchingGroupWithExistingMessages
} from "@/utils/chat";
import toast from "@/utils/toast";
import { useMessageHighlight } from "@/composables/useMessageHighlight";
import SearchMessageModal from "@/components/SearchMessageModal.vue";
import { getGroupInfo, getGroupMembers } from '@/api/group.js';

const baseStore = useBaseStore();
const userStore = useUserStore();
const groupStore = useGroupStore();
const sessionStore = useSessionStore();
const inputStore = useInputStore();
const draftStore = useDraftStore();
const { scrollAndHighlight } = useMessageHighlight();
const friendStore = useFriendStore();
const publicStore = usePublicStore();
const modalStore = useModalStore();
const route = useRoute();

let restoringGroupDraft = false;
let scrollingInitialized = { group: false };

const groupMessageInputRef = ref(null);
const groupImageInputRef = ref(null);
const groupFileInputRef = ref(null);
const groupVideoInputRef = ref(null);
const groupMessageContainerRef = ref(null);
const showImageInput = ref(false);
const showFileInput = ref(false);
const showVideoInput = ref(false);
const isDragOver = ref(false);
let dragCounter = 0;
let previousGroupMessageLength = 0;

const isGroupChatVisible = ref(false);
const currentGroupName = ref('群组名称');
const showMarkdownToolbar = ref(false);
const showAtPicker = ref(false);
const atPickerPosition = ref({ top: 0, left: 0 });
const atSuggestions = ref([]);
const filteredAtSuggestions = ref([]);
const selectedAtIndex = ref(0);
const atTriggerPosition = ref(0);
const isComposing = ref(false);
const showMoreFunctions = ref(false);
const currentGroupInfo = ref(null);
const groupMembers = ref([]);
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

const displayGroupName = computed(() => {
  const groupId = sessionStore.currentGroupId;
  if (!groupId) return currentGroupName.value || '群组名称';

  // 优先显示用户设置的备注
  const currentGroup = groupStore.groupsList?.find(g => String(g.id) === String(groupId));
  if (currentGroup?.user_remark && currentGroup.user_remark.trim()) {
    return currentGroup.user_remark.trim();
  }

  return sessionStore.currentGroupName || currentGroupName.value || '群组名称';
});

const currentUserId = computed(() => baseStore.currentUser?.id);

const groupMessages = computed(() => {
  return groupStore.groupMessages[sessionStore.currentGroupId] || [];
});

function isOwnMessage(message) {
  if (!currentUserId.value) return false;
  return String(message.userId) === String(currentUserId.value) || 
         (message.user && String(message.user.id) === String(currentUserId.value));
}

function scrollToBottom() {
  nextTick(() => {
    if (groupMessageContainerRef.value) {
      groupMessageContainerRef.value.scrollTop = groupMessageContainerRef.value.scrollHeight;
    }
  });
}

function isNearBottom() {
  if (!groupMessageContainerRef.value) return false;
  const container = groupMessageContainerRef.value;
  const threshold = 150;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

function applySavedGroupState() {
  if (sessionStore.currentGroupId) {
    // 模拟真实打开会话：清除该群未读与 @我 标记，并设置发送类型等会话状态
    setActiveChat('group', sessionStore.currentGroupId, true);
    isGroupChatVisible.value = true;
    currentGroupName.value = sessionStore.currentGroupName;
    sessionStore.currentSendChatType = 'group';
    sessionStore.selectedGroupIdForCard = sessionStore.currentGroupId;
    if (groupStore) {
      groupStore.clearGroupHasAtMe(sessionStore.currentGroupId);
    }
    loadCurrentGroupInfo();
    
    const draftContent = draftStore.getDraft('group', sessionStore.currentGroupId);
    if (draftContent) {
      restoringGroupDraft = true;
      nextTick(() => {
        const messageInput = document.getElementById('groupMessageInput');
        if (messageInput) {
          messageInput.innerHTML = draftContent;
          draftStore.saveDraft('group', sessionStore.currentGroupId, '');
          draftStore.tempRestoreLastMessage('group', sessionStore.currentGroupId);
        }
        restoringGroupDraft = false;
      });
    }
    
    nextTick(() => {
      initializeScrollLoading(true);
    });
  }
}

function loadCurrentGroupInfo() {
  if (!sessionStore.currentGroupId) return;
  
  getGroupInfo(sessionStore.currentGroupId).then(res => {
    const data = res.data;
    currentGroupInfo.value = data.group;
  })
    .catch(err => {
      console.error('获取群组信息失败:', err);
    });
    
  getGroupMembers(sessionStore.currentGroupId).then(res => {
    const data = res.data;
    groupMembers.value = data.members || [];

    // 同步到 groupStore，供 GroupMessageItem 计算属性使用
    if (data.members && data.members.length > 0) {
      const storeMembers = data.members.map(m => ({
        id: Number(m.id),
        nickname: m.nickname || '',
        avatarUrl: m.avatarUrl || '',
        is_admin: Number(m.is_admin) || 0,
        is_muted: m.is_muted || null,
        group_nickname: m.group_nickname || null
      }));
      groupStore.currentGroupMembers = storeMembers;
    } else {
      groupStore.currentGroupMembers = [];
    }
  })
    .catch(err => {
      console.error('加载群组成员失败:', err);
      groupMembers.value = [];
    });
}

function toggleMarkdownToolbar() {
  showMarkdownToolbar.value = !showMarkdownToolbar.value;
}

function toggleMoreFunctions() {
  showMoreFunctions.value = !showMoreFunctions.value;
}

function isMobileDevice() {
  return window.innerWidth <= 768;
}

function handleGroupMessageInputKeydown(e) {
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
        selectGroupAtUser(filteredAtSuggestions.value[selectedAtIndex.value]);
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
      if (!groupMessageInputRef.value) return;
      const s = groupMessageInputRef.value.innerHTML.trim();
      if (s === '' || s === '<br>' || s === '<div>&nbsp;</div>') {
        clearContentEditable(groupMessageInputRef.value);
      }
    }, 0);
  }
  
  const isMobile = isMobileDevice();
  
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
    if (isMobile) {
      return;
    }
    e.preventDefault();
    handleSendGroupMessage();
  } else if (e.key === 'Enter' && (e.ctrlKey || (isMobile && !e.shiftKey))) {
    e.preventDefault();
    insertGroupNewLine();
  } else if (e.key === 'm' && e.ctrlKey) {
    e.preventDefault();
    toggleMarkdownToolbar();
  }
}

function insertGroupNewLine() {
  if (!groupMessageInputRef.value) return;
  
  const input = groupMessageInputRef.value;
  
  if (input.tagName === 'DIV' && input.isContentEditable) {
    document.execCommand('insertHTML', false, '<br><br>');
  }
}

function handleGroupPaste(e) {
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

function handleGroupDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
}

function handleGroupDragEnter(e) {
  e.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    isDragOver.value = true;
  }
}

function handleGroupDragLeave(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    isDragOver.value = false;
  }
}

function handleGroupDrop(e) {
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
    const groupMessageInput = document.getElementById('groupMessageInput');
    if (groupMessageInput) {
      groupMessageInput.focus();
      document.execCommand('insertText', false, text);
    }
  }
}

function handleGroupMessageInput() {
  if (groupMessageInputRef.value) {
    const input = groupMessageInputRef.value;
    
    const textContent = input.textContent;
    const htmlContent = input.innerHTML;
    
    if (textContent === '' && (!htmlContent || htmlContent === '<br>' || htmlContent === '<br/>' || htmlContent === '<br />')) {
      input.innerHTML = '';
      showAtPicker.value = false;
      inputStore.groupMessageInput = '';
      return;
    }
    
    if (restoringGroupDraft) {
      return;
    }
    
    inputStore.groupMessageInput = input.innerHTML;
    
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
            
            const members = groupStore.currentGroupMembers || [];
            const onlineUserIds = new Set((userStore.onlineUsers || []).map(user => String(user.id)));
            
            // 检查是否是群主或管理员
            const isOwner = currentGroupInfo.value && 
                           currentUserId.value && 
                           (String(currentGroupInfo.value.ownerId) === String(currentUserId.value) || 
                            String(currentGroupInfo.value.owner_id) === String(currentUserId.value) ||
                            String(currentGroupInfo.value.creator_id) === String(currentUserId.value));
            
            // 检查是否是管理员
            let isAdmin = isOwner;
            if (!isAdmin && members.length > 0) {
              const currentUserMember = members.find(m => 
                String(m.userId || m.id) === String(currentUserId.value)
              );
              isAdmin = currentUserMember && currentUserMember.is_admin === 1;
            }
            
            atSuggestions.value = [];
            
            // 群主或管理员可以 @全体成员
            if (isOwner || isAdmin) {
              atSuggestions.value.push({
                id: -1,
                nickname: '全体成员',
                username: '全体成员',
                avatarUrl: null,
                isOnline: true,
                isAll: true
              });
            }
            
            atSuggestions.value = atSuggestions.value.concat(
              members
                .filter(member => member && String(member.userId || member.id) !== String(currentUserId.value))
                .map(member => {
                  const userId = member.userId || member.id;
                  const isOnline = onlineUserIds.has(String(userId));
                  return {
                    id: userId,
                    nickname: member.nickname || member.name || '未知成员',
                    username: member.nickname || member.name || String(userId),
                    avatarUrl: member.avatarUrl || member.avatar_url || null,
                    isOnline: isOnline
                  };
                })
                .filter(u => u.username)
            );
            
            const searchText = textAfterAt.toLowerCase();
            if (searchText) {
              filteredAtSuggestions.value = atSuggestions.value
                .map(user => {
                  const nicknameLower = (user.nickname || '').toLowerCase();
                  const usernameLower = (user.username || '').toLowerCase();
                  
                  let score = 0;
                  if (user.isAll) {
                    score = 200;
                  } else if (nicknameLower === searchText || usernameLower === searchText) {
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
                .sort((a, b) => {
                  if (a.isAll !== b.isAll) {
                    return a.isAll ? -1 : 1;
                  }
                  return b.score - a.score;
                });
            } else {
              filteredAtSuggestions.value = [...atSuggestions.value].sort((a, b) => {
                if (a.isAll !== b.isAll) {
                  return a.isAll ? -1 : 1;
                }
                if (a.isOnline !== b.isOnline) {
                  return b.isOnline ? 1 : -1;
                }
                return 0;
              });
            }
            
            if (filteredAtSuggestions.value.length > 0) {
              const inputRect = groupMessageInputRef.value.getBoundingClientRect();
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
    
    input.scrollTop = input.scrollHeight;
  }
}

function handleGroupCompositionEnd() {
  isComposing.value = false;
  handleGroupMessageInput();
}

function handleSendGroupMessage() {
  sendGroupMessage();
  scrollToBottom();
}

function handleSendGroupCard() {
  showSendGroupCardModal('group');
}

function handleGroupInfoClick() {
  if (!sessionStore.currentGroupId) {
    toast.warning('请先选择一个群组');
    return;
  }
  
  const currentGroup = groupStore.groupsList.find(g => String(g.id) === String(sessionStore.currentGroupId));
  if (currentGroup && currentGroup.deleted_at != null) {
    modalStore.openModal('groupInfo', currentGroup);
    return;
  }
  
  const user = baseStore.currentUser;
  const sessionToken = baseStore.currentSessionToken;
  
  if (!user || !sessionToken) {
    toast.warning('请先登录');
    return;
  }
  
  getGroupInfo(sessionStore.currentGroupId).then(res => {
    const data = res.data;
    currentGroupInfo.value = data.group;
    modalStore.openModal('groupInfo', data.group);
  })
    .catch(err => {
      console.error('获取群组信息失败:', err);
    });
}

let atTriggerInfo = null;

function selectGroupAtUser(user) {
  if (!groupMessageInputRef.value) return;
  
  const input = groupMessageInputRef.value;
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
  inputStore.groupMessageInput = input.innerHTML;
  input.focus();
}

function insertMarkdown(prefix, suffix, sample) {
  if (!groupMessageInputRef.value) return;
  
  const input = groupMessageInputRef.value;
  input.focus();
  
  let selectedText = '';
  if (window.getSelection) {
    const selection = window.getSelection();
    selectedText = selection.toString();
  }
  
  if (!selectedText) selectedText = sample;
  
  const newText = prefix + selectedText + suffix;
  
  document.execCommand('insertText', false, newText);
  
  setTimeout(() => {
    if (window.getSelection) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, 0);
}

function handleGroupImageUploadClick() {
  showImageInput.value = true;
  nextTick(() => {
    if (groupImageInputRef.value) {
      groupImageInputRef.value.click();
    }
  });
}

function handleGroupFileUploadClick() {
  showFileInput.value = true;
  nextTick(() => {
    if (groupFileInputRef.value) {
      groupFileInputRef.value.click();
    }
  });
}

function handleGroupImageUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadImage(file);
  }
  showImageInput.value = false;
  if (groupImageInputRef.value) {
    groupImageInputRef.value.value = '';
  }
}

function handleGroupImageCancel() {
  showImageInput.value = false;
}

function handleGroupFileUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadFile(file);
  }
  showFileInput.value = false;
  if (groupFileInputRef.value) {
    groupFileInputRef.value.value = '';
  }
}

function handleGroupFileCancel() {
  showFileInput.value = false;
}

function handleGroupVideoUploadClick() {
  showVideoInput.value = true;
  nextTick(() => {
    if (groupVideoInputRef.value) {
      groupVideoInputRef.value.click();
    }
  });
}

function handleGroupVideoUpload(e) {
  const file = e.target.files[0];
  if (file) {
    uploadVideo(file);
  }
  showVideoInput.value = false;
  if (groupVideoInputRef.value) {
    groupVideoInputRef.value.value = '';
  }
}

function handleGroupVideoCancel() {
  showVideoInput.value = false;
}

const showSearchModal = ref(false);
const searchKeyword = ref('');
const searchResults = ref([]);
const isSearching = ref(false);
const hasSearched = ref(false);
const currentSearchIndex = ref(0);

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
    const groupId = sessionStore.currentGroupId;
    const prefix = `chats-${baseStore.currentUser?.id || 'guest'}`;
    const storageKey = `${prefix}-group-${groupId}`;
    
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
      
      const storeMessages = groupStore.groupMessages[groupId] || [];
      if (storeMessages.length > 0) {
        const storeMinId = Math.min(...storeMessages.map(m => m.id));
        
        const startId = Math.max(1, minMatchedId - 20);
        const endId = storeMinId - 1;
        
        if (startId <= endId) {
          const messagesToAdd = allMessages
            .filter(msg => msg.id >= startId && msg.id <= endId && msg.messageType !== 101 && msg.messageType !== 102 && msg.messageType !== 103)
            .sort((a, b) => a.id - b.id);
          
          groupStore.prependGroupMessages(groupId, messagesToAdd);
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
  const targetElement = groupMessageContainerRef.value?.querySelector(`[data-id="${message.id}"]`);
  if (targetElement) scrollAndHighlight(targetElement);
}

function navigateToNextSearchResult() {
  if (searchResults.value.length <= 1) return;
  currentSearchIndex.value = (currentSearchIndex.value + 1) % searchResults.value.length;
  scrollToMessage(searchResults.value[currentSearchIndex.value]);
}

function navigateToPrevSearchResult() {
  if (searchResults.value.length <= 1) return;
  currentSearchIndex.value = (currentSearchIndex.value - 1 + searchResults.value.length) % searchResults.value.length;
  scrollToMessage(searchResults.value[currentSearchIndex.value]);
}

function handleGroupSwitched() {
  if (sessionStore.currentGroupId) {
    isGroupChatVisible.value = true;
    currentGroupName.value = sessionStore.currentGroupName;
    loadCurrentGroupInfo();
    
    restoringGroupDraft = true;
    
    nextTick(() => {
      const messageInput = document.getElementById('groupMessageInput');
      if (messageInput) {
        messageInput.innerHTML = '';
        
        const draftContent = draftStore.getDraft('group', sessionStore.currentGroupId);
        if (draftContent) {
          messageInput.innerHTML = draftContent;
          
          draftStore.saveDraft('group', sessionStore.currentGroupId, '');
          draftStore.tempRestoreLastMessage('group', sessionStore.currentGroupId);
          
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(messageInput);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        
        restoringGroupDraft = false;
      }
    });
    
    setTimeout(() => {
      initializeScrollLoading(true);
    }, 100);
  }
}

watch(
  () => sessionStore.currentGroupId,
  (newGroupId, oldGroupId) => {
    if (newGroupId && newGroupId !== oldGroupId) {
      if (scrollingInitialized) {
        scrollingInitialized.group = false;
      }
      
      if (groupMessageInputRef.value) {
        groupMessageInputRef.value.innerHTML = '';
      }
      
      nextTick(() => {
        if (groupMessageContainerRef.value) {
          groupMessageContainerRef.value.scrollTop = 0;
        }
        scrollToBottom();
        setTimeout(() => {
          initializeScrollLoading(true);
        }, 100);
        setTimeout(() => {
          if (scrollingInitialized) {
            scrollingInitialized.group = true;
          }
        }, 600);
      });
    }
    if (!newGroupId) {
      isGroupChatVisible.value = false;
      currentGroupInfo.value = null;
    }
  }
);

watch(
  () => groupMessages.value,
  (newMessages, oldMessages) => {
    // 加载更多（prepend）：首条消息 id 变化且末条不变，说明上方插入了更早的历史消息
    const isPrepend = oldMessages && oldMessages.length > 0
      && newMessages.length > oldMessages.length
      && String(newMessages[0].id) !== String(oldMessages[0].id)
      && String(newMessages[newMessages.length - 1].id) === String(oldMessages[oldMessages.length - 1].id);
    if (isPrepend) {
      // DOM 更新前捕获当前滚动位置（watch 默认 pre-flush，此时 DOM 还是旧的）
      const container = groupMessageContainerRef.value;
      const oldScrollHeight = container ? container.scrollHeight : undefined;
      const oldScrollTop = container ? container.scrollTop : undefined;
      // DOM 更新后、浏览器绘制前恢复位置，消除加载更多时顶部内容闪现一帧的问题
      nextTick(() => {
        const wrap = groupMessageContainerRef.value;
        if (wrap && oldScrollHeight !== undefined && oldScrollTop !== undefined) {
          wrap.scrollTop = wrap.scrollHeight - oldScrollHeight + oldScrollTop;
        }
      });
    } else if (newMessages.length > previousGroupMessageLength) {
      if (isNearBottom()) {
        scrollToBottom();
      }
    }
    previousGroupMessageLength = newMessages.length;
  },
  { deep: true }
);

watch(
  () => sessionStore.currentGroupName,
  (newGroupName) => {
    currentGroupName.value = newGroupName;
  }
);

watch(
  () => route.path,
  (newPath, oldPath) => {
    if (oldPath && oldPath.startsWith('/chat/group') && !newPath.startsWith('/chat/group')) {
      const currentGroupId = sessionStore.currentGroupId;
      if (currentGroupId) {
        const groupMessageInput = document.getElementById('groupMessageInput');
        if (groupMessageInput) {
          const content = groupMessageInput.textContent || groupMessageInput.innerHTML || '';
          draftStore.saveDraft('group', currentGroupId, content);
          draftStore.setLastMessageToDraft('group', currentGroupId);
        }
      }
    }
    
    if (newPath.startsWith('/chat/group')) {
      if (scrollingInitialized) {
        scrollingInitialized.group = false;
      }
      
      const draftContent = draftStore.getDraft('group', sessionStore.currentGroupId);
      if (draftContent) {
        restoringGroupDraft = true;
        nextTick(() => {
          const messageInput = document.getElementById('groupMessageInput');
          if (messageInput) {
            messageInput.innerHTML = draftContent;
            draftStore.saveDraft('group', sessionStore.currentGroupId, '');
            draftStore.tempRestoreLastMessage('group', sessionStore.currentGroupId);
          }
          restoringGroupDraft = false;
        });
      }
      
      if (switchingGroupWithExistingMessages) {
        nextTick(() => {
          initializeScrollLoading(true);
        });
        setTimeout(() => {
          if (scrollingInitialized) {
            scrollingInitialized.group = true;
          }
        }, 1000);
      } else {
        scrollToBottom();
        nextTick(() => {
          initializeScrollLoading(true);
        });
        setTimeout(() => {
          if (scrollingInitialized) {
            scrollingInitialized.group = true;
          }
        }, 600);
      }
      
      inputStore.clearQuotedMessage();
      groupStore.clearOtherGroupMessages(sessionStore.currentGroupId);
      friendStore.clearOtherPrivateMessages(null);
      publicStore.clearPublicMessagesExceptRecent();
    }
  }
);

function handleGroupMembersChanged(event) {
  loadCurrentGroupInfo();
}

onMounted(() => {
  window.addEventListener('group-switched', handleGroupSwitched);
  window.addEventListener('group-members-changed', handleGroupMembersChanged);

  if (sessionStore.currentGroupId) {
    applySavedGroupState();
  }
  
  scrollToBottom();
  
  function hideAtPickerOnClick(e) {
    if (!showAtPicker.value) return;
    const atPicker = document.querySelector('.at-picker');
    const messageInput = document.getElementById('groupMessageInput');
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
});

onUnmounted(() => {
  window.removeEventListener('group-switched', handleGroupSwitched);
  window.removeEventListener('group-members-changed', handleGroupMembersChanged);
});
</script>

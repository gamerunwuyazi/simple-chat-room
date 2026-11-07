<template>
 <div class="quoted-message-preview quoted-preview-wrapper">
 <div class="quoted-preview-body">
 <div class="quoted-preview-header">
   <img v-if="senderAvatarUrl && !senderAvatarError" :src="senderAvatarUrl" class="quoted-preview-avatar" @error="senderAvatarError = true">
   <div v-else class="quoted-preview-avatar-fallback">{{ senderInitial }}</div>
   引用: <strong>{{ resolvedUserInfo.nickname }}</strong>
 </div>
 <!-- 引用图片 -->
 <div v-if="isImage" class="quoted-preview-section">
 <img :src="fullImageUrl" alt="引用图片" class="quoted-preview-image">
 </div>
 <!-- 引用文件 -->
 <div v-else-if="isFile" class="quoted-preview-section">
 <span class="quoted-preview-file-icon"><i class="fas" :class="fileIcon" aria-hidden="true"></i></span>
 <span class="quoted-preview-file-name">{{ displayFilename }}</span>
 </div>
 <!-- 引用群名片 -->
 <div v-else-if="isGroupCard" class="quoted-preview-section quoted-preview-group-card">
 <div class="quoted-preview-group-card-header">
 <img
 v-if="groupCardAvatarUrl && !isSvgAvatar(groupCardAvatarUrl) && !groupCardAvatarLoadFailed"
 :src="groupCardAvatarUrl"
 class="quoted-preview-group-card-avatar"
 @error="groupCardAvatarLoadFailed = true"
 >
 <div
 v-else
 class="quoted-preview-group-card-avatar-fallback"
 >
 {{ groupCardInitials }}
 </div>
 <span class="quoted-preview-group-card-name">{{ groupCardGroupName }}</span>
 </div>
 </div>
 <!-- 普通文本 -->
 <div v-else class="quoted-preview-text">
 <span v-if="isMarkdownContent" v-html="displayContent"></span>
 <template v-else>{{ displayContent }}</template>
 </div>
 </div>
 <button @click="handleScrollToQuoted" class="quoted-preview-jump-btn">跳转</button>
 <button @click="$emit('close')" class="quoted-preview-close-btn">×</button>
 </div>
</template>

<script setup>
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, ref } from 'vue';

import { useBaseStore } from '@/stores/baseStore';
import { useGroupStore } from '@/stores/groupStore';
import { useFriendStore } from '@/stores/friendStore';
import { useUnifiedStore } from '@/stores/unifiedStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useMessageHighlight } from '@/composables/useMessageHighlight';
import { findUserInfo } from '@/utils/chat/userLookup';
import { getFileIconClass } from '@/utils/fileIcon';

const props = defineProps({
 quotedMessage: {
 type: Object,
 required: true
 }
});

defineEmits(['close']);

const baseStore = useBaseStore();
const groupStore = useGroupStore();
const friendStore = useFriendStore();
const unifiedStore = useUnifiedStore();
const sessionStore = useSessionStore();
const groupCardAvatarLoadFailed = ref(false);
const senderAvatarError = ref(false);
const { scrollAndHighlight } = useMessageHighlight();

function getQuotedUserInfo() {
  return findUserInfo(props.quotedMessage, { sessionStore, groupStore, friendStore, unifiedStore, baseStore });
}

const resolvedUserInfo = computed(() => getQuotedUserInfo());

const senderAvatarUrl = computed(() => {
  const avatar = getQuotedUserInfo().avatarUrl;
  if (!avatar) return '';
  return avatar.startsWith('http') ? avatar : `${baseStore.SERVER_URL}${avatar}`;
});

const senderInitial = computed(() => {
  const name = getQuotedUserInfo().nickname;
  return name ? name.charAt(0).toUpperCase() : '?';
});

function escapeHtmlForMarkdown(str) {
 return String(str)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 // 注意：不要转义 '>' —— 它是 markdown 块引用语法，转义会导致 '> xxx' 无法渲染。
 // '<' 才是 HTML 标签的起始字符（真正的注入面），保持转义即可，安全性不受影响。
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#39;');
}

function isSvgAvatar(url) {
 return url && /\.svg$/i.test(url);
}

const messageType = computed(() => props.quotedMessage?.messageType || 0);
const isImage = computed(() => messageType.value === 1);
const isFile = computed(() => messageType.value === 2);
const isGroupCard = computed(() => messageType.value === 3);

const imageUrl = computed(() => {
 if (!isImage.value) return null;
 try {
 const data = JSON.parse(props.quotedMessage.content || '{}');
 return data.url || null;
 } catch {
 return null;
 }
});

const fullImageUrl = computed(() => {
 if (!imageUrl.value) return '';
 return imageUrl.value.startsWith('http') ? imageUrl.value : `${baseStore.SERVER_URL}${imageUrl.value}`;
});

const filename = computed(() => {
 if (!isFile.value) return null;
 try {
 const data = JSON.parse(props.quotedMessage.content || '{}');
 return data.filename || data.name || null;
 } catch {
 return null;
 }
});

const displayFilename = computed(() => filename.value || '文件');

const fileIcon = computed(() => getFileIconClass(filename.value));

const groupCardData = computed(() => {
 const msg = props.quotedMessage;
 if (!msg) return null;
 if (msg.messageType !== 3) return null;
 try {
 const data = JSON.parse(msg.content || '{}');
 if (data.type === 'group_card' && data.group_id) {
 return data;
 }
 return null;
 } catch {
 return null;
 }
});

const groupCardAvatarUrl = computed(() => {
 if (!groupCardData.value?.avatar_url) return '';
 return groupCardData.value.avatar_url.startsWith('http')
 ? groupCardData.value.avatar_url
 : `${baseStore.SERVER_URL}${groupCardData.value.avatar_url}`;
});

const groupCardGroupName = computed(() => groupCardData.value?.group_name || '群组');

const groupCardInitials = computed(() => {
 const name = groupCardGroupName.value;
 return name ? name.charAt(0).toUpperCase() : 'G';
});

const displayContent = computed(() => {
 const msg = props.quotedMessage;
 if (!msg) return '';
 if (msg.messageType === 4) {
 try {
 const data = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
 return data.text || msg.content || '';
 } catch {
 return msg.content || '';
 }
 }
 if (msg.messageType === 5 || msg.markdone) {
 let content = msg.content || '';
 try {
 content = escapeHtmlForMarkdown(content);
 const renderer = new marked.Renderer();
 renderer.codespan = function(token) {
 return `<code>` + token.text + `</code>`;
 };
 marked.setOptions({ breaks: true, gfm: true, renderer });
 let parsed = marked.parse(content).trim();
 parsed = parsed.replace(/<svg[^>]*>.*?<\/svg>/gi, '[SVG图片]');
 parsed = parsed.replace(/<(?!\/?(a|img|div|span|br|p|h[1-6]|strong|em|code|pre|ul|ol|li|blockquote|figure|table|thead|tbody|tr|th|td|i)\b)[^>]*>/gi, '');
 parsed = parsed.replace(/<img/g, '<img style="max-width: 100%; height: auto;"');
 parsed = parsed.replace(/<table/g, '<table style="border-collapse: collapse; width: 100%; margin-bottom: 8px;"');  parsed = parsed.replace(/<a/g, '<a target="_blank" rel="noopener noreferrer" style="color: #3498db;"');
 return DOMPurify.sanitize(parsed);
 } catch {
 return content;
 }
 }
 return msg.content || '';
});

const isMarkdownContent = computed(() => {
 const msg = props.quotedMessage;
 return msg && (msg.messageType === 5 || msg.markdone);
});

function handleScrollToQuoted() {
  const quotedId = props.quotedMessage?.id;
  if (!quotedId) return;
  const messageEl = document.querySelector(`[data-id="${quotedId}"]`);
  if (!messageEl) return;
  try {
    scrollAndHighlight(messageEl);
  } catch {
    if (messageEl) messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
</script>

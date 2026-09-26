<template>
  <div 
    v-if="systemMessage"
    class="system-message-wrapper"
    :data-id="message.id"
  >
    <div class="system-message-container" :class="systemMessageType">
      <div class="system-message-text">{{ systemMessage }}</div>
    </div>
  </div>
  <div 
    v-else
    :class="['message', isOwn ? 'own-message' : 'other-message', { 'active': isActive }]"
    :data-id="message.id"
    :data-identifier="messageIdentifier"
    @contextmenu="handleContextMenu"
  >
    <div class="msg-avatar" @click="handleAvatarClick">
      <img v-if="avatarIsImage" :src="fullAvatarUrl" :alt="senderNickname" class="msg-avatar-img" @error="handleAvatarError" />
      <span v-else class="msg-avatar-initials">{{ senderInitials }}</span>
    </div>
    <div class="msg-body">
      <div v-if="!isOwn" class="msg-sender-name">{{ senderNickname }} <span class="msg-time">{{ messageTime }}</span></div>
      <div class="msg-bubble">
        <div class="msg-bubble-content" v-scroll-padding>
      <div v-if="systemMessage" class="system-message-container" :class="systemMessageType">
        <div class="system-message-text">{{ systemMessage }}</div>
      </div>
      <div v-else-if="imageUrl" class="message-image-container">
        <img 
          :src="fullImageUrl" 
          :alt="filename || '图片'"
          class="message-image"
          style="cursor: pointer;"
          @click="handleImageClick(fullImageUrl)"
        >
      </div>
      <div v-else-if="isVideoFile" class="video-container" style="width: 300px; max-width: 400px;">
        <video 
          :src="fullFileUrl" 
          controls 
          style="width: 100%;"
          preload="metadata"
        >
          您的浏览器不支持视频播放
        </video>
        <div class="message-filename">{{ displayFilename }}</div>
      </div>
      <div v-else-if="isAudioFile" class="audio-container" style="width: 300px; max-width: 400px;">
        <audio 
          :src="fullFileUrl" 
          controls 
          style="width: 100%;"
          preload="metadata"
        >
          您的浏览器不支持音频播放
        </audio>
        <div class="message-filename">{{ displayFilename }}</div>
      </div>
      <div v-else-if="fileUrl" class="file-link-container">
        <a 
          :href="fullFileUrl" 
          class="file-link" 
          target="_blank"
          style="color: #3498db; text-decoration: none;"
        >
          <span class="file-icon">{{ fileIcon }}</span>
          <span>{{ displayFilename }}</span>
        </a>
      </div>
      <div 
        v-else-if="groupCardData" 
        class="group-card-container"
        :data-group-id="groupCardData.group_id"
        @click="handleGroupCardClick"
      >
        <div class="group-card-header">
          <img 
            v-if="groupCardAvatarUrl"
            :src="groupCardAvatarUrl"
            :alt="groupCardGroupName"
            style="width: 20px; height: 20px; border-radius: 50%; object-fit: cover; cursor: pointer;"
            @click.stop="handleImageClick(groupCardAvatarUrl)"
            @error="handleGroupCardAvatarError"
          >
          <div 
            v-else
            style="width: 20px; height: 20px; border-radius: 50%; background-color: #3498db; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold;"
          >
            {{ groupCardInitials }}
          </div>
          {{ groupCardGroupName }}
        </div>
        <div class="group-card-description" style="color: #666; font-size: 14px; margin-bottom: 5px;">
          {{ groupCardGroupDescription }}
        </div>
        <div class="group-card-footer">
          点击查看群组详情
        </div>
      </div>
      <div v-else-if="parsedContent && !(imageUrl || fileUrl || groupCardData || quotedMessageData)" v-html="parsedContent" class="message-text"></div>
      <template v-else-if="quotedMessageData">
        <div v-if="quotedMessageData.text" class="message-text">
          <p v-if="!quotedMessageData.markdone">{{ quotedMessageData.text }}</p>
          <div v-else v-html="quotedMessageParsedContent"></div>
        </div>
        <QuotedMessage :quoted-message-data="quotedMessageData.quoted" />
      </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, ref, onMounted } from 'vue';

import QuotedMessage from './QuotedMessage.vue';

import { useBaseStore } from '@/stores/baseStore';
import { useUserStore } from '@/stores/userStore';
import { useGroupStore } from '@/stores/groupStore';
import { useFriendStore } from '@/stores/friendStore';
import { useModalStore } from '@/stores/modalStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useInputStore } from '@/stores/inputStore';
import { openUserAvatarPopup } from '@/stores/index.js';
import { showGroupCardPopup, getChatSocket } from '@/utils/chat';
import { formatMessageTime } from '@/utils/chat/message.js';
import { useContextMenuKeyboard } from "@/composables/useContextMenuKeyboard";
import toast from '@/utils/toast';

let currentMessageContextMenu = null;

const props = defineProps({
  message: {
    type: Object,
    required: true
  },
  isOwn: {
    type: Boolean,
    default: false
  }
});

const baseStore = useBaseStore();
const userStore = useUserStore();
const groupStore = useGroupStore();
const friendStore = useFriendStore();
const modalStore = useModalStore();
const sessionStore = useSessionStore();
const inputStore = useInputStore();
const { setupKeyboard } = useContextMenuKeyboard();

const isActive = ref(false);
const avatarLoadFailed = ref(false);
const groupCardAvatarLoadFailed = ref(false);

onMounted(() => {
  const messageEl = document.querySelector(`[data-id="${props.message.id}"]`);
  if (messageEl) {
    messageEl.addEventListener('click', (e) => {
      const link = e.target.closest('a.message-link, a.file-link');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href) {
          window.open(href, '_blank');
        }
      }
    });
  }
});

const messageUser = computed(() => {
  if (props.message.user) {
    return props.message.user;
  }
  return {
    id: props.message.userId,
    nickname: props.message.nickname,
    avatarUrl: props.message.avatarUrl
  };
});


const senderNickname = computed(() => {
  const messageUserId = props.message.userId;
  const messageGroupId = props.message.groupId;

  // ⭐ 动态昵称解析（优先级：群昵称 > 消息中存储的群昵称 > 全局昵称 > 消息原始昵称）
  // 1. 最高优先级：检查该用户在当前群是否有群昵称（同时校验群归属，防止串群）
  const members = groupStore.currentGroupMembers;
  const activeGroupId = sessionStore.currentGroupId;
  if (members && members.length > 0 && activeGroupId && messageGroupId && String(messageGroupId) === String(activeGroupId)) {
    const member = members.find(m => String(m.id) === String(messageUserId));
    if (member && member.group_nickname) {
      return member.group_nickname;
    }
  }

  // 2. 次优先级：消息中存储的群昵称（后端推送/拉取时携带，按消息归属）
  if (props.message.groupNickname) {
    return props.message.groupNickname;
  }

  // 3. 如果是好友，优先显示备注
  const friend = friendStore.friendsList?.find(f => String(f.id) === String(messageUserId));
  if (friend && friend.remark?.trim()) {
    return friend.remark.trim();
  }

  // 4. 中等优先级：使用 userStore 中的全局昵称（实时更新）
  const onlineUsers = userStore.onlineUsers;
  if (onlineUsers && onlineUsers.length > 0) {
    const onlineUser = onlineUsers.find(u => String(u.id) === String(messageUserId));
    if (onlineUser && onlineUser.nickname) {
      return onlineUser.nickname;
    }
  }

  // 5. 兜底：使用消息中存储的原始昵称或好友昵称
  if (friend) return friend.nickname || messageUser.value.nickname;
  return messageUser.value.nickname || '未知用户';
});
const senderInitials = computed(() => senderNickname.value ? senderNickname.value.charAt(0).toUpperCase() : 'U');
const senderAvatarUrl = computed(() => messageUser.value.avatarUrl);

const isSvgAvatar = computed(() => {
  if (!senderAvatarUrl.value) return false;
  return typeof senderAvatarUrl.value === 'string' && 
    (/\.(svg)$/i.test(senderAvatarUrl.value) || senderAvatarUrl.value.includes('.svg'));
});

const fullAvatarUrl = computed(() => {
  if (senderAvatarUrl.value && !isSvgAvatar.value) {
    return `${baseStore.SERVER_URL}${senderAvatarUrl.value}`;
  }
  return '';
});

const avatarIsImage = computed(() => fullAvatarUrl.value !== '' && !avatarLoadFailed.value);

function handleAvatarError() {
  avatarLoadFailed.value = true;
}

const messageTime = computed(() => {
  if (props.message.timestamp) {
    return formatMessageTime(new Date(props.message.timestamp));
  }
  return formatMessageTime(new Date());
});

const messageIdentifier = computed(() => {
  if (props.message.identifier) return props.message.identifier;
  const content = props.message.content || props.message.text || 'empty';
  const sender = props.message.userId || props.message.senderId || 'unknown';
  const time = props.message.timestamp || props.message.createdAt || 'unknown';
  const data = `${sender}-${time}-${JSON.stringify(content)}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
});

const messageData = computed(() => {
  let imageUrl = props.message.imageUrl;
  let fileUrl = props.message.fileUrl;
  let filename = props.message.filename;
  let textContent = props.message.content;
  let groupCardData = null;
  let quotedMessageData = null;
  let width = props.message.width;
  let height = props.message.height;
  let systemMessage = null;

  if (props.message.messageType !== undefined) {
    // 优先检查是否是已撤回的消息（通过isRecalled或isSystemMessage标记）
    if (props.message.isRecalled || props.message.isSystemMessage) {
      // 撤回消息 - content为JSON格式：{撤回人id:撤回人昵称}
      // 优先从群成员列表计算撤回人昵称，无法计算时使用content中存储的昵称
      let recallNickname = '某人';
      try {
        const parsed = JSON.parse(props.message.content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const keys = Object.keys(parsed);
          if (keys.length > 0) {
            const recallerId = keys[0];
            const storedNickname = parsed[recallerId];
            const members = groupStore.currentGroupMembers;
            const activeGroupId = sessionStore.currentGroupId;
            if (members && members.length > 0 && activeGroupId && props.message.groupId && String(props.message.groupId) === String(activeGroupId)) {
              const recaller = members.find(m => String(m.id) === String(recallerId));
              if (recaller) {
                recallNickname = recaller.group_nickname || recaller.nickname || storedNickname;
              } else {
                recallNickname = storedNickname;
              }
            } else {
              recallNickname = storedNickname;
            }
          }
        } else {
          recallNickname = senderNickname.value || '某人';
        }
      } catch (e) {
        recallNickname = senderNickname.value || '某人';
      }
      textContent = `${recallNickname}撤回了一条消息`;
      systemMessage = typeof textContent === 'string' ? textContent : String(textContent);
    } else {
      switch (props.message.messageType) {
      case 1:
        try {
          const imageData = JSON.parse(props.message.content);
          imageUrl = imageData.url;
          filename = imageData.filename;
          if (imageData.width && imageData.height) {
            width = imageData.width;
            height = imageData.height;
          }
        } catch (error) {
          console.error('解析图片消息JSON失败:', error);
        }
        break;
      case 2:
        try {
          const fileData = JSON.parse(props.message.content);
          fileUrl = fileData.url;
          filename = fileData.filename;
        } catch (error) {
          console.error('解析文件消息JSON失败:', error);
        }
        break;
      case 3:
        try {
          groupCardData = JSON.parse(props.message.content);
          if (groupCardData.type !== 'group_card' || !groupCardData.group_id) {
            groupCardData = null;
          }
        } catch (error) {
          console.error('解析群名片消息JSON失败:', error);
          groupCardData = null;
        }
        break;
      case 4:
        try {
          const quotedData = JSON.parse(props.message.content);
          // 兼容三种字段名：quoted、quotedMessage、quoted_message
          const quotedObj = quotedData.quoted || quotedData.quotedMessage || quotedData.quoted_message;
          if (quotedObj) {
            // 如果引用的是一条引用消息(messageType=4)且其markdone为真，自动将其messageType转为5（供QuotedMessage组件判断）
            if (quotedObj.messageType === 4 && quotedObj.markdone === true) {
              quotedObj.messageType = 5;
            }
            quotedMessageData = {
              quoted: quotedObj,
              text: quotedData.text || quotedData.content || '',
              markdone: quotedData.markdone || false
            };
            textContent = quotedData.text || quotedData.content || '';
          }
        } catch (error) {}
        break;
      case 100: {
        // 系统消息 - content为JSON格式：{userId: nickname, action: "..."}
        let sysContent;
        try {
          const parsed = JSON.parse(props.message.content);
          if (parsed && parsed.action) {
            const userId = Object.keys(parsed).find(k => k !== 'action' && k !== 'groupName' && k !== 'content');
            let displayName = parsed[userId] || '用户';
            const members = groupStore.currentGroupMembers;
            const activeGroupId = sessionStore.currentGroupId;
            if (userId) {
              if (members && members.length > 0 && activeGroupId && props.message.groupId && String(props.message.groupId) === String(activeGroupId)) {
                const member = members.find(m => String(m.id) === String(userId));
                if (member) {
                  displayName = member.group_nickname || member.nickname || displayName;
                }
              }
            }

            switch (parsed.action) {
              case 'create': {
                let otherCreateNamesStr = '';
                if (parsed.otherNames && typeof parsed.otherNames === 'object' && !Array.isArray(parsed.otherNames)) {
                  const names = Object.values(parsed.otherNames);
                  otherCreateNamesStr = names.join('、');
                }
                sysContent = otherCreateNamesStr
                  ? `${displayName}创建了群组，同时加入群组的有：${otherCreateNamesStr}`
                  : `${displayName}创建了群组`;
                break;
              }
              case 'kick':
                sysContent = `${displayName}被移出了群组`;
                break;
              case 'invite': {
                const inviteeIds = Object.keys(parsed).filter(k => k !== 'action' && k !== String(userId) && k !== 'groupName' && k !== 'content');
                const inviteeNamesStr = inviteeIds.map(id => {
                  if (members && members.length > 0) {
                    const m = members.find(m => String(m.id) === String(id));
                    if (m) return m.group_nickname || m.nickname || parsed[id];
                  }
                  return parsed[id] || '用户';
                }).join('、');
                sysContent = inviteeNamesStr
                  ? `${displayName}邀请${inviteeNamesStr}加入了群组`
                  : `${displayName}邀请了新成员加入了群组`;
                break;
              }
              case 'join':
                sysContent = `${displayName}加入了群组`;
                break;
              case 'joinByCard':
                sysContent = `${displayName}通过群名片加入了群组`;
                break;
              case 'leave':
                sysContent = `${displayName}退出了群组`;
                break;
              case 'dismiss':
                sysContent = parsed.content || '群组已解散';
                break;
              default:
                sysContent = parsed.content || String(props.message.content);
            }
          } else {
            sysContent = props.message.content;
          }
        } catch {
          sysContent = props.message.content;
        }
        systemMessage = sysContent;
        break;
      }
      default:
        textContent = props.message.content;
        break;
    }
    }  // end else (非撤回消息的switch)
  }

  return { imageUrl, fileUrl, filename, textContent, groupCardData, quotedMessageData, width, height, systemMessage };
});

const systemMessage = computed(() => messageData.value.systemMessage);
const systemMessageType = computed(() => {
  if (!systemMessage.value) return '';
  const content = systemMessage.value;
  if (content.includes('加入了群组') || content.includes('已加入')) {
    return 'system-join';
  }
  if (content.includes('退出了群组') || content.includes('已退出')) {
    return 'system-leave';
  }
  if (content.includes('群组已解散') || content.includes('删除了群组')) {
    return 'system-dismiss';
  }
  if (content.includes('已删除好友') || content.includes('解除好友关系')) {
    return 'system-friend';
  }
  if (content.includes('撤回了一条消息')) {
    return 'system-recall';
  }
  return 'system-default';
});

const imageUrl = computed(() => messageData.value.imageUrl);
const fileUrl = computed(() => messageData.value.fileUrl);
const filename = computed(() => messageData.value.filename);
const textContent = computed(() => messageData.value.textContent);
const groupCardData = computed(() => messageData.value.groupCardData);
const quotedMessageData = computed(() => messageData.value.quotedMessageData);
const imageWidth = computed(() => messageData.value.width);
const imageHeight = computed(() => messageData.value.height);

const isAudioFile = computed(() => {
  if (!filename.value) return false;
  const ext = filename.value.split('.').pop().toLowerCase();
  return ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'].includes(ext);
});

const isVideoFile = computed(() => {
  if (!filename.value) return false;
  const ext = filename.value.split('.').pop().toLowerCase();
  return ['mp4', 'webm', 'ogg', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'm4v'].includes(ext);
});

const quotedMessageParsedContent = computed(() => {
  if (!quotedMessageData.value?.text || !quotedMessageData.value?.markdone) return '';
  
  let contentToParse = quotedMessageData.value.text;
  
  contentToParse = escapeHtmlForMarkdown(contentToParse);
  
  if (baseStore.SERVER_URL) {
    contentToParse = contentToParse.replace(/!\[([^\]]+)\]\(([^)]+)\)/g, (match, alt, url) => {
      const trimmedUrl = url.trim();
      if (trimmedUrl && !trimmedUrl.startsWith('http') && !trimmedUrl.startsWith('//')) {
        return `![${alt}](${baseStore.SERVER_URL}${trimmedUrl})`;
      }
      return match;
    });

    contentToParse = contentToParse.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      const trimmedUrl = url.trim();
      if (trimmedUrl && !trimmedUrl.startsWith('http') && !trimmedUrl.startsWith('//')) {
        if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?(:\d+)?/.test(trimmedUrl)) {
          return `[${text}](https://${trimmedUrl})`;
        } else {
          return `[${text}](${baseStore.SERVER_URL}${trimmedUrl})`;
        }
      }
      return match;
    });

    const urlRegex = /(?<!\]\()(?<!\[)(?<!https?:\/\/[^?&"'<>\s]+\?.*)(?<!https?:\/\/[^?&"'<>\s]+&.*)(https?:\/\/(?:[^\s"'<>]+))/g;
    contentToParse = contentToParse.replace(urlRegex, '[$1]($1)');
  }

  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const language = lang || 'text';
    const code = text;
    const encodedCode = encodeURIComponent(code);
    
    const lines = code.split('\n');
    let lineNumbers = '';
    let codeLines = '';
    lines.forEach((line, index) => {
      lineNumbers += `<pre><span class="line">${index + 1}</span></pre>`;
      codeLines += `<pre><code>${line}</code></pre>`;
    });
    
    return `<figure class="highlight">
      <div class="highlight-tools">
        <div class="macStyle">
          <div class="mac-close"></div>
          <div class="mac-minimize"></div>
          <div class="mac-maximize"></div>
        </div>
        <div class="code-lang">${language}</div>
        <div class="copy-notice"></div>
        <i class="fas fa-paste copy-button" data-code="${encodedCode}"></i>
        <i class="fa-solid fa-up-right-and-down-left-from-center fullpage-button"></i>
      </div>
      <table>
        <tbody>
          <tr>
            <td class="gutter">
              ${lineNumbers}
            </td>
            <td class="code">
              ${codeLines}
            </td>
          </tr>
        </tbody>
      </table>
    </figure>`;
  };

  renderer.codespan = function(token) {
    return `<code>` + token.text + `</code>`;
  };


  marked.setOptions({
    breaks: true,
    gfm: true,
    renderer: renderer
  });

  let parsed = marked.parse(contentToParse).trim();
  parsed = parsed.replace(/<svg[^>]*>.*?<\/svg>/gi, '[SVG图片]');
  parsed = parsed.replace(/<(?!\/?(a|img|div|span|br|p|h[1-6]|strong|em|code|pre|ul|ol|li|blockquote|figure|table|thead|tbody|tr|th|td|i)\b)[^>]*>/gi, '');

  parsed = parsed.replace(/<img/g, '<img class="message-image" style="max-width: 100%; height: auto; cursor: pointer;"');
  parsed = parsed.replace(/<table/g, '<table style="border-collapse: collapse; width: 100%; margin-bottom: 8px;"');  parsed = parsed.replace(/<a/g, '<a class="message-link" target="_blank" rel="noopener noreferrer" style="color: #3498db; text-decoration: none;"');

  return DOMPurify.sanitize(parsed);
});





const fullImageUrl = computed(() => {
  if (!imageUrl.value) return '';
  return imageUrl.value.startsWith('http') ? imageUrl.value : `${baseStore.SERVER_URL}${imageUrl.value}`;
});

const fullFileUrl = computed(() => {
  if (!fileUrl.value) return '';
  return fileUrl.value.startsWith('http') ? fileUrl.value : `${baseStore.SERVER_URL}${fileUrl.value}`;
});

const displayFilename = computed(() => filename.value || '文件');

const fileExtension = computed(() => displayFilename.value.split('.').pop().toLowerCase());

const fileIcon = computed(() => {
  let icon = '📄';
  if (/^(pdf|doc|docx|txt|rtf)$/i.test(fileExtension.value)) {
    icon = '📝';
  } else if (/^(xls|xlsx|csv)$/i.test(fileExtension.value)) {
    icon = '📊';
  } else if (/^(zip|rar|7z|tar|gz)$/i.test(fileExtension.value)) {
    icon = '🗜️';
  } else if (/^(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileExtension.value)) {
    icon = '🖼️';
  } else if (/^(mp3|wav|ogg|flac)$/i.test(fileExtension.value)) {
    icon = '🎵';
  } else if (/^(mp4|avi|mov|wmv|flv)$/i.test(fileExtension.value)) {
    icon = '🎬';
  } else if (/^(exe|dll|bat|sh)$/i.test(fileExtension.value)) {
    icon = '⚙️';
  } else if (/^(ppt|pptx)$/i.test(fileExtension.value)) {
    icon = '📋';
  } else if (/^(js|ts|html|css|php|py|java|c|cpp|cs|go|rb|swift|kt)$/i.test(fileExtension.value)) {
    icon = '💻';
  }
  return icon;
});

const groupCardAvatarUrl = computed(() => {
  if (groupCardAvatarLoadFailed.value) return '';
  
  if (!groupCardData.value) return '';
  const url = groupCardData.value.avatarUrl || groupCardData.value.avatar_url || '';
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${baseStore.SERVER_URL}${url}`;
});

function handleGroupCardAvatarError() {
  groupCardAvatarLoadFailed.value = true;
}

const groupCardGroupName = computed(() => {
  if (!groupCardData.value || !groupCardData.value.group_name) return '';
  return groupCardData.value.group_name;
});

const groupCardGroupDescription = computed(() => {
  if (!groupCardData.value || !groupCardData.value.group_description) return '暂无公告';
  return groupCardData.value.group_description;
});

const groupCardInitials = computed(() => {
  const name = groupCardGroupName.value;
  return name ? name.charAt(0).toUpperCase() : 'G';
});

function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeHtmlForMarkdown(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const parsedContent = computed(() => {
  if (!textContent.value) return '';

  const isMarkdown = props.message.messageType === 5;
  
  // 对于非 Markdown 消息，也要自动识别链接
  if (!isMarkdown) {
    let escapedContent = escapeHtml(textContent.value);
    // 使用正则表达式识别 URL 并转换为可点击链接
    const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
    escapedContent = escapedContent.replace(urlRegex, (url) => {
      return `<a href="${url}" class="message-link" target="_blank" rel="noopener noreferrer" style="color: #3498db; text-decoration: none;">${url}</a>`;
    });
    return `<p>${escapedContent}</p>`;
  }

  let contentToParse = escapeHtml(textContent.value);

  if (baseStore.SERVER_URL) {
    contentToParse = contentToParse.replace(/!\[([^\]]+)\]\(([^)]+)\)/g, (match, alt, url) => {
      const trimmedUrl = url.trim();
      if (trimmedUrl && !trimmedUrl.startsWith('http') && !trimmedUrl.startsWith('//')) {
        return `![${alt}](${baseStore.SERVER_URL}${trimmedUrl})`;
      }
      return match;
    });

    contentToParse = contentToParse.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      const trimmedUrl = url.trim();
      if (trimmedUrl && !trimmedUrl.startsWith('http') && !trimmedUrl.startsWith('//')) {
        if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?(:\d+)?/.test(trimmedUrl)) {
          return `[${text}](https://${trimmedUrl})`;
        } else {
          return `[${text}](${baseStore.SERVER_URL}${trimmedUrl})`;
        }
      }
      return match;
    });

    const urlRegex = /(?<!\]\()(?<!\[)(?<!https?:\/\/[^?&"'<>\s]+\?.*)(?<!https?:\/\/[^?&"'<>\s]+&.*)(https?:\/\/(?:[^\s"'<>]+))/g;
    contentToParse = contentToParse.replace(urlRegex, '[$1]($1)');
  }

  const renderer = new marked.Renderer();
  renderer.code = function({ text, lang }) {
    const language = lang || 'text';
    const code = text;
    const encodedCode = encodeURIComponent(code);
    
    const lines = code.split('\n');
    let lineNumbers = '';
    let codeLines = '';
    lines.forEach((line, index) => {
      lineNumbers += `<pre><span class="line">${index + 1}</span></pre>`;
      codeLines += `<pre><code>${line}</code></pre>`;
    });
    
    return `<figure class="highlight">
      <div class="highlight-tools">
        <div class="macStyle">
          <div class="mac-close"></div>
          <div class="mac-minimize"></div>
          <div class="mac-maximize"></div>
        </div>
        <div class="code-lang">${language}</div>
        <div class="copy-notice"></div>
        <i class="fas fa-paste copy-button" data-code="${encodedCode}"></i>
        <i class="fa-solid fa-up-right-and-down-left-from-center fullpage-button"></i>
      </div>
      <table>
        <tbody>
          <tr>
            <td class="gutter">
              ${lineNumbers}
            </td>
            <td class="code">
              ${codeLines}
            </td>
          </tr>
        </tbody>
      </table>
    </figure>`;
  };

  renderer.codespan = function(token) {
    return `<code>` + token.text + `</code>`;
  };


  marked.setOptions({
    breaks: true,
    gfm: true,
    renderer: renderer
  });

  let parsed = marked.parse(contentToParse).trim();
  parsed = parsed.replace(/<svg[^>]*>.*?<\/svg>/gi, '[SVG图片]');
  parsed = parsed.replace(/<(?!\/?(a|img|div|span|br|p|h[1-6]|strong|em|code|pre|ul|ol|li|blockquote|figure|table|thead|tbody|tr|th|td|i)\b)[^>]*>/gi, '');

  parsed = parsed.replace(/<img/g, '<img class="message-image" style="max-width: 100%; height: auto; cursor: pointer;"');
  parsed = parsed.replace(/<table/g, '<table style="border-collapse: collapse; width: 100%; margin-bottom: 8px;"');  parsed = parsed.replace(/<a/g, '<a class="message-link" target="_blank" rel="noopener noreferrer" style="color: #3498db; text-decoration: none;"');

  parsed = parsed.replace(/<a([^>]*)(href="([^"]*)")([^>]*)>([^<]*)<\/a>/g, (match, attr1, hrefAttr, href, attr2, text) => {
    const hasDownloadAttr = match.includes('download');
    const isHttpLink = /^https?:\/\//i.test(href);
    const isImageLink = /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(href);
    const fileExtensions = /\.(pdf|doc|docx|txt|rtf|xls|xlsx|csv|zip|rar|7z|tar|gz|mp3|wav|ogg|flac|mp4|avi|mov|wmv|flv|exe|dll|bat|sh|ppt|pptx|js|ts|html|css|php|py|java|c|cpp|cs|go|rb|swift|kt|svg)$/i;
    const hasFileExtension = fileExtensions.test(href);

    if (isImageLink) {
      return match;
    }

    if (hasDownloadAttr || (!isHttpLink && hasFileExtension)) {
      const fileExt = href.split('.').pop().toLowerCase();
      let icon = '📄';
      if (/^(pdf|doc|docx|txt|rtf)$/i.test(fileExt)) {
        icon = '📝';
      } else if (/^(xls|xlsx|csv)$/i.test(fileExt)) {
        icon = '📊';
      } else if (/^(zip|rar|7z|tar|gz)$/i.test(fileExt)) {
        icon = '🗜️';
      } else if (/^(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileExt)) {
        icon = '🖼️';
      } else if (/^(mp3|wav|ogg|flac)$/i.test(fileExt)) {
        icon = '🎵';
      } else if (/^(mp4|avi|mov|wmv|flv)$/i.test(fileExt)) {
        icon = '🎬';
      } else if (/^(exe|dll|bat|sh)$/i.test(fileExt)) {
        icon = '⚙️';
      } else if (/^(ppt|pptx)$/i.test(fileExt)) {
        icon = '📋';
      } else if (/^(js|ts|html|css|php|py|java|c|cpp|cs|go|rb|swift|kt)$/i.test(fileExt)) {
        icon = '💻';
      }

      return `<div class="file-link-container"><a${attr1} ${hrefAttr}${attr2} class="file-link" target="_blank"><span class="file-icon">${icon}</span><span>${text}</span></a></div>`;
    }

    return match;
  });

  return DOMPurify.sanitize(parsed);
});

function handleAvatarClick(event) {
  event.stopPropagation();
  openUserAvatarPopup(event, messageUser.value);
}

function handleImageClick(url) {
  modalStore.openModal('imagePreview', url);
}

function handleGroupCardClick(event) {
  event.stopPropagation();
  showGroupCardPopup(event, groupCardData.value);
}



function handleContextMenu(event) {
  event.preventDefault();
  
  const messageElement = event.currentTarget;
  const messageId = messageElement.getAttribute('data-id');
  const currentUserId = baseStore.currentUser?.id;
  const senderNicknameValue = messageElement.querySelector('.msg-sender-name')?.textContent || '';
  const messageType = props.message.messageType || 0;
  
  if (!messageId) return;
  
  hideContextMenu();
  
  const contextMenu = document.createElement('div');
  contextMenu.className = 'message-context-menu';
  contextMenu.style.position = 'fixed';
  contextMenu.style.left = event.clientX + 'px';
  contextMenu.style.top = event.clientY + 'px';
  contextMenu.style.backgroundColor = 'white';
  contextMenu.style.border = '1px solid #ddd';
  contextMenu.style.borderRadius = '4px';
  contextMenu.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
  contextMenu.style.zIndex = '10000';
  contextMenu.style.padding = '5px 0';
  
  const quoteMenuItem = document.createElement('div');
  quoteMenuItem.className = 'context-menu-item';
  quoteMenuItem.textContent = '引用';
  quoteMenuItem.style.padding = '8px 15px';
  quoteMenuItem.style.cursor = 'pointer';
  quoteMenuItem.style.fontSize = '14px';
  quoteMenuItem.style.whiteSpace = 'nowrap';
  
  const userId = messageUser.value?.id;
  
  quoteMenuItem.addEventListener('click', () => {
    let quotedMsgData = {};
    if (messageType === 4) {
      const parsedContent = JSON.parse(props.message.content);
      // 直接读取引用消息JSON的content
      const innerContent = parsedContent.text || parsedContent.content || '';
      quotedMsgData = {
        id: messageId,
        userId: userId,
        nickname: senderNicknameValue,
        avatarUrl: senderAvatarUrl.value || '',
        content: innerContent,
        messageType: 0
      };
    } else {
      quotedMsgData = {
        id: messageId,
        userId: userId,
        nickname: senderNicknameValue,
        avatarUrl: senderAvatarUrl.value || '',
        content: props.message.content,
        messageType: messageType
      };
    }

    inputStore.setQuotedMessage(quotedMsgData);
    hideContextMenu();
  });
  
  contextMenu.appendChild(quoteMenuItem);
  
  const showCopyMenuItem = [0, 1, 2, 5].includes(messageType);
  if (showCopyMenuItem) {
    const copyMenuItem = document.createElement('div');
    copyMenuItem.className = 'context-menu-item';
    copyMenuItem.textContent = '复制';
    copyMenuItem.style.padding = '8px 15px';
    copyMenuItem.style.cursor = 'pointer';
    copyMenuItem.style.fontSize = '14px';
    copyMenuItem.style.whiteSpace = 'nowrap';
    copyMenuItem.addEventListener('mouseenter', () => copyMenuItem.style.backgroundColor = '#f0f0f0');
    copyMenuItem.addEventListener('mouseleave', () => copyMenuItem.style.backgroundColor = 'transparent');
    copyMenuItem.addEventListener('click', async () => {
      let label = '已复制到剪贴板';
      
      if (messageType === 0) {
        const text = props.message.content || '';
        navigator.clipboard.writeText(text).catch(() => {});
      } else if (messageType === 1) {
        try {
          const imgData = JSON.parse(props.message.content);
          const imgUrl = imgData.url || '';
          if (imgUrl) {
            try {
              const fullImgUrl = imgUrl.startsWith('http') ? imgUrl : `${baseStore.SERVER_URL}${imgUrl}`;
              const response = await fetch(fullImgUrl);
              const blob = await response.blob();
              await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
              ]);
              label = '已复制图片';
            } catch {
              navigator.clipboard.writeText(imgUrl).catch(() => {});
              label = '已复制图片链接';
            }
          }
        } catch { /* ignore */ }
      } else if (messageType === 2) {
        try {
          const fileData = JSON.parse(props.message.content);
          const fileUrl = fileData.url || '';
          if (fileUrl) {
            try {
              const fullFileUrl = fileUrl.startsWith('http') ? fileUrl : `${baseStore.SERVER_URL}${fileUrl}`;
              const response = await fetch(fullFileUrl);
              const blob = await response.blob();
              await navigator.clipboard.write([
                new ClipboardItem({ [blob.type]: blob })
              ]);
              label = '已复制文件';
            } catch {
              navigator.clipboard.writeText(fileUrl).catch(() => {});
              label = '已复制文件链接';
            }
          }
        } catch { /* ignore */ }
      } else if (messageType === 5) {
        const text = props.message.content || '';
        navigator.clipboard.writeText(text).catch(() => {});
      }
      
      toast.info(label, 1500);
      hideContextMenu();
    });
    contextMenu.appendChild(copyMenuItem);
  }
  
  const isOwnMessage = messageUser.value && String(messageUser.value.id) === String(currentUserId);
  
  const deleteMenuItem = document.createElement('div');
  deleteMenuItem.className = 'context-menu-item';
  deleteMenuItem.textContent = '删除';
  deleteMenuItem.style.padding = '8px 15px';
  deleteMenuItem.style.cursor = 'pointer';
  deleteMenuItem.style.fontSize = '14px';
  deleteMenuItem.style.whiteSpace = 'nowrap';
  
  deleteMenuItem.addEventListener('click', () => {
    groupStore.deleteGroupMessage(sessionStore.currentGroupId, messageId);
    hideContextMenu();
  });
  
  contextMenu.appendChild(deleteMenuItem);
  
  if (isOwnMessage) {
    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    menuItem.textContent = '撤回';
    menuItem.style.padding = '8px 15px';
    menuItem.style.cursor = 'pointer';
    menuItem.style.fontSize = '14px';
    menuItem.style.whiteSpace = 'nowrap';
    
    menuItem.addEventListener('click', () => {
      const socket = getChatSocket();
      if (socket && messageId) {
        socket.emit('delete-message', {
          messageId: Number(messageId),
          sessionToken: baseStore.currentSessionToken,
          userId: Number(currentUserId)
        });
      }
      hideContextMenu();
    });
    
    contextMenu.appendChild(menuItem);
  }
  
  document.body.appendChild(contextMenu);
  
  currentMessageContextMenu = contextMenu;
  
  const cleanup = setupKeyboard(contextMenu, hideContextMenu);
  contextMenu._cleanup = cleanup;
  
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu);
  }, 0);
}

function hideContextMenu() {
  if (currentMessageContextMenu) {
    if (currentMessageContextMenu._cleanup) {
      currentMessageContextMenu._cleanup();
    }
    document.body.removeChild(currentMessageContextMenu);
    currentMessageContextMenu = null;
  }
  document.removeEventListener('click', hideContextMenu);
}
</script>

<style scoped>
.system-message-wrapper {
  word-break: break-word;
  display: flex;
  flex-direction: column;
  margin-bottom: 10px;
}

.message {
  word-break: break-word;
}

.message-text {
  white-space: pre-wrap;
}

.message-text img {
  max-width: 100%;
  height: auto;
  cursor: pointer;
}

.system-message-container {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px 0;
}

.system-message-text {
  padding: 6px 16px;
  border-radius: 16px;
  font-size: 13px;
  color: #999;
  background-color: #f5f5f5;
  text-align: center;
  max-width: 80%;
}

.system-message-container.system-join .system-message-text {
  color: #52c41a;
  background-color: #f6ffed;
  border: 1px solid #b7eb8f;
}

.system-message-container.system-leave .system-message-text {
  color: #faad14;
  background-color: #fffbe6;
  border: 1px solid #ffe58f;
}

.system-message-container.system-dismiss .system-message-text {
  color: #f5222d;
  background-color: #fff1f0;
  border: 1px solid #ffa39e;
}

.system-message-container.system-friend .system-message-text {
  color: #1890ff;
  background-color: #e6f7ff;
  border: 1px solid #91d5ff;
}

.system-message-container.system-recall .system-message-text {
  color: #722ed1;
  background-color: #f9f0ff;
  border: 1px solid #d3adf7;
}

.system-message-container.system-default .system-message-text {
  color: #666;
  background-color: #f0f0f0;
  border: 1px solid #e0e0e0;
}
</style>

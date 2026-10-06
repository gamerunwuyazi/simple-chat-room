import { defineStore } from 'pinia';
import { ref } from 'vue';
import { useBaseStore } from './baseStore';
import { useGroupStore } from './groupStore';
import { useFriendStore } from './friendStore';
import { usePublicStore } from './publicStore';
import { useInputStore } from './inputStore';

export const useSessionStore = defineStore('session', () => {
  const currentGroupId = ref(null);
  const currentGroupName = ref('');
  const currentPrivateChatUserId = ref(null);
  const currentPrivateChatUsername = ref('');
  const currentPrivateChatNickname = ref('');
  const currentPrivateChatAvatarUrl = ref('');
  const currentActiveChat = ref('main');
  const currentSendChatType = ref('main');
  const selectedGroupIdForCard = ref(null);
  // /chat 右侧聊天面板当前渲染的类型：main=聊天室，private=私信，group=群组
  // 主聊天室二级侧边栏点击聊天项时切换，不跳转路由
  const chatPanelType = ref('main');
  // 私信面板内是否显示"新的朋友"好友申请列表（点击私信侧边栏置顶的"新的朋友"置位）
  const showFriendRequests = ref(false);

  function setCurrentGroupId(id) {
    const groupStore = useGroupStore();
    const friendStore = useFriendStore();
    const publicStore = usePublicStore();
    const baseStore = useBaseStore();

    currentGroupId.value = id;
    const inputStore = useInputStore();
    if (inputStore) inputStore.clearQuotedMessage();
    if (groupStore) groupStore.clearOtherGroupMessages(id);
    if (publicStore) publicStore.clearPublicMessagesExceptRecent();
    if (friendStore) friendStore.clearOtherPrivateMessages(null);
    if (id && groupStore) groupStore.clearGroupHasAtMe(id);
  }

  function setCurrentPrivateChatUserId(id) {
    const groupStore = useGroupStore();
    const friendStore = useFriendStore();
    const publicStore = usePublicStore();
    const inputStore = useInputStore();

    currentPrivateChatUserId.value = id;
    if (inputStore) inputStore.clearQuotedMessage();
    if (friendStore) friendStore.clearOtherPrivateMessages(id);
    if (publicStore) publicStore.clearPublicMessagesExceptRecent();
    if (groupStore) groupStore.clearOtherGroupMessages(null);
  }

  function setCurrentActiveChat(type) {
    const groupStore = useGroupStore();
    const friendStore = useFriendStore();
    const publicStore = usePublicStore();
    const inputStore = useInputStore();

    currentActiveChat.value = type;
    if (inputStore) inputStore.clearQuotedMessage();
    if (type === 'main') {
      if (publicStore) publicStore.clearPublicMessagesExceptRecent();
      if (groupStore) groupStore.clearOtherGroupMessages(null);
      if (friendStore) friendStore.clearOtherPrivateMessages(null);
    } else if (type.startsWith('group_')) {
      const groupId = type.replace('group_', '');
      if (groupStore) groupStore.clearOtherGroupMessages(groupId);
      if (publicStore) publicStore.clearPublicMessagesExceptRecent();
      if (friendStore) friendStore.clearOtherPrivateMessages(null);
      if (groupId && groupStore) groupStore.clearGroupHasAtMe(groupId);
    } else if (type.startsWith('private_')) {
      const userId = type.replace('private_', '');
      if (friendStore) friendStore.clearOtherPrivateMessages(userId);
      if (publicStore) publicStore.clearPublicMessagesExceptRecent();
      if (groupStore) groupStore.clearOtherGroupMessages(null);
    }
  }

  function setChatPanelType(type) {
    if (type === 'main' || type === 'private' || type === 'group') {
      chatPanelType.value = type;
    }
  }

  return {
    currentGroupId,
    currentGroupName,
    currentPrivateChatUserId,
    currentPrivateChatUsername,
    currentPrivateChatNickname,
    currentPrivateChatAvatarUrl,
    currentActiveChat,
    currentSendChatType,
    selectedGroupIdForCard,
    chatPanelType,
    showFriendRequests,
    setCurrentGroupId,
    setCurrentPrivateChatUserId,
    setCurrentActiveChat,
    setChatPanelType
  };
});

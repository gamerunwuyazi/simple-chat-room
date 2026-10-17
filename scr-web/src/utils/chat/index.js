import { marked, io, toast, SERVER_URL, getModalId, getModalNameFromId, MODAL_MAP } from './config.js';
import * as groupModule from './group.js';
import {
  escapeHtml,
  formatFileSize,
  sendMessage,
  sendGroupMessage,
  sendPrivateMessage,
  clearContentEditable
} from './message.js';
import * as privateModule from './private.js';
import {
  useBaseStore,
  useUserStore,
  useFriendStore,
  useGroupStore,
  useUnifiedStore,
  useModalStore,
  useSessionStore,
  useStorageStore,
  useUnreadStore,
  useDraftStore,
  useInputStore,
  getChatSocket
} from '@/stores/index.js';
import * as uiModule from './ui.js';
import * as uploadModule from './upload.js';
import * as websocketModule from './websocket.js';
import { getRouter, setRouter, navigateTo } from './routerInstance.js';
import { getSelfInfo } from '@/api/user.js';

async function login() {
  const currentSessionToken = localStorage.getItem('currentSessionToken');
  const chatUserId = localStorage.getItem('chatUserId');

  const baseStore = useBaseStore();
  const userStore = useUserStore();
  const sessionStore = useSessionStore();

  if (baseStore) {
    let currentUser = null;

    if (chatUserId) {
      currentUser = {
        id: chatUserId
      };
    }

    if (currentUser && currentSessionToken) {
      baseStore.setCurrentUser(currentUser);
      baseStore.setCurrentSessionToken(currentSessionToken);

      try {
        const response = await getSelfInfo();
        const data = response.data;
        if (data.user) {
          baseStore.setCurrentUser({
            id: data.user.id,
            username: data.user.username,
            nickname: data.user.nickname,
            gender: data.user.gender,
            signature: data.user.signature,
            avatar_url: data.user.avatar_url,
            friend_verification: data.user.friend_verification
          });
        }
      } catch (error) {
        console.error('获取用户信息失败:', error);
      }
    }
  }

  if (getRouter()) {
    navigateTo('/chat');
  }

  setTimeout(() => {
    uiModule.initializeChat();
  }, 100);
}

export {
  marked,
  io,
  toast,
  SERVER_URL,
  getModalId,
  getModalNameFromId,
  MODAL_MAP,
  useBaseStore,
  useUserStore,
  useFriendStore,
  useGroupStore,
  useUnifiedStore,
  useModalStore,
  useSessionStore,
  useStorageStore,
  useUnreadStore,
  useDraftStore,
  useInputStore,
  getChatSocket,
  escapeHtml,
  formatFileSize,
  sendMessage,
  sendGroupMessage,
  sendPrivateMessage,
  clearContentEditable,
  login,
  getRouter,
  setRouter,
  navigateTo,
  privateModule,
  groupModule,
  uiModule,
  uploadModule,
  websocketModule
};

export const {
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
  addFriend,
  getMutedPrivateChats,
  isPrivateMuted,
  togglePrivateMute
} = privateModule;

export const {
  loadGroupList,
  getMutedGroups,
  isGroupMuted,
  toggleGroupMute,
  loadGroupMembers,
  showAddGroupMemberModal,
  hideAddGroupMemberModal,
  confirmAddGroupMembers,
  updateGroupName,
  updateGroupNotice,
  uploadGroupAvatar,
  joinGroupWithToken,
  showGroupCardPopup,
  moveGroupToTop,
  switchToGroupChat,
  loadGroupMessages,
  updateGroupList,
  showSendGroupCardModal,
  sendGroupCard,
  handleDissolveGroup,
  handleLeaveGroup,
  dissolveGroup,
  removeMemberFromGroup,
  groupsList,
  currentSharedGroup,
  switchingGroupWithExistingMessages
} = groupModule;

export const {
  openModal,
  closeModal,
  initializeFocusListeners,
  updateUnreadCountsDisplay,
  setActiveChat,
  initializeChat,
  adjustChatLayout,
  updateGroupMuteIcon,
  updateGroupListDisplay,
  currentGroupId,
  currentGroupName,
  currentUser,
  currentSessionToken,
  currentPrivateChatUserId,
  currentPrivateChatUsername,
  currentPrivateChatNickname,
  currentSendChatType,
  selectedGroupIdForCard
} = uiModule;

export const {
  uploadImage,
  uploadFile,
  uploadVideo,
  uploadPrivateImage,
  uploadPrivateFile,
  uploadPrivateVideo,
  uploadUserAvatar,
  initializeScrollLoading,
  initializeImageClickEvents,
  resetLoadingState,
} = uploadModule;

export const {
  initializeWebSocket,
  disconnectWebSocket,
  sendReadMessageEvent,
  sendClearGroupUnread,
  sendClearGlobalUnread,
  loadMessages
} = websocketModule;

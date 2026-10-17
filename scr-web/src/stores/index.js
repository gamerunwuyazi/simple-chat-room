import { useBaseStore } from './baseStore.js';
import { useUserStore } from './userStore.js';
import { useFriendStore } from './friendStore.js';
import { useGroupStore } from './groupStore.js';
import { useUnifiedStore } from './unifiedStore.js';
import { useModalStore } from './modalStore.js';
import { useSessionStore } from './sessionStore.js';
import { useStorageStore } from './storageStore.js';
import { useUnreadStore } from './unreadStore.js';
import { useDraftStore } from './draftStore.js';
import { useInputStore } from './inputStore.js';

let _chatSocket = null;
let _showUserAvatarPopupVue = null;
let _hideUserAvatarPopupVue = null;
let _showGroupCardPopupVue = null;

function setChatSocket(socket) {
  _chatSocket = socket;
}

function getChatSocket() {
  return _chatSocket;
}

function registerPopupFunctions(showUserAvatar, hideUserAvatar, showGroupCard) {
  _showUserAvatarPopupVue = showUserAvatar;
  _hideUserAvatarPopupVue = hideUserAvatar;
  _showGroupCardPopupVue = showGroupCard;
}

function openUserAvatarPopup(event, user) {
  if (_showUserAvatarPopupVue) _showUserAvatarPopupVue(event, user);
}

function closeUserAvatarPopup() {
  if (_hideUserAvatarPopupVue) _hideUserAvatarPopupVue();
}

function openGroupCardPopup(event, groupData) {
  if (_showGroupCardPopupVue) _showGroupCardPopupVue(event, groupData);
}

export {
  setChatSocket,
  getChatSocket,
  registerPopupFunctions,
  openUserAvatarPopup,
  closeUserAvatarPopup,
  openGroupCardPopup
};

export {
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
  useInputStore
};

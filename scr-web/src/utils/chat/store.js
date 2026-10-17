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
  setChatSocket,
  getChatSocket as getChatSocketFromStore,
  registerPopupFunctions,
  openUserAvatarPopup,
  closeUserAvatarPopup,
  openGroupCardPopup
} from '@/stores/index.js';

export { getChatSocketFromStore as getChatSocket };
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
  useInputStore,
  setChatSocket,
  registerPopupFunctions,
  openUserAvatarPopup,
  closeUserAvatarPopup,
  openGroupCardPopup
};

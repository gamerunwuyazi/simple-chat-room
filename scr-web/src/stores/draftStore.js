import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref({
    groups: {},
    private: {},
    main: ''
  });

  let _getDependencies = null;

  function setDependencies(getDeps) {
    _getDependencies = getDeps;
  }

  function getDeps() {
    if (!_getDependencies) return null;
    return _getDependencies();
  }

  function saveDraft(chatType, id, content) {
    const deps = getDeps();
    const { groupsList, friendsList, getGroupLastMessage, getPrivateLastMessage } = deps || {};

    // 主聊天室草稿：单槽字符串，仅在切换离开主聊天室时保存，用于列表项显示
    if (chatType === 'main') {
      drafts.value.main = content || '';
      return;
    }

    if (chatType === 'group' && id) {
      drafts.value.groups[id] = content;
      if (groupsList?.value) {
        const group = groupsList.value.find(g => String(g.id) === String(id));
        if (group) {
          group.lastMessage = content ? { content: `[草稿] ${content}`, nickname: '我', messageType: 0 } : (getGroupLastMessage ? getGroupLastMessage(id) : null);
        }
      }
    } else if (chatType === 'private' && id) {
      drafts.value.private[id] = content;
      if (friendsList?.value) {
        const friend = friendsList.value.find(f => String(f.id) === String(id));
        if (friend) {
          friend.lastMessage = content ? { content: `[草稿] ${content}`, nickname: '我', messageType: 0 } : (getPrivateLastMessage ? getPrivateLastMessage(id) : null);
        }
      }
    }
  }

  function getDraft(chatType, id) {
    if (chatType === 'main') return drafts.value.main || '';
    if (chatType === 'group' && id) return drafts.value.groups[id] || '';
    if (chatType === 'private' && id) return drafts.value.private[id] || '';
    return '';
  }

  function clearDraft(chatType, id) {
    const deps = getDeps();
    const { groupsList, friendsList, getGroupLastMessage, getPrivateLastMessage } = deps || {};

    if (chatType === 'main') {
      drafts.value.main = '';
      return;
    }

    if (chatType === 'group' && id) {
      delete drafts.value.groups[id];
      if (groupsList?.value) {
        const group = groupsList.value.find(g => String(g.id) === String(id));
        if (group) group.lastMessage = getGroupLastMessage ? getGroupLastMessage(id) : null;
      }
    } else if (chatType === 'private' && id) {
      delete drafts.value.private[id];
      if (friendsList?.value) {
        const friend = friendsList.value.find(f => String(f.id) === String(id));
        if (friend) friend.lastMessage = getPrivateLastMessage ? getPrivateLastMessage(id) : null;
      }
    }
  }

  function tempRestoreLastMessage(chatType, id) {
    const deps = getDeps();
    const { groupsList, friendsList, getGroupLastMessage, getPrivateLastMessage } = deps || {};

    if (chatType === 'group' && id && groupsList?.value) {
      const group = groupsList.value.find(g => String(g.id) === String(id));
      if (group) group.lastMessage = getGroupLastMessage ? getGroupLastMessage(id) : null;
    } else if (chatType === 'private' && id && friendsList?.value) {
      const friend = friendsList.value.find(f => String(f.id) === String(id));
      if (friend) friend.lastMessage = getPrivateLastMessage ? getPrivateLastMessage(id) : null;
    }
  }

  function setLastMessageToDraft(chatType, id) {
    const deps = getDeps();
    const { groupsList, friendsList } = deps || {};

    if (chatType === 'group' && id) {
      const draftContent = drafts.value.groups[id];
      if (draftContent && groupsList?.value) {
        const group = groupsList.value.find(g => String(g.id) === String(id));
        if (group) group.lastMessage = { content: `[草稿] ${draftContent}`, nickname: '我', messageType: 0 };
      }
    } else if (chatType === 'private' && id) {
      const draftContent = drafts.value.private[id];
      if (draftContent && friendsList?.value) {
        const friend = friendsList.value.find(f => String(f.id) === String(id));
        if (friend) friend.lastMessage = { content: `[草稿] ${draftContent}`, nickname: '我', messageType: 0 };
      }
    }
  }

  return {
    drafts,
    setDependencies,
    saveDraft,
    getDraft,
    clearDraft,
    tempRestoreLastMessage,
    setLastMessageToDraft
  };
});

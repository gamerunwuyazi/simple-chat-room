import { defineStore } from 'pinia';
import { ref, toRaw } from 'vue';
import { useStorageStore } from './storageStore';
import { useBaseStore } from './baseStore';

export const useUnifiedStore = defineStore('unified', () => {
  const unifiedMessages = ref([]);
  const unifiedAllLoaded = ref(false);
  const unifiedStored = ref(false);
  const unifiedPageSize = ref(20);
  const unifiedPageOffset = ref(0);
  const unifiedLoadingMore = ref(false);

  function addUnifiedMessage(message) {
    const storageStore = useStorageStore();
    const baseStore = useBaseStore();

    const isWithdrawMessage = message.messageType === 101;
    const isUserInfoUpdateMessage = message.messageType === 102;
    const messages = baseStore.loading ? storageStore.getCacheUnified() : unifiedMessages.value;
    const exists = messages.some(m => m.id === message.id);
    if (!exists && !isWithdrawMessage && !isUserInfoUpdateMessage) messages.push(message);

    if (!storageStore.fullUnifiedMessages || storageStore.fullUnifiedMessages === null || !storageStore.fullUnifiedMessages) {
      storageStore.fullUnifiedMessages = [message];
    } else {
      const fullExists = storageStore.fullUnifiedMessages.some(m => m.id === message.id);
      if (!fullExists) storageStore.fullUnifiedMessages.push(message);
    }
    if (message.id && message.id > storageStore.publicAndGroupMinId) {
      storageStore.publicAndGroupMinId = message.id;
      storageStore.saveMinIds();
    }
    if (!baseStore.loading) {
      unifiedStored.value = false;
      storageStore.saveToStorage();
    }
  }

  function setUnifiedMessages(messages) {
    const storageStore = useStorageStore();
    const baseStore = useBaseStore();

    if (baseStore.loading) {
      storageStore.getCacheUnified().length = 0;
      storageStore.getCacheUnified().push(...messages.filter(m => m.messageType !== 101 && m.messageType !== 102));
    } else {
      if (!storageStore.fullUnifiedMessages || storageStore.fullUnifiedMessages === null || !storageStore.fullUnifiedMessages) {
        storageStore.fullUnifiedMessages = [...messages];
      } else {
        const fullExistingIds = new Set(storageStore.fullUnifiedMessages.map(m => m.id));
        const fullNewMessages = messages.filter(m => !fullExistingIds.has(m.id));
        storageStore.fullUnifiedMessages = [...storageStore.fullUnifiedMessages, ...fullNewMessages];
      }
      const filteredMessages = messages.filter(m => m.messageType !== 101 && m.messageType !== 102);
      unifiedMessages.value = filteredMessages.slice(Math.max(0, filteredMessages.length - 20), filteredMessages.length);
      unifiedStored.value = false;
      storageStore.saveToStorage();
    }
  }

  function prependUnifiedMessages(messages) {
    const storageStore = useStorageStore();
    const baseStore = useBaseStore();

    const targetMessages = baseStore.loading ? storageStore.getCacheUnified() : unifiedMessages.value;
    const existingIds = new Set(targetMessages.map(m => m.id));
    const newMessages = messages.filter(m => !existingIds.has(m.id));
    const displayNewMessages = newMessages.filter(m => m.messageType !== 101 && m.messageType !== 102);

    if (baseStore.loading) {
      displayNewMessages.sort((a, b) => a.id - b.id);
      storageStore.getCacheUnified().unshift(...displayNewMessages);
    } else {
      if (storageStore.fullUnifiedMessages && storageStore.fullUnifiedMessages !== null) {
        const fullIds = new Set(storageStore.fullUnifiedMessages.map(m => m.id));
        const fullNewMessages = newMessages.filter(m => !fullIds.has(m.id));
        fullNewMessages.sort((a, b) => a.id - b.id);
        storageStore.fullUnifiedMessages = [...fullNewMessages, ...storageStore.fullUnifiedMessages];
      } else {
        storageStore.fullUnifiedMessages = [...displayNewMessages];
      }
      displayNewMessages.sort((a, b) => a.id - b.id);
      unifiedMessages.value = [...displayNewMessages, ...unifiedMessages.value];
      unifiedStored.value = false;
      storageStore.saveToStorage();
    }
  }

  function clearUnifiedMessages() {
    const storageStore = useStorageStore();
    unifiedMessages.value = [];
    unifiedStored.value = false;
    storageStore.saveToStorage();
  }

  function deleteUnifiedMessage(messageId) {
    const storageStore = useStorageStore();

    const index = unifiedMessages.value.findIndex(m => String(m.id) === String(messageId));
    if (index !== -1) unifiedMessages.value.splice(index, 1);

    if (storageStore.fullUnifiedMessages) {
      const fullIndex = storageStore.fullUnifiedMessages.findIndex(m => String(m.id) === String(messageId));
      if (fullIndex !== -1) storageStore.fullUnifiedMessages.splice(fullIndex, 1);
    }

    unifiedStored.value = false;
    storageStore.saveToStorage();
  }

  function clearUnifiedMessagesExceptRecent() {
    if (unifiedMessages.value.length > 20) {
      unifiedMessages.value = unifiedMessages.value.slice(Math.max(0, unifiedMessages.value.length - 20), unifiedMessages.value.length);
    }
  }

  function setUnifiedAllLoaded(value) {
    unifiedAllLoaded.value = value;
  }

  function isUnifiedAllLoaded() {
    return unifiedAllLoaded.value;
  }

  function updateQuotedMessage(messageId, newContent) {
    const storageStore = useStorageStore();
    let updated = false;

    const index = unifiedMessages.value.findIndex(m => String(m.id) === String(messageId));
    if (index !== -1) {
      unifiedMessages.value[index] = toRaw({ ...toRaw(unifiedMessages.value[index]), content: newContent });
      updated = true;
    }

    if (storageStore.fullUnifiedMessages) {
      const fullIndex = storageStore.fullUnifiedMessages.findIndex(m => String(m.id) === String(messageId));
      if (fullIndex !== -1) {
        storageStore.fullUnifiedMessages[fullIndex] = toRaw({ ...toRaw(storageStore.fullUnifiedMessages[fullIndex]), content: newContent });
        updated = true;
      }
    }

    if (updated) {
      unifiedStored.value = false;
      storageStore.saveToStorage();
    }

    return updated;
  }

  return {
    unifiedMessages,
    unifiedAllLoaded,
    unifiedStored,
    unifiedPageSize,
    unifiedPageOffset,
    unifiedLoadingMore,
    addUnifiedMessage,
    setUnifiedMessages,
    prependUnifiedMessages,
    clearUnifiedMessages,
    deleteUnifiedMessage,
    clearUnifiedMessagesExceptRecent,
    setUnifiedAllLoaded,
    isUnifiedAllLoaded,
    updateQuotedMessage
  };
});

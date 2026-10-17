<template>
  <div>
    <router-view></router-view>
    <div v-if="baseStore.showFetchingMessage" class="fetching-message-overlay">
      <div class="fetching-message-box">
        <i class="fas fa-spinner fa-spin"></i>
        <span>拉取消息中...</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'

import { useBaseStore } from '@/stores/baseStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useGroupStore } from '@/stores/groupStore'
import { initializeChat } from "@/utils/chat"

const userLoggedIn = ref(false)
const baseStore = useBaseStore()
const unreadStore = useUnreadStore()
const groupStore = useGroupStore()
const originalTitle = ref(document.title)

function checkLoginStatus() {
  const currentSessionToken = localStorage.getItem('currentSessionToken')
  const chatUserId = localStorage.getItem('chatUserId')
  
  const isLoggedIn = !!chatUserId && !!currentSessionToken
  
  userLoggedIn.value = isLoggedIn
  return isLoggedIn
}

onMounted(() => {
  checkLoginStatus()
  
  if (userLoggedIn.value) {
    initializeChat()
  }
})

watch(
  [
    () => unreadStore.unreadMessages,
    () => groupStore.groupsWithAtMe,
    () => unreadStore.hasUnifiedAtMe
  ],
  () => {
    const unreadMessages = unreadStore.unreadMessages
    if (!unreadMessages) return

    let totalUnread = unreadMessages.global || 0

    if (unreadMessages.groups) {
      for (const groupId in unreadMessages.groups) {
        totalUnread += unreadMessages.groups[groupId] || 0
      }
    }

    let mutedPrivateChats = []
    try {
      mutedPrivateChats = JSON.parse(localStorage.getItem('mutedPrivateChats') || '[]')
    } catch {
      mutedPrivateChats = []
    }

    if (unreadMessages.private) {
      for (const userId in unreadMessages.private) {
        if (!mutedPrivateChats.includes(userId)) {
          totalUnread += unreadMessages.private[userId] || 0
        }
      }
    }

    // 检查是否有@我的消息（群组或主聊天室）
    const groupsWithAtMe = groupStore.groupsWithAtMe || {}
    const hasAnyGroupAtMe = Object.values(groupsWithAtMe).some(v => v === true)
    const hasUnifiedAtMe = unreadStore.hasUnifiedAtMe || false
    const hasAnyAtMe = hasAnyGroupAtMe || hasUnifiedAtMe

    if (totalUnread > 0) {
      if (hasAnyAtMe) {
        document.title = `（@我的消息）${originalTitle.value}`
      } else {
        document.title = `（${totalUnread}条未读）${originalTitle.value}`
      }
    } else {
      document.title = originalTitle.value
    }
  },
  { deep: true, immediate: true }
)
</script>

<style scoped>
.fetching-message-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.fetching-message-box {
  background-color: white;
  padding: 20px 40px;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
}

.fetching-message-box i {
  color: #4a90e2;
}
</style>

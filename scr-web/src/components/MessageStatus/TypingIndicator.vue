<template>
  <div v-if="text" class="typing-indicator" aria-live="polite">
    <span class="typing-text">{{ text }}</span>
    <span class="typing-dots">
      <i class="typing-dot"></i>
      <i class="typing-dot"></i>
      <i class="typing-dot"></i>
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  names: { type: Array, default: () => [] },
  // 私聊侧：不显示对方昵称，统一显示「对方正在输入」
  peer: { type: Boolean, default: false }
});

const text = computed(() => {
  const list = (props.names || []).filter(Boolean);
  if (list.length === 0) return '';
  if (props.peer) return '对方正在输入';
  if (list.length === 1) return `${list[0]} 正在输入`;
  if (list.length === 2) return `${list[0]}、${list[1]} 正在输入`;
  return `${list[0]} 等 ${list.length} 人正在输入`;
});
</script>

<style scoped>
.typing-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 14px 4px;
  font-size: 12px;
  color: #8a8f98;
  min-height: 18px;
}

.typing-dots {
  display: inline-flex;
  gap: 3px;
}

.typing-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: typing-blink 1.2s infinite ease-in-out;
}

.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing-blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 0.9; }
}

@media (prefers-reduced-motion: reduce) {
  .typing-dot { animation: none; opacity: 0.5; }
}
</style>

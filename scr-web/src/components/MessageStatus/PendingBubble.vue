<template>
  <div :class="['message', 'own-message', 'pending-message', status === 'failed' ? 'is-failed' : 'is-sending']">
    <div class="msg-body pending-body">
      <div class="msg-bubble">
        <div class="msg-bubble-content pending-text">{{ preview }}</div>
      </div>
      <div class="pending-status">
        <span v-if="status !== 'failed'" class="pending-sending" title="发送中">
          <i class="pending-dot"></i>
          <i class="pending-dot"></i>
          <i class="pending-dot"></i>
        </span>
        <template v-else>
          <button
            class="pending-failed"
            type="button"
            :title="error ? `${error}，点击重发` : '发送失败，点击重发'"
            @click.stop="$emit('retry')"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
              <path
                d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8v3l4-4-4-4v3z"
                fill="currentColor"
              />
            </svg>
            <span class="pending-failed-text">重发</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  content: { type: String, default: '' },
  messageType: { type: Number, default: 0 },
  status: { type: String, default: 'sending' },
  error: { type: String, default: '' }
});

defineEmits(['retry']);

function extractText(raw) {
  if (!raw) return '';
  if (props.messageType === 4) {
    try {
      const parsed = JSON.parse(raw);
      return parsed.text || parsed.content || raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

const preview = computed(() => {
  const text = extractText(props.content).replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
});
</script>

<style scoped>
.pending-message {
  opacity: 0.95;
}

.pending-body {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.pending-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.pending-status {
  margin-top: 2px;
  height: 16px;
  display: flex;
  align-items: center;
}

.pending-sending {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.pending-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: pending-blink 1.2s infinite ease-in-out;
}

.pending-dot:nth-child(2) {
  animation-delay: 0.2s;
}

.pending-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes pending-blink {
  0%, 80%, 100% { opacity: 0.25; transform: scale(0.9); }
  40% { opacity: 0.9; transform: scale(1.1); }
}

.pending-failed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: #e5484d;
  font-size: 12px;
  cursor: pointer;
}

.pending-failed:hover {
  text-decoration: underline;
}

.is-failed .pending-text {
  border: 1px solid rgba(229, 72, 77, 0.55);
}

@media (prefers-reduced-motion: reduce) {
  .pending-dot { animation: none; opacity: 0.5; }
}
</style>

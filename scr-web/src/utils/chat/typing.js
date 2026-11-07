import { computed, ref } from 'vue';
import { getChatSocket, useBaseStore } from '@/stores/index.js';
import { useTypingStore } from '@/stores/typingStore.js';

const THROTTLE = 1500;
const IDLE_STOP = 4000;

export const TYPING_SETTING_KEY = 'chat:show-typing';

function readStoredSetting() {
  try {
    const raw = localStorage.getItem(TYPING_SETTING_KEY);
    if (raw === '0') return false;
    if (raw === '1') return true;
  } catch (e) {
    // localStorage 不可用时回落到用户字段
  }
  return null;
}

function readUserSetting() {
  const user = useBaseStore().currentUser;
  if (!user) return true;
  return Number(user.show_typing ?? 1) !== 0;
}

/**
 * 设置页开关的全局状态：发送与显示共用同一份，
 * 切换后三个聊天页的「正在输入」立即生效，无需刷新。
 * 本地无记录（null）时回落到用户自身 show_typing。
 */
const storedSetting = ref(readStoredSetting());

export const typingSetting = computed(() => {
  if (storedSetting.value !== null) return storedSetting.value;
  return readUserSetting();
});

/** 设置页切换时调用，同时写 localStorage 便于刷新后保留 */
export function setTypingSetting(enabled) {
  storedSetting.value = !!enabled;
  try {
    localStorage.setItem(TYPING_SETTING_KEY, enabled ? '1' : '0');
  } catch (e) {
    // 忽略隐私模式/配额异常
  }
}

const _lastSent = {};
const _idleTimers = {};

function keyOf(scope, targetId) {
  return `${scope}:${targetId === null || targetId === undefined ? '' : targetId}`;
}

function socket() {
  return getChatSocket();
}

function canSend() {
  const user = useBaseStore().currentUser;
  if (!user) return false;
  // 自己关掉「正在输入」就不再发包（群侧开关由服务端兜底）
  return typingSetting.value;
}

function emitTyping(scope, targetId, typing) {
  const chatSocket = socket();
  if (!chatSocket) return;
  const baseStore = useBaseStore();
  const payload = {
    scope,
    typing,
    userId: baseStore.currentUser?.id,
    sessionToken: baseStore.currentSessionToken
  };
  if (scope === 'group') payload.groupId = targetId;
  if (scope === 'private') payload.toUserId = targetId;
  chatSocket.emit(typing ? 'typing-start' : 'typing-stop', payload);
}

/**
 * 输入中调用：同一个会话 1500ms 内最多发一次 typing-start，4s 无输入自动 stop
 */
export function notifyTyping(scope, targetId) {
  if (!canSend() || !targetId) return;
  const key = keyOf(scope, targetId);
  const now = Date.now();
  if (!_lastSent[key] || now - _lastSent[key] >= THROTTLE) {
    _lastSent[key] = now;
    emitTyping(scope, targetId, true);
  }
  if (_idleTimers[key]) clearTimeout(_idleTimers[key]);
  _idleTimers[key] = setTimeout(() => {
    delete _idleTimers[key];
    delete _lastSent[key];
    emitTyping(scope, targetId, false);
  }, IDLE_STOP);
}

/** 发送消息 / 清空输入 / 切会话时调用 */
export function stopTyping(scope, targetId) {
  if (!targetId) return;
  const key = keyOf(scope, targetId);
  if (_idleTimers[key]) {
    clearTimeout(_idleTimers[key]);
    delete _idleTimers[key];
  }
  if (_lastSent[key]) {
    delete _lastSent[key];
    emitTyping(scope, targetId, false);
  }
}

/** 收到 typing-update，交给 store 做 5s 本地超时 */
export function handleTypingUpdate(payload) {
  if (!payload) return;
  const scope = payload.scope === 'private' ? 'private' : 'group';
  const targetId = scope === 'group'
    ? (payload.groupId ?? payload.targetId ?? null)
    : (payload.toUserId ?? payload.userId ?? null);
  const baseStore = useBaseStore();
  const selfId = baseStore.currentUser?.id;
  if (selfId && String(payload.userId) === String(selfId)) return;
  useTypingStore().apply({
    scope,
    targetId: scope === 'private' ? payload.userId ?? targetId : targetId,
    userId: payload.userId,
    nickname: payload.nickname,
    typing: payload.typing !== false,
    at: payload.at
  });
}

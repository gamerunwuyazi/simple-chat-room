import { getChatSocket, useBaseStore, useDraftStore } from '@/stores/index.js';
import { useMessageStatusStore } from '@/stores/messageStatusStore.js';
import { toast } from './config.js';

const SEND_TIMEOUT = 5000;
// 已送达记录的兜底清理时限。正常路径由视图侧 pruneRendered 按 messageId 交接后立即清掉；
// 这里只兜底「消息始终没渲染出来」的情况（离线消息被过滤、列表被清空等），
// 给足 15s 是为了别在消息渲染稍慢时提前撤掉气泡、又留出一帧空白
const ACK_KEEP = 15000;

const _timers = {};

function socket() {
  return getChatSocket();
}

export function newClientMsgId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `c${Date.now().toString(36)}${rand}`;
}

function clearTimer(clientMsgId) {
  if (_timers[clientMsgId]) {
    clearTimeout(_timers[clientMsgId]);
    delete _timers[clientMsgId];
  }
}

function armTimeout(clientMsgId) {
  clearTimer(clientMsgId);
  _timers[clientMsgId] = setTimeout(() => {
    delete _timers[clientMsgId];
    const record = useMessageStatusStore().get(clientMsgId);
    if (record && record.status === 'sending') {
      useMessageStatusStore().markFailed(clientMsgId, '发送超时');
    }
  }, SEND_TIMEOUT);
}

function emitPayload(record) {
  const chatSocket = socket();
  if (!chatSocket) return false;
  const baseStore = useBaseStore();
  const payload = {
    ...record.payload,
    clientMsgId: record.clientMsgId,
    userId: baseStore.currentUser?.id ?? record.payload.userId
  };
  if (baseStore.currentSessionToken) {
    payload.sessionToken = baseStore.currentSessionToken;
  }
  chatSocket.emit(record.scope === 'private' ? 'send-private-message' : 'send-message', payload);
  return true;
}

/**
 * 登记一条待发送消息并发出
 * @param {object} options
 * @param {'group'|'private'} options.scope
 * @param {number|string|null} options.targetId 群 id 或对方用户 id
 * @param {object} options.payload 原始 socket 负载（不含 clientMsgId）
 * @param {string} options.content 用于失败气泡展示的纯文本
 * @param {number} options.messageType
 */
export function sendTracked({ scope, targetId, payload, content, messageType }) {
  const clientMsgId = newClientMsgId();
  const store = useMessageStatusStore();
  store.begin({ clientMsgId, scope, targetId, payload, content, messageType });
  armTimeout(clientMsgId);
  if (!emitPayload(store.get(clientMsgId))) {
    clearTimer(clientMsgId);
    store.markFailed(clientMsgId, '连接已断开');
    return null;
  }
  return clientMsgId;
}

/** 失败气泡点击重发：复用同一 clientMsgId，状态回 sending */
export function resend(clientMsgId) {
  const store = useMessageStatusStore();
  const record = store.get(clientMsgId);
  if (!record || record.status === 'sent') return false;
  store.markSending(clientMsgId);
  armTimeout(clientMsgId);
  const ok = emitPayload(record);
  if (!ok) {
    clearTimer(clientMsgId);
    store.markFailed(clientMsgId, '连接已断开');
    toast.error('连接已断开，请稍后重试');
    return false;
  }
  return true;
}

export function dismiss(clientMsgId) {
  clearTimer(clientMsgId);
  useMessageStatusStore().remove(clientMsgId);
}

/**
 * 统一处理发送回执（message-sent / private-message-sent）
 * @returns {boolean} 是否按 clientMsgId 命中了一条本地待发送记录
 */
export function handleSendAck(data) {
  const clientMsgId = data?.clientMsgId;
  if (!clientMsgId) return false;
  const store = useMessageStatusStore();
  const record = store.get(clientMsgId);
  if (!record) return false;

  if (data.success === false) {
    clearTimer(clientMsgId);
    store.markFailed(clientMsgId, data.error?.message || '发送失败');
    return true;
  }

  if (data.message && data.messageId) {
    clearTimer(clientMsgId);
    store.markSent(clientMsgId, data.messageId);
    // 送达后再清草稿，和旧行为一致
    try {
      const draftStore = useDraftStore();
      draftStore?.clearDraft?.(record.scope === 'private' ? 'private' : 'group', record.targetId);
    } catch {}
    // 真实消息随后由调用方按 messageId 插入列表，视图侧 pruneRendered 完成交接；
    // 这里的定时器只是兜底清理「消息始终没渲染出来」的记录，避免常驻
    setTimeout(() => {
      const current = store.get(clientMsgId);
      if (current && current.status === 'sent') store.remove(clientMsgId);
    }, ACK_KEEP);
    return true;
  }

  return false;
}

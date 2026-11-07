import { defineStore } from 'pinia';
import { ref } from 'vue';

/**
 * 发送状态机：clientMsgId -> sending / failed / sent
 *
 * 状态独立于消息列表存放，列表刷新、重新拉取历史都不会重置它，
 * 因此「发送中」动画不会在重载后闪断。确认送达后由 websocket 事件移出。
 */
export const useMessageStatusStore = defineStore('messageStatus', () => {
  // clientMsgId -> record
  const records = ref({});

  function begin({ clientMsgId, scope, targetId, payload, content, messageType }) {
    records.value[clientMsgId] = {
      clientMsgId,
      scope,
      targetId: targetId === null || targetId === undefined ? null : String(targetId),
      payload,
      content,
      messageType: messageType || 0,
      status: 'sending',
      messageId: null,
      error: null,
      attempts: (records.value[clientMsgId]?.attempts || 0) + 1,
      createdAt: records.value[clientMsgId]?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    return records.value[clientMsgId];
  }

  function markSending(clientMsgId) {
    const record = records.value[clientMsgId];
    if (!record) return null;
    record.status = 'sending';
    record.error = null;
    record.updatedAt = Date.now();
    record.attempts += 1;
    return record;
  }

  function markSent(clientMsgId, messageId) {
    const record = records.value[clientMsgId];
    if (!record) return null;
    record.status = 'sent';
    record.messageId = messageId ?? null;
    record.error = null;
    record.updatedAt = Date.now();
    return record;
  }

  function markFailed(clientMsgId, error) {
    const record = records.value[clientMsgId];
    if (!record) return null;
    record.status = 'failed';
    record.error = error || '发送失败';
    record.updatedAt = Date.now();
    return record;
  }

  function remove(clientMsgId) {
    delete records.value[clientMsgId];
  }

  function get(clientMsgId) {
    return records.value[clientMsgId] || null;
  }

  /** 某会话下仍在发送中/失败待重试的消息，按发送时间升序 */
  function listPending(scope, targetId) {
    const target = targetId === null || targetId === undefined ? null : String(targetId);
    return Object.values(records.value)
      .filter((record) => record.scope === scope && record.targetId === target)
      .filter((record) => record.status !== 'sent')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 已确认送达但真实消息还没进列表时，用它补位（重载后不会丢动画） */
  function listSending(scope, targetId) {
    return listPending(scope, targetId).filter((record) => record.status === 'sending');
  }

  /**
   * 渲染用列表：以 messageId 为准判断「真实消息是否已经进列表」。
   *
   * 已送达（sent）但真实消息还没渲染出来的记录继续留在列表里——否则会出现
   * 「气泡先撤、消息后到」的一帧空白；列表刷新/加载中（baseStore.loading 时
   * 新消息先进缓存不进 groupMessages）尤其明显。
   */
  function listVisible(scope, targetId, renderedIds) {
    const rendered = new Set((renderedIds || []).map((id) => String(id)));
    const target = targetId === null || targetId === undefined ? null : String(targetId);
    return Object.values(records.value)
      .filter((record) => record.scope === scope && record.targetId === target)
      .filter((record) => {
        if (record.status !== 'sent') return true;
        if (record.messageId === null || record.messageId === undefined) return true;
        return !rendered.has(String(record.messageId));
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 真实消息已经渲染出来，撤掉对应的已送达记录（交接完成） */
  function pruneRendered(scope, targetId, renderedIds) {
    const rendered = new Set((renderedIds || []).map((id) => String(id)));
    const target = targetId === null || targetId === undefined ? null : String(targetId);
    Object.values(records.value).forEach((record) => {
      if (record.scope !== scope || record.targetId !== target) return;
      if (record.status !== 'sent') return;
      if (record.messageId === null || record.messageId === undefined) return;
      if (rendered.has(String(record.messageId))) remove(record.clientMsgId);
    });
  }

  function clearScope(scope, targetId) {
    const target = targetId === null || targetId === undefined ? null : String(targetId);
    Object.values(records.value)
      .filter((record) => record.scope === scope && record.targetId === target)
      .forEach((record) => remove(record.clientMsgId));
  }

  return {
    records,
    begin,
    markSending,
    markSent,
    markFailed,
    remove,
    get,
    listPending,
    listSending,
    listVisible,
    pruneRendered,
    clearScope
  };
});

export default useMessageStatusStore;

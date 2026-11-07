import { defineStore } from 'pinia';
import { ref } from 'vue';

/** 客户端 5s 未见新事件即视为停止（服务端 TTL 到期不会推 false） */
const TYPING_TTL = 5000;

const _timers = {};

function keyOf(scope, targetId) {
  return `${scope}:${targetId === null || targetId === undefined ? '' : targetId}`;
}

/**
 * 正在输入状态：按会话分桶，纯本地超时收敛，不依赖服务端推 typing:false
 */
export const useTypingStore = defineStore('typing', () => {
  // key -> { [userId]: { nickname, at } }
  const buckets = ref({});

  function bucketKey(scope, targetId) {
    return keyOf(scope, targetId);
  }

  function scheduleExpiry(key, userId) {
    const timerKey = `${key}|${userId}`;
    if (_timers[timerKey]) clearTimeout(_timers[timerKey]);
    _timers[timerKey] = setTimeout(() => {
      delete _timers[timerKey];
      const bucket = buckets.value[key];
      if (!bucket) return;
      delete bucket[userId];
      if (Object.keys(bucket).length === 0) delete buckets.value[key];
    }, TYPING_TTL);
  }

  function apply({ scope, targetId, userId, nickname, typing, at }) {
    const key = keyOf(scope, targetId);
    const uid = String(userId);
    if (typing === false) {
      const bucket = buckets.value[key];
      if (bucket && bucket[uid]) {
        delete bucket[uid];
        if (Object.keys(bucket).length === 0) delete buckets.value[key];
      }
      const timerKey = `${key}|${uid}`;
      if (_timers[timerKey]) {
        clearTimeout(_timers[timerKey]);
        delete _timers[timerKey];
      }
      return;
    }
    if (!buckets.value[key]) buckets.value[key] = {};
    buckets.value[key][uid] = { nickname: nickname || '有人', at: at || Date.now() };
    scheduleExpiry(key, uid);
  }

  function list(scope, targetId, selfId) {
    const bucket = buckets.value[keyOf(scope, targetId)];
    if (!bucket) return [];
    return Object.entries(bucket)
      .filter(([uid]) => String(uid) !== String(selfId ?? ''))
      .map(([, value]) => value.nickname);
  }

  function clear(scope, targetId) {
    delete buckets.value[keyOf(scope, targetId)];
  }

  return { buckets, apply, list, clear, bucketKey };
});

export default useTypingStore;

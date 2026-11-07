// "正在输入" 的分片扇出通道。
//
// 为什么不用 broadcast Stream：
//   typing 是高频、可丢、且只关心「最新状态」的事件。走 Streams 会让每条事件都占用一个
//   持久化位点、还要参与断点续读，成本与收益不匹配。这里用 Redis pub/sub 按
//   scr:typing:group:<id> / scr:typing:user:<id> 分片发布，各进程只做「本地房间投递」，
//   不做 io.to 广播。
//
// 限流（契约）：同一「房间 + 用户」每 2s 最多推 1 条，窗口内的后续事件合并为「该用户的最后一条」，
//   在窗口末尾补发。合并键必须是 (房间, 用户)：只按房间合并会让同群 A 的 typing 覆盖 B 的 typing。
//   因此不会丢最终状态（尤其是 typing:false 一定会在 ≤2s 的延迟内送达）。
import { createClient } from 'redis';
import { getRedisUrl } from '../../config/index.js';

const CHANNEL_PREFIX = 'scr:typing:';
const COALESCE_MS = 2000;
const MAX_PAYLOAD_BYTES = 200;
const NICKNAME_MAX = 20;

function truncate(text, max) {
  const str = String(text || '');
  // 按字符截断会影响 UTF-8 字节数，这里同时做字节兜底，保证单条 payload ≤ 200B
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

export function createTypingHub({ io, redisClient }) {
  const sub = createClient({ url: getRedisUrl() });
  sub.on('error', (err) => console.error('❌ typing 订阅 Redis 错误:', err.message));

  const roomState = new Map();

  function emitToLocalRoom(room, payload, excludeSocketId) {
    let sockets;
    try {
      sockets = io.sockets.adapter.rooms.get(room);
    } catch (err) {
      return;
    }
    if (!sockets || sockets.size === 0) return;

    for (const sid of sockets) {
      if (excludeSocketId && String(sid) === String(excludeSocketId)) continue;
      const s = io.sockets.sockets.get(sid);
      if (!s || !s.connected) continue;
      try {
        s.emit('typing-update', payload);
      } catch (err) {
        // ignore
      }
    }
  }

  // 同「房间 + 用户」2s 合并：窗口内只保留该用户最后一条，窗口末尾补发
  function scheduleDelivery(room, payload, excludeSocketId) {
    const key = `${room}|${payload.userId}`;
    const state = roomState.get(key) || { lastAt: 0, pending: null, timer: null };
    const now = Date.now();
    const gap = now - state.lastAt;

    if (gap >= COALESCE_MS) {
      state.lastAt = now;
      state.pending = null;
      roomState.set(key, state);
      emitToLocalRoom(room, payload, excludeSocketId);
      return;
    }

    state.pending = { payload, excludeSocketId };
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        const pending = state.pending;
        state.pending = null;
        if (!pending) return;
        state.lastAt = Date.now();
        emitToLocalRoom(room, pending.payload, pending.excludeSocketId);
      }, COALESCE_MS - gap);
      if (state.timer.unref) state.timer.unref();
    }
    roomState.set(key, state);
  }

  async function start() {
    try {
      await sub.connect();
      // node-redis v5 的订阅回调直接作为 pSubscribe 的第二个参数传入：
      // 回调签名是 (message, channel, pattern)，不再走 'pmessage' 事件。
      const listener = (message, channel) => {
        let msg;
        try {
          msg = JSON.parse(message);
        } catch (err) {
          return;
        }
        if (!msg || !msg.payload) return;

        const suffix = String(channel).slice(CHANNEL_PREFIX.length);
        const room = suffix.startsWith('group:') ? `group_${suffix.slice(6)}` : `user_${suffix.slice(5)}`;
        scheduleDelivery(room, msg.payload, msg.senderSocketId);
      };

      // 分片订阅：group 与 user 两类通道
      await sub.pSubscribe([`${CHANNEL_PREFIX}group:*`, `${CHANNEL_PREFIX}user:*`], listener);
      console.log('✅ typing 分片订阅已启动 (scr:typing:group:* / scr:typing:user:*)');
    } catch (err) {
      console.error('❌ typing 订阅启动失败:', err.message);
    }
  }

  // scope 决定分片通道；groupId/toUserId 由调用方保证已校验
  async function publish({ scope, groupId, toUserId, userId, nickname, typing, senderSocketId }) {
    const at = Date.now();
    const payload = {
      scope,
      userId: Number(userId),
      nickname: truncate(nickname, NICKNAME_MAX),
      typing: Boolean(typing),
      at
    };
    if (scope === 'group') payload.groupId = Number(groupId);
    if (scope === 'private') payload.toUserId = Number(toUserId);

    let serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      payload.nickname = '';
      serialized = JSON.stringify(payload);
    }

    const channel = scope === 'group'
      ? `${CHANNEL_PREFIX}group:${groupId}`
      : `${CHANNEL_PREFIX}user:${toUserId}`;

    try {
      await redisClient.publish(channel, JSON.stringify({ payload, senderSocketId: senderSocketId || null }));
    } catch (err) {
      console.error('typing 发布失败:', err.message);
    }
    return serialized;
  }

  async function stop() {
    for (const state of roomState.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    roomState.clear();
    try {
      await sub.quit();
    } catch (err) {
      // ignore
    }
  }

  return { start, stop, publish };
}

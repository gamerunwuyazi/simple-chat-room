// typing-start / typing-stop 处理：校验 → Redis 去重 → 分片发布
//
// 开关口径：
//   用户级 scr_users.show_typing = 0  → 该用户不发送 typing（直接忽略其事件）
//   群级   scr_groups.show_typing = 0 → 该群不广播 typing
//   私聊只受用户级开关影响
//
// 去重口径：键为 (scope, 目标, userId)，存在 Redis 里而不是进程内存，
//   这样同一用户多端/多实例同时发 typing 只会在 1.2s 内发布一条。
import { redisClient } from '../../models/database.js';
import {
  getUserTypingProfile,
  getGroupTypingSettings,
  isGroupMemberCached
} from '../../utils/typing/typingCache.js';

const STATE_TTL_SECONDS = 5;
const PUBLISH_THROTTLE_MS = 1200;

export function registerTypingHandlers(socket, io, { typingHub }) {
  const stateKeyFor = (scope, key, userId) => `scr:typing:${scope}:${key}:${userId}`;
  const throttleKeyFor = (scope, key, userId) => `scr:typing:throttle:${scope}:${key}:${userId}`;

  // 抢发布令牌：NX+PX 保证同一 (会话, 用户) 在窗口内只有一条 typing:true 进入扇出。
  // Redis 异常时放行，宁可多推一条也不能让用户看不到输入状态。
  async function acquirePublishSlot(scope, targetKey, userId) {
    try {
      const result = await redisClient.set(
        throttleKeyFor(scope, targetKey, userId),
        '1',
        { NX: true, PX: PUBLISH_THROTTLE_MS }
      );
      return result === 'OK';
    } catch (err) {
      return true;
    }
  }

  async function releasePublishSlot(scope, targetKey, userId) {
    try {
      await redisClient.del(throttleKeyFor(scope, targetKey, userId));
    } catch (err) {
      // ignore
    }
  }

  async function handle(payload, typing) {
    try {
      const data = payload || {};
      const userId = parseInt(data.userId, 10);
      const scope = data.scope === 'private' ? 'private' : 'group';

      if (isNaN(userId)) return;

      const profile = await getUserTypingProfile(userId);
      if (!profile || !profile.showTyping) return;

      let targetKey;
      let channelTarget;

      if (scope === 'group') {
        const groupId = parseInt(data.groupId, 10);
        if (isNaN(groupId)) return;

        if (!(await isGroupMemberCached(groupId, userId))) return;
        const settings = await getGroupTypingSettings(groupId);
        if (!settings || !settings.showTyping) return;

        targetKey = String(groupId);
        channelTarget = { scope: 'group', groupId };
      } else {
        const toUserId = parseInt(data.toUserId, 10);
        if (isNaN(toUserId) || toUserId === userId) return;
        targetKey = String(toUserId);
        channelTarget = { scope: 'private', toUserId };
      }

      // 状态 key 只用于「该用户在该会话是否仍在输入」，5s 无新事件自动过期；
      // 客户端另有 5s 本地超时兜底，服务端不额外推 typing:false。
      const stateKey = stateKeyFor(scope, targetKey, userId);
      try {
        await redisClient.set(
          stateKey,
          JSON.stringify({ typing, at: Date.now() }),
          { EX: STATE_TTL_SECONDS }
        );
      } catch (err) {
        // Redis 异常不阻断用户可见的 typing 广播
      }

      if (!typing) {
        // typing:false 总是要尽快发出：清掉节流键，避免停止状态被窗口吞掉
        await releasePublishSlot(scope, targetKey, userId);
      } else if (!(await acquirePublishSlot(scope, targetKey, userId))) {
        return;
      }

      await typingHub.publish({
        ...channelTarget,
        userId,
        nickname: profile.nickname,
        typing,
        senderSocketId: socket.id
      });
    } catch (err) {
      console.error('处理 typing 事件失败:', err.message);
    }
  }

  socket.on('typing-start', (data) => handle(data, true));
  socket.on('typing-stop', (data) => handle(data, false));
}

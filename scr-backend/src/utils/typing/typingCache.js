// typing 相关热点数据的 Redis 缓存键与读取封装。
//
// typing 是高频事件（验收口径 50 事件/秒/群），任何一次 DB 查询都会成为瓶颈，
// 因此把「用户是否允许发送 typing」「群是否开启 typing」「是否群成员」三件事放进 Redis，
// 设置被修改时主动失效（见 groupFeatureService）。
import { pool, redisClient } from '../../models/database.js';

const PROFILE_KEY = (userId) => `scr:typing:profile:${userId}`;
const GROUP_SETTINGS_KEY = (groupId) => `scr:typing:group-settings:${groupId}`;
const MEMBER_KEY = (groupId, userId) => `scr:typing:member:${groupId}:${userId}`;

const PROFILE_TTL = 60;
const GROUP_SETTINGS_TTL = 60;
const MEMBER_TTL = 60;

export { PROFILE_KEY, GROUP_SETTINGS_KEY, MEMBER_KEY };

// 返回 { showTyping, nickname }；用户不存在返回 null
export async function getUserTypingProfile(userId) {
  const key = PROFILE_KEY(userId);
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      return parsed && parsed.exists ? parsed : null;
    }
  } catch (err) {
    // Redis 不可用时退化为直接查库，不影响功能
    console.warn('读取 typing 用户缓存失败:', err.message);
  }

  const [rows] = await pool.execute(
    'SELECT id, nickname, show_typing FROM scr_users WHERE id = ?',
    [userId]
  );
  if (rows.length === 0) {
    return null;
  }
  const profile = {
    exists: true,
    userId: rows[0].id,
    nickname: rows[0].nickname || '',
    showTyping: rows[0].show_typing === 1
  };
  try {
    await redisClient.set(key, JSON.stringify(profile), { EX: PROFILE_TTL });
  } catch (err) {
    // ignore
  }
  return profile;
}

// 返回 { allowChain, allowVote, showTyping }；群不存在返回 null
export async function getGroupTypingSettings(groupId) {
  const key = GROUP_SETTINGS_KEY(groupId);
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.exists) return parsed;
      if (parsed && parsed.exists === false) return null;
    }
  } catch (err) {
    console.warn('读取 typing 群设置缓存失败:', err.message);
  }

  const [rows] = await pool.execute(
    'SELECT id, allow_chain, allow_vote, show_typing FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
    [groupId]
  );
  if (rows.length === 0) {
    try {
      await redisClient.set(key, JSON.stringify({ exists: false }), { EX: GROUP_SETTINGS_TTL });
    } catch (err) {
      // ignore
    }
    return null;
  }

  const settings = {
    exists: true,
    allowChain: rows[0].allow_chain === 1,
    allowVote: rows[0].allow_vote === 1,
    showTyping: rows[0].show_typing === 1
  };
  try {
    await redisClient.set(key, JSON.stringify(settings), { EX: GROUP_SETTINGS_TTL });
  } catch (err) {
    // ignore
  }
  return settings;
}

export async function isGroupMemberCached(groupId, userId) {
  const key = MEMBER_KEY(groupId, userId);
  try {
    const cached = await redisClient.get(key);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch (err) {
    // ignore
  }

  const [rows] = await pool.execute(
    'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
    [groupId, userId]
  );
  const isMember = rows.length > 0;
  try {
    await redisClient.set(key, isMember ? '1' : '0', { EX: MEMBER_TTL });
  } catch (err) {
    // ignore
  }
  return isMember;
}

// 设置变更后主动失效，避免 60s 内仍按旧开关判断
export async function invalidateUserTypingProfile(userId) {
  try {
    await redisClient.del(PROFILE_KEY(userId));
  } catch (err) {
    // ignore
  }
}

export async function invalidateGroupTypingSettings(groupId) {
  try {
    await redisClient.del(GROUP_SETTINGS_KEY(groupId));
  } catch (err) {
    // ignore
  }
}

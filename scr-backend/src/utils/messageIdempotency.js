// 重发幂等：同一个 clientMsgId 在同一用户下只允许落库一条。
//
// 背景：前端「发送中 → 超时 → 点击重发」会复用同一个 clientMsgId。若首包其实已经落库、
//   只是回执丢了，重发会再插一条，列表里出现两条一模一样的消息。
//
// 做法：
//   1. scr_messages.client_msg_id 上的唯一索引 (user_id, client_msg_id)
//      与 scr_private_messages 上的 (sender_id, client_msg_id) 兜底；
//   2. 命中重复键时，不回错误，而是**回首包那条消息**（同一 messageId、同一 message 对象、
//      同一 clientMsgId），让前端把「发送中」气泡正常收敛成「已送达」。
//
// 降级：存量库还没执行 DDL 时（client_msg_id 列不存在），幂等自动关闭——
//   消息照常发送，只是重发不再去重，并打一次告警提示执行存量 DDL。
//   这样上线顺序不受 DDL 执行时间影响。
import { pool as defaultPool } from '../models/database.js';

const MAX_CLIENT_MSG_ID = 64;
const CAPABILITY_TTL_MS = 60000;

const capabilityCache = new Map(); // table -> { ready, checkedAt }
const warned = new Set();

// 统一规范化：非空字符串、截断到 64 字符（与前端 payload 上限一致）
export function normalizeClientMsgId(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, MAX_CLIENT_MSG_ID);
}

// 该表是否已具备 client_msg_id 列（带 60s 缓存，避免每条消息都查 information_schema）
export async function isIdempotencyReady(table, pool = defaultPool) {
  const cached = capabilityCache.get(table);
  const now = Date.now();
  if (cached && now - cached.checkedAt < CAPABILITY_TTL_MS) {
    return cached.ready;
  }

  let ready;
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'client_msg_id'`,
      [table]
    );
    ready = Number(rows?.[0]?.n || 0) > 0;
  } catch (err) {
    ready = false;
  }

  capabilityCache.set(table, { ready, checkedAt: now });
  if (!ready && !warned.has(table)) {
    warned.add(table);
    console.warn(
      `⚠️ ${table}.client_msg_id 列不存在：重发幂等已降级关闭（重发会产生重复消息）。` +
      '请执行交付报告「已有数据库调整语句」章节中的 ALTER 语句。'
    );
  }
  return ready;
}

// 查群聊/全局消息里已存在的首包
export async function findExistingGroupMessage(pool, userId, clientMsgId) {
  const [rows] = await pool.execute(
    `SELECT id, user_id, content, at_userid, message_type, group_id, timestamp
       FROM scr_messages
      WHERE user_id = ? AND client_msg_id = ?
      LIMIT 1`,
    [userId, clientMsgId]
  );
  return rows[0] || null;
}

// 查私聊里已存在的首包
export async function findExistingPrivateMessage(pool, senderId, clientMsgId) {
  const [rows] = await pool.execute(
    `SELECT id, sender_id, receiver_id, content, at_userid, message_type, is_read, timestamp
       FROM scr_private_messages
      WHERE sender_id = ? AND client_msg_id = ?
      LIMIT 1`,
    [senderId, clientMsgId]
  );
  return rows[0] || null;
}

// 重发时的群聊消息对象：字段与首包 ack 的 message 结构保持一致
export function buildReplayGroupMessage(row, user, groupNickname) {
  const raw = {
    id: row.id,
    userId: row.user_id,
    nickname: user?.nickname || '',
    avatarUrl: user?.avatar_url || null,
    content: row.content,
    atUserid: row.at_userid,
    messageType: row.message_type,
    groupId: row.group_id,
    timestamp: row.timestamp
  };
  if (groupNickname) raw.groupNickname = groupNickname;
  return raw;
}

// 重发时的私聊消息对象
export function buildReplayPrivateMessage(row, user) {
  return {
    id: row.id,
    userId: row.sender_id,
    nickname: user?.nickname || '',
    avatarUrl: user?.avatar_url || null,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    content: row.content,
    atUserid: row.at_userid,
    messageType: row.message_type,
    isRead: row.is_read,
    timestamp: row.timestamp
  };
}

// 唯一索引冲突（并发重发时也可能撞上）时按幂等处理
export function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 'ER_DUP_ENTRY');
}

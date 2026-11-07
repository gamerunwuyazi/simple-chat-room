// 群功能扩展：群接龙 / 群投票 / 群内搜索 / 群设置
//
// 权限口径（与接口契约一致）：
//   接龙、投票发起 = 群成员 且 对应开关开启（群主/管理员不受开关限制）
//   结束投票       = 仅投票发起人本人（群主/管理员不代关）；接龙不可撤销（close 一律 410）
//   群设置修改   = 群主/管理员
//   搜索         = 群成员
import { pool, redisClient } from '../models/database.js';
import { isGroupAdmin } from './groupService.js';
import { checkRateLimit } from '../middleware/auth.js';
import { validateMessageContent } from '../utils/validators.js';
import { filterMessageFields } from '../utils/messageFilters.js';
import {
  normalizeClientMsgId,
  isIdempotencyReady,
  findExistingGroupMessage,
  isDuplicateKeyError
} from '../utils/messageIdempotency.js';
import {
  getGroupTypingSettings,
  invalidateGroupTypingSettings,
  invalidateUserTypingProfile
} from '../utils/typing/typingCache.js';

let broadcastProducer = null;

export function setGroupFeatureDeps(producer) {
  broadcastProducer = producer;
}

const MAX_TITLE = 100;
const MAX_CONTENT = 1000;
const MAX_OPTIONS = 20;
const SEARCH_SCAN_LIMIT = 3000;

// 接龙/投票特殊消息类型（群消息 type 体系：0 文本 / 1 图片 / 2 文件 / 3 群名片 /
// 4 引用 / 5 文本类 / 6 视频 / 7 音频 / 101 撤回 / 103 私聊已读回执 之后新增）
export const MSG_TYPE_CHAIN = 8;       // 接龙头消息
export const MSG_TYPE_CHAIN_ENTRY = 9; // 参与接龙消息
export const MSG_TYPE_VOTE = 10;       // 投票消息

// 接龙/投票消息只能走 REST 专用接口创建（消息壳与 scr_group_chains / scr_group_votes
// 数据源在同一个事务里落库），socket send-message 路径直接拒绝这三个类型。
const FEATURE_MESSAGE_TYPES = [MSG_TYPE_CHAIN, MSG_TYPE_CHAIN_ENTRY, MSG_TYPE_VOTE];
export function isFeatureMessageType(type) {
  return FEATURE_MESSAGE_TYPES.includes(Number(type));
}

// 公共聊天室 scope：groupId 缺省 / 0 / 无法解析 = 公共（scr_group_chains / scr_group_votes
// 的 group_id 为 NULL，scr_messages.group_id 同为 NULL）。权限 = 登录即可（公共聊天无
// allow_chain / allow_vote 开关）。广播房间与公共消息一致：authenticated_users。
const PUBLIC_ROOM = 'authenticated_users';
const PUBLIC_WATERMARK_KEY = 'scr:max_msg_id:global';

function isPublicScope(groupId) {
  return groupId === undefined || groupId === null || groupId === 0 || isNaN(groupId);
}

// ---------------------------------------------------------------- 特殊消息壳辅助

async function getUserBrief(userId) {
  const [users] = await pool.execute(
    'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
    [userId]
  );
  return users[0] || null;
}

async function getGroupNickname(groupId, userId) {
  try {
    const [rows] = await pool.execute(
      'SELECT group_nickname FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, userId]
    );
    return (rows.length > 0 && rows[0].group_nickname) || null;
  } catch (err) {
    return null;
  }
}

// 构建与 socket 群消息同构的消息对象（字段过滤口径一致），再挂接龙/投票数据
async function buildFeatureBroadcastMessage({ messageId, userId, groupId, content, messageType }) {
  const user = await getUserBrief(userId);
  const groupNickname = groupId ? await getGroupNickname(groupId, userId) : null;
  const now = new Date();
  const raw = {
    id: messageId,
    userId,
    nickname: user ? user.nickname : '',
    avatarUrl: user ? user.avatar_url : null,
    content,
    atUserid: null,
    messageType,
    groupId: groupId || null,
    timestamp: now,
    timestampISO: now.toISOString()
  };
  if (groupNickname) raw.groupNickname = groupNickname;
  return filterMessageFields(raw, groupId ? 'group' : 'public');
}

// 特殊消息发布：推进未读水位缓存 + 走 Redis Streams 扇出 message-received（不用 io.to/io.emit）
// 公共 scope 广播到 authenticated_users（与公共聊天消息同房间），水位写 scr:max_msg_id:global
async function broadcastFeatureMessage({ groupId, messageId, userId, content, messageType, attach }) {
  const message = await buildFeatureBroadcastMessage({ messageId, userId, groupId, content, messageType });
  if (attach) Object.assign(message, attach);
  const room = groupId ? `group_${groupId}` : PUBLIC_ROOM;
  const watermarkKey = groupId ? `scr:max_msg_id:group:${parseInt(groupId)}` : PUBLIC_WATERMARK_KEY;
  redisClient
    .set(watermarkKey, String(messageId))
    .catch(() => {});
  if (broadcastProducer) {
    await broadcastProducer.enqueue(room, 'message-received', message);
  }
  return message;
}

// 事务内插入消息壳（client_msg_id 幂等键，与普通群消息共用唯一索引）
async function insertFeatureMessage(conn, { userId, groupId, content, messageType, clientMsgId, idempotencyReady }) {
  if (clientMsgId && idempotencyReady) {
    const [result] = await conn.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, client_msg_id, timestamp) VALUES (?, ?, ?, ?, ?, NOW())',
      [userId, content, messageType, groupId, clientMsgId]
    );
    return result.insertId;
  }
  const [result] = await conn.execute(
    'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
    [userId, content, messageType, groupId]
  );
  return result.insertId;
}

// clientMsgId 命中首包（重发/回执丢失）：回首包那条消息与对应数据，绝不再插一条
async function respondFeatureDuplicate(res, existing, userId, clientMsgId) {
  const payload = {
    status: 'success',
    duplicate: true,
    clientMsgId: clientMsgId || null,
    message: {
      id: existing.id,
      messageType: existing.message_type,
      content: existing.content
    }
  };
  try {
    const parsed = JSON.parse(existing.content || '{}');
    if (
      (existing.message_type === MSG_TYPE_CHAIN || existing.message_type === MSG_TYPE_CHAIN_ENTRY)
      && parsed.chainId
    ) {
      const chain = await loadChain(parsed.chainId);
      if (chain) await attachEntries([chain]);
      payload.chain = chain;
      if (existing.message_type === MSG_TYPE_CHAIN_ENTRY) payload.joined = true;
    } else if (existing.message_type === MSG_TYPE_VOTE && parsed.voteId) {
      payload.vote = await loadVote(parsed.voteId, userId);
    }
  } catch (err) {
    // 内容损坏时只回消息壳
  }
  return res.json(payload);
}

// 接龙/投票走消息发送路径，与普通群消息共用同一套限流（10 次/10s + 40 次/60s）
async function consumeFeatureRateLimit(res, userId) {
  const rate = await checkRateLimit(userId);
  if (!rate.allowed) {
    res.status(429).json({
      status: 'error',
      code: 'RATE_LIMIT_EXCEEDED',
      message: `发送过于频繁，请${rate.retryAfter}秒后再试`,
      retryAfter: rate.retryAfter
    });
    return false;
  }
  return true;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

async function isGroupMember(groupId, userId) {
  const [rows] = await pool.execute(
    'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
    [groupId, userId]
  );
  return rows.length > 0;
}

async function groupExists(groupId) {
  const [rows] = await pool.execute(
    'SELECT id FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
    [groupId]
  );
  return rows.length > 0;
}

function badRequest(res, message) {
  return res.status(400).json({ status: 'error', message });
}

// ---------------------------------------------------------------- 群接龙

async function loadChain(chainId) {
  const [chains] = await pool.execute(
    `SELECT c.id, c.group_id, c.creator_id, c.title, c.content, c.created_at, c.closed_at,
            u.nickname AS creator_nickname
       FROM scr_group_chains c
       LEFT JOIN scr_users u ON u.id = c.creator_id
      WHERE c.id = ?`,
    [chainId]
  );
  if (chains.length === 0) return null;
  return shapeChain(chains[0]);
}

async function attachEntries(chains) {
  if (chains.length === 0) return chains;
  const ids = chains.map((c) => c.id);
  const [entries] = await pool.execute(
    `SELECT e.id, e.chain_id, e.user_id, e.content, e.created_at,
            u.nickname, u.avatar_url
       FROM scr_group_chain_entries e
       LEFT JOIN scr_users u ON u.id = e.user_id
      WHERE e.chain_id IN (${ids.map(() => '?').join(',')})
      ORDER BY e.id ASC`,
    ids
  );

  const grouped = new Map();
  for (const row of entries) {
    const list = grouped.get(row.chain_id) || [];
    list.push({
      id: row.id,
      userId: row.user_id,
      nickname: row.nickname || '',
      avatarUrl: row.avatar_url || null,
      content: row.content || '',
      // 参与顺序序号（e.id ASC 即参与顺序），与 type=9 消息 payload 里的 entries 快照同构
      seq: list.length + 1,
      createdAt: toIso(row.created_at)
    });
    grouped.set(row.chain_id, list);
  }

  for (const chain of chains) {
    const list = grouped.get(chain.id) || [];
    chain.entries = list;
    chain.entryCount = list.length;
  }
  return chains;
}

function shapeChain(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    creatorId: row.creator_id,
    creatorNickname: row.creator_nickname || '',
    title: row.title,
    content: row.content || '',
    createdAt: toIso(row.created_at),
    closedAt: toIso(row.closed_at),
    isClosed: Boolean(row.closed_at),
    entries: [],
    entryCount: 0
  };
}

export async function getGroupChains(req, res) {
  try {
    const userId = parseInt(req.userId, 10);
    // 公共 scope 接龙列表（GET /api/chains）已随「主聊天室只保留投票」下线，
    // 本函数仅服务群 scope（/api/groups/:groupId/chains）。
    const groupId = parseInt(req.params.groupId, 10);
    if (isNaN(groupId)) return badRequest(res, '参数错误');
    if (!(await isGroupMember(groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [chains] = await pool.execute(
      `SELECT c.id, c.group_id, c.creator_id, c.title, c.content, c.created_at, c.closed_at,
              u.nickname AS creator_nickname
         FROM scr_group_chains c
         LEFT JOIN scr_users u ON u.id = c.creator_id
        WHERE c.group_id = ?
        ORDER BY c.id DESC
        LIMIT ?`,
      [groupId, limit]
    );

    const shaped = await attachEntries(chains.map(shapeChain));
    for (const chain of shaped) {
      chain.joined = chain.entries.some((e) => e.userId === userId);
    }

    res.json({ status: 'success', chains: shaped });
  } catch (err) {
    console.error('获取群接龙失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群接龙失败' });
  }
}

export async function createGroupChain(req, res) {
  try {
    // 公共 scope 接龙创建（POST /api/chains）已下线，本函数仅服务群 scope（路由保证有 groupId）
    const groupId = parseInt(req.params.groupId, 10);
    const userId = parseInt(req.userId, 10);
    const { title, content } = req.body || {};

    if (isNaN(groupId)) return badRequest(res, '参数错误');
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return badRequest(res, '接龙标题不能为空');
    }
    if (title.trim().length > MAX_TITLE) return badRequest(res, '接龙标题过长');
    if (content && String(content).length > MAX_CONTENT) return badRequest(res, '接龙内容过长');

    if (groupId !== null) {
      if (!(await groupExists(groupId))) {
        return res.status(404).json({ status: 'error', message: '群组不存在' });
      }
      if (!(await isGroupMember(groupId, userId))) {
        return res.status(403).json({ status: 'error', message: '你不是该群成员' });
      }

      const settings = await getGroupTypingSettings(groupId);
      const admin = await isGroupAdmin(groupId, userId);
      if (!admin && settings && settings.allowChain === false) {
        return res.status(403).json({ status: 'error', message: '该群已关闭接龙功能' });
      }
    }

    // 消息发送路径的限流（与普通群消息同一套配额）
    if (!(await consumeFeatureRateLimit(res, userId))) return;
    // 消息壳内容校验（与普通群消息同一口径：非空字符串且 ≤10000 字符）
    const chainPayload = { chainId: null, title: title.trim(), content: content || '' };
    if (!validateMessageContent(JSON.stringify(chainPayload))) {
      return badRequest(res, '接龙消息内容格式错误或超过 10000 字符限制');
    }

    // clientMsgId 幂等：重发回首包，不再新建接龙
    const clientMsgId = normalizeClientMsgId(req.body?.clientMsgId);
    const idempotencyReady = clientMsgId ? await isIdempotencyReady('scr_messages', pool) : false;
    if (clientMsgId && idempotencyReady) {
      const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
      if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
    }

    // 接龙表头与消息壳同一事务落库：消息撞幂等键时整体回滚，不产生孤儿接龙
    const conn = await pool.getConnection();
    let chainId;
    let messageId;
    try {
      await conn.beginTransaction();
      const [chainResult] = await conn.execute(
        'INSERT INTO scr_group_chains (group_id, creator_id, title, content) VALUES (?, ?, ?, ?)',
        [groupId, userId, title.trim(), content || '']
      );
      chainId = chainResult.insertId;
      chainPayload.chainId = chainId;

      messageId = await insertFeatureMessage(conn, {
        userId,
        groupId,
        content: JSON.stringify(chainPayload),
        messageType: MSG_TYPE_CHAIN,
        clientMsgId,
        idempotencyReady
      });
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      if (clientMsgId && idempotencyReady && isDuplicateKeyError(txErr)) {
        const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
        if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
      }
      throw txErr;
    } finally {
      conn.release();
    }

    const chain = await loadChain(chainId);
    chain.entries = [];
    chain.entryCount = 0;

    // 消息壳随 message-received 实时扇出（chain 数据挂在消息对象上），并保留
    // group-chain-created 供旧客户端兼容
    const message = await broadcastFeatureMessage({
      groupId,
      messageId,
      userId,
      content: JSON.stringify(chainPayload),
      messageType: MSG_TYPE_CHAIN,
      attach: { chain }
    });

    if (broadcastProducer) {
      broadcastProducer.enqueue(groupId ? `group_${groupId}` : PUBLIC_ROOM, 'group-chain-created', { chain });
    }

    res.json({ status: 'success', chain, message, duplicate: false });
  } catch (err) {
    console.error('发起群接龙失败:', err.message);
    res.status(500).json({ status: 'error', message: '发起群接龙失败' });
  }
}

export async function joinGroupChain(req, res) {
  try {
    const chainId = parseInt(req.params.id, 10);
    const userId = parseInt(req.userId, 10);
    const { content } = req.body || {};

    if (isNaN(chainId)) return badRequest(res, '参数错误');
    if (content && String(content).length > MAX_CONTENT) return badRequest(res, '接龙内容过长');

    const [chains] = await pool.execute(
      'SELECT id, group_id, creator_id, title, closed_at FROM scr_group_chains WHERE id = ?',
      [chainId]
    );
    if (chains.length === 0) {
      return res.status(404).json({ status: 'error', message: '接龙不存在' });
    }
    const chain = chains[0];

    // 公共聊天室接龙（group_id NULL）：登录即可参与，无群成员校验
    if (chain.group_id !== null && !(await isGroupMember(chain.group_id, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }
    if (chain.closed_at) {
      return res.status(409).json({ status: 'error', message: '该接龙已结束' });
    }

    // 消息发送路径的限流与内容校验
    if (!(await consumeFeatureRateLimit(res, userId))) return;
    const entryPayload = { chainId, entryId: null, title: chain.title, content: content || '' };
    if (!validateMessageContent(JSON.stringify(entryPayload))) {
      return badRequest(res, '接龙消息内容格式错误或超过 10000 字符限制');
    }

    const clientMsgId = normalizeClientMsgId(req.body?.clientMsgId);
    const idempotencyReady = clientMsgId ? await isIdempotencyReady('scr_messages', pool) : false;
    if (clientMsgId && idempotencyReady) {
      const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
      if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
    }

    // 一人一条：参与条目唯一约束的快速预检（带新 clientMsgId 的重复参与也稳定 409）
    const [existingEntries] = await pool.execute(
      'SELECT id FROM scr_group_chain_entries WHERE chain_id = ? AND user_id = ? LIMIT 1',
      [chainId, userId]
    );
    if (existingEntries.length > 0) {
      return res.status(409).json({ status: 'error', message: '你已经接过龙了' });
    }

    // 参与条目与消息壳同一事务：条目撞唯一约束（一人一条）或消息撞幂等键都整体回滚
    const conn = await pool.getConnection();
    let entryId;
    let messageId;
    try {
      await conn.beginTransaction();
      const [entryResult] = await conn.execute(
        'INSERT INTO scr_group_chain_entries (chain_id, user_id, content) VALUES (?, ?, ?)',
        [chainId, userId, content || '']
      );
      entryId = entryResult.insertId;
      entryPayload.entryId = entryId;

      // 微信式累加序号快照：本事务内刚插入的条目已可见，按 e.id ASC（参与顺序）编 seq，
      // 快照写入 type=9 消息 payload 仅作渲染兜底（前端优先用广播/REST 的 chain.entries）
      const [snapshotRows] = await conn.execute(
        `SELECT e.user_id, e.content, u.nickname
           FROM scr_group_chain_entries e
           LEFT JOIN scr_users u ON u.id = e.user_id
          WHERE e.chain_id = ?
          ORDER BY e.id ASC`,
        [chainId]
      );
      entryPayload.entries = snapshotRows.map((row, index) => ({
        seq: index + 1,
        userId: row.user_id,
        nickname: row.nickname || '',
        content: row.content || ''
      }));

      messageId = await insertFeatureMessage(conn, {
        userId,
        groupId: chain.group_id,
        content: JSON.stringify(entryPayload),
        messageType: MSG_TYPE_CHAIN_ENTRY,
        clientMsgId,
        idempotencyReady
      });
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      if (txErr && txErr.code === 'ER_DUP_ENTRY') {
        // 撞幂等键 → 回首包；撞参与条目唯一约束（并发双击）→ 409
        if (clientMsgId && idempotencyReady) {
          const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
          if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
        }
        return res.status(409).json({ status: 'error', message: '你已经接过龙了' });
      }
      throw txErr;
    } finally {
      conn.release();
    }

    const updated = await loadChain(chainId);
    await attachEntries([updated]);
    updated.joined = true;

    // 消息壳实时扇出（带最新 chain 数据，客户端可据此更新「已参与」状态与按钮）
    const message = await broadcastFeatureMessage({
      groupId: chain.group_id,
      messageId,
      userId,
      content: JSON.stringify(entryPayload),
      messageType: MSG_TYPE_CHAIN_ENTRY,
      attach: { chain: updated }
    });

    if (broadcastProducer) {
      broadcastProducer.enqueue(
        chain.group_id ? `group_${chain.group_id}` : PUBLIC_ROOM,
        'group-chain-updated',
        { chain: updated }
      );
    }

    res.json({ status: 'success', chain: updated, message, joined: true, duplicate: false });
  } catch (err) {
    console.error('参与群接龙失败:', err.message);
    res.status(500).json({ status: 'error', message: '参与群接龙失败' });
  }
}

// 接龙发布后不可撤销：closeGroupChain 已移除，POST /api/chains/:id/close 一律 410（见 routes/groupFeature.js）。

// ---------------------------------------------------------------- 群投票

const VOTE_SELECT = `
  SELECT v.id, v.group_id, v.creator_id, v.title, v.description, v.multiple, v.anonymous,
         v.status, v.created_at, v.ends_at, u.nickname AS creator_nickname
    FROM scr_group_votes v
    LEFT JOIN scr_users u ON u.id = v.creator_id
`;

// ---------------------------------------------------------------- 匿名投票（Redis 计数）
// 匿名投票不把「用户→选项」映射落库（scr_group_vote_records 不写行），全部状态存 Redis：
//   scr:vote:anon:<voteId>:user:<userId>  string（JSON 数组 = 该用户当前选择的 optionIds）
//                                         TTL 7776000s（3 个月），防重复/改票/myOptionIds 都靠它
//   scr:vote:anon:<voteId>:counts         hash（field=optionId → 计数），TTL 同上（每次写票刷新）
//   scr:vote:anon:<voteId>:voters         set（投过票的 userId，SCARD = totalVoters），TTL 同上
// 计数不落库（最小可靠方案）：Redis 数据过期/丢失后匿名投票计数归零，不回填。
const ANON_VOTE_TTL_SECONDS = 7776000; // 3 个月

const anonUserChoiceKey = (voteId, userId) => `scr:vote:anon:${voteId}:user:${userId}`;
const anonCountsKey = (voteId) => `scr:vote:anon:${voteId}:counts`;
const anonVotersKey = (voteId) => `scr:vote:anon:${voteId}:voters`;

function shapeVote(row) {
  const endsAt = toIso(row.ends_at);
  const expired = endsAt ? new Date(endsAt).getTime() <= Date.now() : false;
  const status = expired && row.status === 'open' ? 'closed' : row.status;
  return {
    id: row.id,
    groupId: row.group_id,
    creatorId: row.creator_id,
    creatorNickname: row.creator_nickname || '',
    title: row.title,
    description: row.description || '',
    multiple: row.multiple === 1,
    anonymous: row.anonymous === 1,
    status,
    createdAt: toIso(row.created_at),
    endsAt,
    options: [],
    totalVoters: 0
  };
}

async function attachVoteDetails(votes, userId) {
  if (votes.length === 0) return votes;
  const ids = votes.map((v) => v.id);
  const placeholders = ids.map(() => '?').join(',');

  const [options] = await pool.execute(
    `SELECT id, vote_id, label, sort FROM scr_group_vote_options
      WHERE vote_id IN (${placeholders}) ORDER BY sort ASC, id ASC`,
    ids
  );

  // 非匿名投票仍从 records 表取计数与「我的选择」；voters 明细一律不随列表返回（结束后走分页接口）
  const [records] = await pool.execute(
    `SELECT r.vote_id, r.option_id, r.user_id
       FROM scr_group_vote_records r
      WHERE r.vote_id IN (${placeholders})`,
    ids
  );

  const optionMap = new Map();
  for (const opt of options) {
    const list = optionMap.get(opt.vote_id) || [];
    list.push({ id: opt.id, label: opt.label, sort: opt.sort, count: 0 });
    optionMap.set(opt.vote_id, list);
  }

  const voterSets = new Map();
  const myChoices = new Map();
  for (const record of records) {
    const target = (optionMap.get(record.vote_id) || []).find((o) => o.id === record.option_id);
    if (target) target.count += 1;
    if (!voterSets.has(record.vote_id)) voterSets.set(record.vote_id, new Set());
    voterSets.get(record.vote_id).add(record.user_id);
    if (record.user_id === userId) {
      if (!myChoices.has(record.vote_id)) myChoices.set(record.vote_id, []);
      myChoices.get(record.vote_id).push(record.option_id);
    }
  }

  for (const vote of votes) {
    let counts;
    let myOptionIds;
    if (vote.anonymous) {
      // 匿名：计数 / 我的选择 / 参与人数全部来自 Redis；任何人都拿不到 voters 明细
      let countsHash = {};
      let myRaw = null;
      let voterCount = 0;
      try {
        [countsHash, myRaw, voterCount] = await Promise.all([
          redisClient.hGetAll(anonCountsKey(vote.id)),
          redisClient.get(anonUserChoiceKey(vote.id, userId)),
          redisClient.sCard(anonVotersKey(vote.id))
        ]);
      } catch (err) {
        // Redis 不可用时计数退化为 0，不阻塞消息列表
      }
      counts = {};
      for (const [field, value] of Object.entries(countsHash || {})) {
        counts[Number(field)] = Number(value) || 0;
      }
      try {
        myOptionIds = myRaw ? JSON.parse(myRaw) : [];
      } catch (err) {
        myOptionIds = [];
      }
      vote.totalVoters = Number(voterCount) || 0;
    } else {
      const opts = optionMap.get(vote.id) || [];
      counts = {};
      for (const opt of opts) counts[opt.id] = opt.count;
      const voters = voterSets.get(vote.id) || new Set();
      vote.totalVoters = voters.size;
      myOptionIds = myChoices.get(vote.id) || [];
    }

    vote.myOptionIds = Array.isArray(myOptionIds) ? myOptionIds : [];
    // 计数可见性：结束后全员可见；结束前只有发起人与已投票者可见（未投不可见）
    const resultVisible =
      vote.status === 'closed' ||
      vote.creatorId === userId ||
      vote.myOptionIds.length > 0;
    vote.resultVisible = resultVisible;
    vote.options = (optionMap.get(vote.id) || []).map((o) => ({
      id: o.id,
      label: o.label,
      sort: o.sort,
      count: resultVisible ? (counts[o.id] || 0) : null,
      voters: []
    }));
  }
  return votes;
}

async function loadVote(voteId, userId) {
  const [rows] = await pool.execute(`${VOTE_SELECT} WHERE v.id = ?`, [voteId]);
  if (rows.length === 0) return null;
  const [vote] = await attachVoteDetails([shapeVote(rows[0])], userId);
  return vote;
}

export async function getGroupVotes(req, res) {
  try {
    const userId = parseInt(req.userId, 10);
    // 无 groupId 路径（GET /api/votes）= 公共聊天室投票列表（登录即可）
    if (req.params.groupId === undefined) {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const [rows] = await pool.execute(
        `${VOTE_SELECT} WHERE v.group_id IS NULL ORDER BY v.id DESC LIMIT ?`,
        [limit]
      );
      return res.json({ status: 'success', votes: await attachVoteDetails(rows.map(shapeVote), userId) });
    }

    const groupId = parseInt(req.params.groupId, 10);
    if (isNaN(groupId)) return badRequest(res, '参数错误');
    if (!(await isGroupMember(groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const [rows] = await pool.execute(
      `${VOTE_SELECT} WHERE v.group_id = ? ORDER BY v.id DESC LIMIT ?`,
      [groupId, limit]
    );

    res.json({ status: 'success', votes: await attachVoteDetails(rows.map(shapeVote), userId) });
  } catch (err) {
    console.error('获取群投票失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群投票失败' });
  }
}

export async function createGroupVote(req, res) {
  try {
    // groupId 缺省 / 0 = 公共聊天室（登录即可，无开关限制）
    const groupId = req.params.groupId === undefined ? null : parseInt(req.params.groupId, 10);
    const userId = parseInt(req.userId, 10);
    const {
      title,
      description,
      multiple,
      anonymous,
      options,
      optionLabels,
      endsAt
    } = req.body || {};

    if (req.params.groupId !== undefined && isNaN(groupId)) return badRequest(res, '参数错误');
    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return badRequest(res, '投票标题不能为空');
    }
    if (title.trim().length > MAX_TITLE) return badRequest(res, '投票标题过长');

    const labels = Array.isArray(options) ? options : (Array.isArray(optionLabels) ? optionLabels : []);
    const cleaned = labels
      .map((l) => (typeof l === 'string' ? l.trim() : ''))
      .filter((l) => l.length > 0);

    if (cleaned.length < 2) return badRequest(res, '至少需要 2 个选项');
    if (cleaned.length > MAX_OPTIONS) return badRequest(res, `选项最多 ${MAX_OPTIONS} 个`);
    if (cleaned.some((l) => l.length > MAX_TITLE)) return badRequest(res, '选项文案过长');

    if (groupId !== null) {
      if (!(await groupExists(groupId))) {
        return res.status(404).json({ status: 'error', message: '群组不存在' });
      }
      if (!(await isGroupMember(groupId, userId))) {
        return res.status(403).json({ status: 'error', message: '你不是该群成员' });
      }

      const settings = await getGroupTypingSettings(groupId);
      const admin = await isGroupAdmin(groupId, userId);
      if (!admin && settings && settings.allowVote === false) {
        return res.status(403).json({ status: 'error', message: '该群已关闭投票功能' });
      }
    }

    let normalizedEndsAt = null;
    if (endsAt) {
      const parsed = new Date(endsAt);
      if (isNaN(parsed.getTime())) return badRequest(res, '截止时间格式错误');
      if (parsed.getTime() <= Date.now()) return badRequest(res, '截止时间必须晚于当前时间');
      normalizedEndsAt = parsed;
    }

    // 消息发送路径的限流与内容校验
    if (!(await consumeFeatureRateLimit(res, userId))) return;
    // 消息壳内容校验（payload 中 voteId/options.id 为自增整数，长度与真实值几乎一致，事务前先验）
    const votePayloadProbe = {
      voteId: 0,
      title: title.trim(),
      description: description || '',
      multiple: Boolean(multiple),
      anonymous: Boolean(anonymous),
      endsAt: null,
      options: cleaned
    };
    if (!validateMessageContent(JSON.stringify(votePayloadProbe))) {
      return badRequest(res, '投票消息内容格式错误或超过 10000 字符限制');
    }

    // clientMsgId 幂等：重发回首包，不再新建投票
    const clientMsgId = normalizeClientMsgId(req.body?.clientMsgId);
    const idempotencyReady = clientMsgId ? await isIdempotencyReady('scr_messages', pool) : false;
    if (clientMsgId && idempotencyReady) {
      const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
      if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
    }

    const conn = await pool.getConnection();
    let voteId;
    let messageId;
    let optionRefs = [];
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO scr_group_votes
           (group_id, creator_id, title, description, multiple, anonymous, status, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        [
          groupId,
          userId,
          title.trim(),
          description || '',
          multiple ? 1 : 0,
          anonymous ? 1 : 0,
          normalizedEndsAt
        ]
      );
      voteId = result.insertId;

      const values = cleaned.map((label, index) => [voteId, label, index]);
      const [optionResult] = await conn.query(
        'INSERT INTO scr_group_vote_options (vote_id, label, sort) VALUES ?',
        [values]
      );
      // 同一批多行 INSERT 自增 id 连续，可据此得到每个选项的真实 id（供消息 payload 内嵌）
      const firstOptionId = optionResult.insertId;
      optionRefs = cleaned.map((label, index) => ({ id: firstOptionId + index, label }));

      const votePayload = {
        voteId,
        title: title.trim(),
        description: description || '',
        multiple: Boolean(multiple),
        anonymous: Boolean(anonymous),
        endsAt: normalizedEndsAt ? normalizedEndsAt.toISOString() : null,
        options: optionRefs
      };

      messageId = await insertFeatureMessage(conn, {
        userId,
        groupId,
        content: JSON.stringify(votePayload),
        messageType: MSG_TYPE_VOTE,
        clientMsgId,
        idempotencyReady
      });
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      if (clientMsgId && idempotencyReady && isDuplicateKeyError(txErr)) {
        const existing = await findExistingGroupMessage(pool, userId, clientMsgId);
        if (existing) return respondFeatureDuplicate(res, existing, userId, clientMsgId);
      }
      throw txErr;
    } finally {
      conn.release();
    }

    const vote = await loadVote(voteId, userId);

    // 消息壳实时扇出（vote 数据挂在消息对象上，含发布人 result），并保留
    // group-vote-created 供旧客户端兼容
    const message = await broadcastFeatureMessage({
      groupId,
      messageId,
      userId,
      content: JSON.stringify({
        voteId,
        title: title.trim(),
        description: description || '',
        multiple: Boolean(multiple),
        anonymous: Boolean(anonymous),
        endsAt: normalizedEndsAt ? normalizedEndsAt.toISOString() : null,
        options: optionRefs
      }),
      messageType: MSG_TYPE_VOTE,
      attach: { vote }
    });

    if (broadcastProducer) {
      broadcastProducer.enqueue(groupId ? `group_${groupId}` : PUBLIC_ROOM, 'group-vote-created', { vote });
    }

    res.json({ status: 'success', vote, message, duplicate: false });
  } catch (err) {
    console.error('发起群投票失败:', err.message);
    res.status(500).json({ status: 'error', message: '发起群投票失败' });
  }
}

export async function submitVoteBallot(req, res) {
  try {
    const voteId = parseInt(req.params.id, 10);
    const userId = parseInt(req.userId, 10);
    const { optionIds } = req.body || {};

    if (isNaN(voteId)) return badRequest(res, '参数错误');
    if (!Array.isArray(optionIds) || optionIds.length === 0) {
      return badRequest(res, '请至少选择一个选项');
    }

    const [votes] = await pool.execute(
      'SELECT id, group_id, creator_id, multiple, anonymous, status, ends_at FROM scr_group_votes WHERE id = ?',
      [voteId]
    );
    if (votes.length === 0) {
      return res.status(404).json({ status: 'error', message: '投票不存在' });
    }
    const vote = votes[0];

    // 公共聊天室投票（group_id NULL）：登录即可投票，无群成员校验
    if (vote.group_id !== null && !(await isGroupMember(vote.group_id, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }
    // 发布人不能投自己发起的投票（二次保险，前端按钮同样置灰）
    if (parseInt(vote.creator_id, 10) === userId) {
      return res.status(403).json({ status: 'error', message: '不能投票自己发起的投票' });
    }
    if (vote.status !== 'open') {
      return res.status(409).json({ status: 'error', message: '该投票已结束' });
    }
    if (vote.ends_at && new Date(vote.ends_at).getTime() <= Date.now()) {
      return res.status(409).json({ status: 'error', message: '该投票已结束' });
    }

    const uniqueIds = Array.from(new Set(optionIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))));
    if (uniqueIds.length === 0) return badRequest(res, '请至少选择一个选项');
    if (!vote.multiple && uniqueIds.length > 1) {
      return badRequest(res, '该投票为单选');
    }

    const [options] = await pool.execute(
      `SELECT id FROM scr_group_vote_options WHERE vote_id = ? AND id IN (${uniqueIds.map(() => '?').join(',')})`,
      [voteId, ...uniqueIds]
    );
    if (options.length !== uniqueIds.length) {
      return badRequest(res, '存在不属于该投票的选项');
    }

    if (vote.anonymous === 1) {
      // 匿名投票：不落 scr_group_vote_records，防重复/改票/计数全走 Redis
      const userKey = anonUserChoiceKey(voteId, userId);
      const existingRaw = await redisClient.get(userKey);
      let existingIds = [];
      try {
        existingIds = existingRaw ? JSON.parse(existingRaw) : [];
      } catch (err) {
        existingIds = [];
      }
      if (!Array.isArray(existingIds)) existingIds = [];
      const sortedExisting = [...existingIds].sort((a, b) => a - b);
      const incomingIds = [...uniqueIds].sort((a, b) => a - b);
      const same =
        sortedExisting.length === incomingIds.length &&
        sortedExisting.every((id, index) => id === incomingIds[index]);
      if (same) {
        return res.status(409).json({ status: 'error', message: '你已经投过票了' });
      }

      // MULTI 原子写：新选择（TTL 3 个月）+ 计数增减 + 参与人 set
      const multi = redisClient.multi();
      multi.set(userKey, JSON.stringify(incomingIds), { EX: ANON_VOTE_TTL_SECONDS });
      for (const id of sortedExisting) {
        if (!incomingIds.includes(id)) multi.hIncrBy(anonCountsKey(voteId), String(id), -1);
      }
      for (const id of incomingIds) {
        if (!sortedExisting.includes(id)) multi.hIncrBy(anonCountsKey(voteId), String(id), 1);
      }
      multi.expire(anonCountsKey(voteId), ANON_VOTE_TTL_SECONDS);
      multi.sAdd(anonVotersKey(voteId), String(userId));
      multi.expire(anonVotersKey(voteId), ANON_VOTE_TTL_SECONDS);
      await multi.exec();
    } else {
      // 重复投同一组选项 → 409（不产生重复记录）；选项不同则视为改票，允许覆盖
      const [existing] = await pool.execute(
        'SELECT option_id FROM scr_group_vote_records WHERE vote_id = ? AND user_id = ?',
        [voteId, userId]
      );
      const existingIds = existing.map((row) => row.option_id).sort((a, b) => a - b);
      const incomingIds = [...uniqueIds].sort((a, b) => a - b);
      if (
        existingIds.length === incomingIds.length &&
        existingIds.every((id, index) => id === incomingIds[index])
      ) {
        return res.status(409).json({ status: 'error', message: '你已经投过票了' });
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // 允许改票：先清空该用户此前的选择，再写入本次选择
        await conn.execute(
          'DELETE FROM scr_group_vote_records WHERE vote_id = ? AND user_id = ?',
          [voteId, userId]
        );
        await conn.query(
          'INSERT INTO scr_group_vote_records (vote_id, option_id, user_id) VALUES ?',
          [uniqueIds.map((optionId) => [voteId, optionId, userId])]
        );
        await conn.commit();
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }
    }

    const updated = await loadVote(voteId, userId);

    if (broadcastProducer) {
      broadcastProducer.enqueue(
        vote.group_id ? `group_${vote.group_id}` : PUBLIC_ROOM,
        'group-vote-updated',
        { vote: updated }
      );
    }

    res.json({ status: 'success', vote: updated });
  } catch (err) {
    console.error('投票失败:', err.message);
    res.status(500).json({ status: 'error', message: '投票失败' });
  }
}

// 结束投票：仅投票发起人本人可调（其他人 403；群主/管理员不代关），接龙 close 仍一律 410
export async function closeGroupVote(req, res) {
  try {
    const voteId = parseInt(req.params.id, 10);
    const userId = parseInt(req.userId, 10);
    if (isNaN(voteId)) return badRequest(res, '参数错误');

    const [votes] = await pool.execute(
      'SELECT id, group_id, creator_id, status FROM scr_group_votes WHERE id = ?',
      [voteId]
    );
    if (votes.length === 0) {
      return res.status(404).json({ status: 'error', message: '投票不存在' });
    }
    const vote = votes[0];
    if (parseInt(vote.creator_id, 10) !== userId) {
      return res.status(403).json({ status: 'error', message: '只有发起人可以结束投票' });
    }
    if (vote.status === 'open') {
      await pool.execute("UPDATE scr_group_votes SET status = 'closed' WHERE id = ?", [voteId]);
    }
    // 重复关闭幂等：直接返回关闭后的最新状态

    const updated = await loadVote(voteId, userId);
    const room = vote.group_id ? `group_${vote.group_id}` : PUBLIC_ROOM;
    if (broadcastProducer) {
      // vote-closed 通知全员收起投票交互；group-vote-updated 兼容既有 store 更新链路
      await broadcastProducer.enqueue(room, 'vote-closed', { voteId, vote: updated });
      broadcastProducer.enqueue(room, 'group-vote-updated', { vote: updated });
    }

    res.json({ status: 'success', vote: updated });
  } catch (err) {
    console.error('结束投票失败:', err.message);
    res.status(500).json({ status: 'error', message: '结束投票失败' });
  }
}

// 非匿名投票结束后查看某选项的投票人明细（分页，每页 20，按记录 id 升序翻页）
const VOTERS_PAGE_SIZE = 20;

export async function getVoteOptionVoters(req, res) {
  try {
    const voteId = parseInt(req.params.id, 10);
    const optionId = parseInt(req.params.optionId, 10);
    const userId = parseInt(req.userId, 10);
    if (isNaN(voteId) || isNaN(optionId)) return badRequest(res, '参数错误');
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10000);

    const [rows] = await pool.execute(`${VOTE_SELECT} WHERE v.id = ?`, [voteId]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: '投票不存在' });
    }
    const vote = shapeVote(rows[0]);
    if (vote.groupId !== null && !(await isGroupMember(vote.groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }
    // 匿名投票任何人都看不到「谁投了哪个项」；非匿名未结束也不可查
    if (vote.anonymous) {
      return res.status(403).json({ status: 'error', message: '匿名投票不公开投票人明细' });
    }
    if (vote.status !== 'closed') {
      return res.status(403).json({ status: 'error', message: '投票结束后才可查看投票人明细' });
    }

    const [optionRows] = await pool.execute(
      'SELECT id FROM scr_group_vote_options WHERE vote_id = ? AND id = ?',
      [voteId, optionId]
    );
    if (optionRows.length === 0) return badRequest(res, '选项不存在');

    const [countRows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM scr_group_vote_records WHERE vote_id = ? AND option_id = ?',
      [voteId, optionId]
    );
    const total = countRows[0].total;
    const offset = (page - 1) * VOTERS_PAGE_SIZE;
    const [voterRows] = await pool.execute(
      `SELECT r.user_id, u.nickname, u.avatar_url
         FROM scr_group_vote_records r
         LEFT JOIN scr_users u ON u.id = r.user_id
        WHERE r.vote_id = ? AND r.option_id = ?
        ORDER BY r.id ASC
        LIMIT ${VOTERS_PAGE_SIZE} OFFSET ${offset}`,
      [voteId, optionId]
    );

    res.json({
      status: 'success',
      voteId,
      optionId,
      total,
      page,
      pageSize: VOTERS_PAGE_SIZE,
      hasMore: offset + voterRows.length < total,
      voters: voterRows.map((row) => ({
        userId: row.user_id,
        nickname: row.nickname || '',
        avatarUrl: row.avatar_url || null
      }))
    });
  } catch (err) {
    console.error('查询投票人明细失败:', err.message);
    res.status(500).json({ status: 'error', message: '查询投票人明细失败' });
  }
}

// ---------------------------------------------------------------- 群设置

export async function getGroupFeatureSettings(req, res) {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const userId = parseInt(req.userId, 10);
    if (isNaN(groupId)) return badRequest(res, '参数错误');

    if (!(await isGroupMember(groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }

    const settings = await getGroupTypingSettings(groupId);
    if (!settings) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    res.json({
      status: 'success',
      // isAdmin 供前端决定「开关关闭时是否仍展示发起入口」
      isAdmin: await isGroupAdmin(groupId, userId),
      settings: {
        allowChain: settings.allowChain,
        allowVote: settings.allowVote,
        showTyping: settings.showTyping
      }
    });
  } catch (err) {
    console.error('获取群设置失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群设置失败' });
  }
}

export async function updateGroupFeatureSettings(req, res) {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const userId = parseInt(req.userId, 10);
    if (isNaN(groupId)) return badRequest(res, '参数错误');

    const body = req.body || {};
    const fields = [];
    const values = [];

    for (const key of ['allow_chain', 'allow_vote', 'show_typing']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean' && body[key] !== 0 && body[key] !== 1) {
        return badRequest(res, `${key} 必须是布尔值`);
      }
      fields.push(`${key} = ?`);
      values.push(body[key] === true || body[key] === 1 ? 1 : 0);
    }

    if (fields.length === 0) return badRequest(res, '没有需要修改的字段');

    if (!(await groupExists(groupId))) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }
    if (!(await isGroupAdmin(groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以修改群设置' });
    }

    values.push(groupId);
    await pool.execute(
      `UPDATE scr_groups SET ${fields.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      values
    );

    // 立即失效缓存，避免 typing / 接龙 / 投票继续按旧开关判断
    await invalidateGroupTypingSettings(groupId);
    const settings = await getGroupTypingSettings(groupId);

    if (broadcastProducer) {
      broadcastProducer.enqueue(`group_${groupId}`, 'group-settings-updated', {
        groupId,
        allowChain: settings.allowChain,
        allowVote: settings.allowVote,
        showTyping: settings.showTyping
      });
    }

    res.json({
      status: 'success',
      settings: {
        allowChain: settings.allowChain,
        allowVote: settings.allowVote,
        showTyping: settings.showTyping
      }
    });
  } catch (err) {
    console.error('修改群设置失败:', err.message);
    res.status(500).json({ status: 'error', message: '修改群设置失败' });
  }
}

export async function updateUserTypingSetting(req, res) {
  try {
    const userId = parseInt(req.userId, 10);
    const { show_typing: showTyping } = req.body || {};

    if (showTyping === undefined) return badRequest(res, '缺少 show_typing 参数');
    if (typeof showTyping !== 'boolean' && showTyping !== 0 && showTyping !== 1) {
      return badRequest(res, 'show_typing 必须是布尔值');
    }

    const value = showTyping === true || showTyping === 1 ? 1 : 0;
    await pool.execute('UPDATE scr_users SET show_typing = ? WHERE id = ?', [value, userId]);
    await invalidateUserTypingProfile(userId);

    res.json({ status: 'success', show_typing: value === 1 });
  } catch (err) {
    console.error('修改 typing 设置失败:', err.message);
    res.status(500).json({ status: 'error', message: '修改 typing 设置失败' });
  }
}

// ---------------------------------------------------------------- 群内搜索

// 只从消息内容里提取「用户能看到的文本」：
// 图片/文件/群名片/引用都是 JSON 存 content，直接对 JSON 串做 LIKE 会命中 quoted / userId /
// encrypted 之类的键名，属于脏结果。这里按消息类型逐类提取可渲染文本，
// 任何未识别的结构一律返回空串（宁可搜不到，也不返回 JSON 键名）。
const SEARCH_TYPES = {
  // 引用消息（4）展示的是「引用者自己写的文字 + 被引用消息的可渲染文本」，
  // 属于文本类，归入 text，否则默认搜索会漏掉引用卡片
  text: [0, 4, 5],
  image: [1],
  file: [2],
  card: [3],
  video: [6],
  audio: [7]
};

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return null;
  }
}

function pickNestedText(value) {
  if (typeof value === 'string') {
    if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
      const parsed = safeJsonParse(value);
      if (!parsed || typeof parsed !== 'object') return '';
      return [parsed.name, parsed.text, parsed.content].find((v) => typeof v === 'string' && v && !v.trim().startsWith('{')) || '';
    }
    return value;
  }
  if (value && typeof value === 'object') {
    return [value.name, value.text, value.content].find((v) => typeof v === 'string' && v && !v.trim().startsWith('{')) || '';
  }
  return '';
}

function extractSearchText(row) {
  const raw = row.content;
  switch (row.message_type) {
    case 0:
    case 5: {
      if (typeof raw !== 'string') return '';
      // 纯文本类型里如果混入了 JSON 原文（历史脏数据/客户端误传），直接跳过：
      // 对 JSON 做 LIKE 会命中 quoted / userId / encrypted 等键名，属于脏结果。
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return '';
      return raw;
    }
    case 1:
      return '[图片]';
    case 2: {
      const parsed = safeJsonParse(raw);
      return parsed ? String(parsed.name || '') : '';
    }
    case 3: {
      const parsed = safeJsonParse(raw);
      return parsed ? String(parsed.group_name || parsed.groupName || '') : '';
    }
    case 6:
    case 7: {
      const parsed = safeJsonParse(raw);
      return parsed ? String(parsed.name || '') : '';
    }
    case 4: {
      const parsed = safeJsonParse(raw);
      if (!parsed) return '';
      const own = typeof parsed.text === 'string' ? parsed.text : '';
      const quotedText = parsed.quoted ? pickNestedText(parsed.quoted.content) : '';
      return `${own} ${quotedText}`.trim();
    }
    default:
      return '';
  }
}

function messageCategory(messageType) {
  for (const [key, types] of Object.entries(SEARCH_TYPES)) {
    if (types.includes(messageType)) return key;
  }
  return 'other';
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function searchGroupMessages(req, res) {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    const userId = parseInt(req.userId, 10);
    if (isNaN(groupId)) return badRequest(res, '参数错误');

    const keyword = String(req.query.keyword || '').trim();
    if (keyword.length === 0) return badRequest(res, '请输入搜索关键词');
    if (keyword.length > 100) return badRequest(res, '搜索关键词过长');

    if (!(await isGroupMember(groupId, userId))) {
      return res.status(403).json({ status: 'error', message: '你不是该群成员' });
    }

    const requested = String(req.query.types || '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => Object.prototype.hasOwnProperty.call(SEARCH_TYPES, t));
    const typeList = requested.length > 0 ? requested : Object.keys(SEARCH_TYPES);
    const messageTypes = Array.from(new Set(typeList.flatMap((t) => SEARCH_TYPES[t])));
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    // SQL 只做粗筛（LIKE），真正的匹配在下面按「可渲染文本」精筛。
    // 群名片（type=3）的群名存在 JSON 内部，同样靠精筛命中。
    const like = `%${escapeLike(keyword)}%`;
    const [rows] = await pool.execute(
      `SELECT m.id, m.user_id, m.content, m.message_type, m.timestamp,
              u.nickname, u.avatar_url
         FROM scr_messages m
         LEFT JOIN scr_users u ON u.id = m.user_id
        WHERE m.group_id = ?
          AND m.message_type IN (${messageTypes.map(() => '?').join(',')})
          AND m.content LIKE ? ESCAPE '\\\\'
        ORDER BY m.id DESC
        LIMIT ?`,
      [groupId, ...messageTypes, like, SEARCH_SCAN_LIMIT]
    );

    const needle = keyword.toLowerCase();
    const results = [];
    for (const row of rows) {
      const text = extractSearchText(row);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      results.push({
        id: row.id,
        userId: row.user_id,
        nickname: row.nickname || '',
        avatarUrl: row.avatar_url || null,
        messageType: row.message_type,
        type: messageCategory(row.message_type),
        text,
        snippet: text.length > 120 ? `${text.slice(0, 120)}…` : text,
        timestamp: toIso(row.timestamp)
      });
      if (results.length >= limit) break;
    }

    res.json({
      status: 'success',
      keyword,
      types: typeList,
      total: results.length,
      messages: results
    });
  } catch (err) {
    console.error('群内搜索失败:', err.message);
    res.status(500).json({ status: 'error', message: '群内搜索失败' });
  }
}

import { pool, redisClient } from '../models/database.js';
import { filterMessageFields } from '../utils/messageFilters.js';
import { checkRateLimit } from '../middleware/auth.js';
import { validateMessageContent } from '../utils/validators.js';
import { messageConfig } from '../config/index.js';
import { runMessageTask } from '../workers/messageWorkerClient.js';

let io = null;
let broadcastProducer = null;

export function setSocketDependencies(socketIo, getOnlineUsersFn, authUserFn, producer) {
  io = socketIo;
  broadcastProducer = producer;
}

async function isGroupAdmin(groupId, userId) {
  try {
    const [groups] = await pool.execute(
      'SELECT creator_id FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );
    if (groups.length === 0) return false;

    const isOwner = parseInt(groups[0].creator_id) === parseInt(userId);
    if (isOwner) return true;

    const [members] = await pool.execute(
      'SELECT is_admin FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, userId]
    );

    return members.length > 0 && members[0].is_admin === 1;
  } catch (err) {
    console.error('检查群管理员身份失败:', err.message);
    return false;
  }
}

export async function getGlobalMessages(limit = 50, olderThan = null, userId = null) {
  try {
    return await runMessageTask('getGlobalMessages', { limit, olderThan, userId });
  } catch (err) {
    console.error('❌ 全局消息 Worker 任务失败，回退主线程逻辑:', err.message);
  }
  try {
    let query = 'SELECT m.id, m.user_id as userId, u.nickname, u.avatar_url as avatarUrl,'
      + 'm.content, m.at_userid, m.message_type as messageType, m.group_id as groupId, m.timestamp'
      + ' FROM scr_messages m'
      + ' JOIN scr_users u ON m.user_id = u.id'
      + ' WHERE m.group_id IS NULL';

    const params = [];

    let safeLimit = 20;
    try {
      safeLimit = parseInt(limit);
      if (isNaN(safeLimit) || safeLimit <= 0) {
        safeLimit = 20;
      }
    } catch (e) {
      safeLimit = 20;
    }

    const isOlderThanValid = olderThan !== null && olderThan !== undefined && olderThan !== '' && olderThan !== 0 && String(olderThan).trim() !== '';

    if (isOlderThanValid) {
      let safeOlderThan = 0;
      try {
        safeOlderThan = parseInt(olderThan);
        if (!isNaN(safeOlderThan)) {
          query += ' AND m.id < ?';
          params.push(safeOlderThan);
        }
      } catch (e) {
        // 解析失败，使用默认值0
      }
    }

    query += ' ORDER BY m.timestamp DESC, m.id DESC LIMIT ?';
    params.push(safeLimit);

    const [messages] = await pool.query(query, params);

    let readMaxId = 0;
    if (userId) {
      const readKey = `scr:read:global:${parseInt(userId)}`;
      const readValue = await redisClient.get(readKey);
      readMaxId = readValue ? parseInt(readValue) : 0;
    }

    const processedMessages = messages.map(msg => {
      let atUserIds = null;
      if (msg.at_userid) {
        try {
          const parsed = JSON.parse(msg.at_userid);
          if (Array.isArray(parsed)) {
            atUserIds = parsed.filter(id => id !== null && id !== undefined && id !== '' && !isNaN(Number(id))).map(id => Number(id));
            if (atUserIds.length === 0) atUserIds = null;
          }
        } catch (e) {
          atUserIds = null;
        }
      }
      const baseMessage = {
        id: msg.id,
        userId: msg.userId,
        nickname: msg.nickname,
        avatarUrl: msg.avatarUrl,
        content: msg.content,
        at_userid: atUserIds,
        messageType: msg.messageType,
        groupId: msg.groupId !== null && msg.groupId !== undefined ? parseInt(msg.groupId) : null,
        timestamp: msg.timestamp,
        isRead: userId ? (msg.id <= readMaxId || String(msg.userId) === String(userId)) : false
      };

      if (msg.groupNickname) {
        baseMessage.groupNickname = msg.groupNickname;
      }

      if (msg.messageType === 101) {
        const recallMessageId = String(msg.content || '').trim();
        if (recallMessageId && !isNaN(Number(recallMessageId))) {
          baseMessage.content = recallMessageId;
        }
      }

      if (msg.messageType === 1 && msg.content) {
        try {
          const contentData = JSON.parse(msg.content);
          if (contentData.url) {
            baseMessage.imageUrl = contentData.url;
          }
        } catch (error) {
          console.error(`解析图片消息失败: 消息ID=${msg.id}, 错误=${error.message}`);
        }
      }

      return baseMessage;
    });

    return processedMessages.reverse();
  } catch (err) {
    console.error('获取全局消息失败:', err.message);
    return [];
  }
}

export async function getGroupMessages(groupId, limit = 50, olderThan = null, userId = null) {
  try {
    return await runMessageTask('getGroupMessages', { groupId, limit, olderThan, userId });
  } catch (err) {
    console.error('❌ 群组消息 Worker 任务失败，回退主线程逻辑:', err.message);
  }
  try {
    let safeGroupId = 0;
    try {
      safeGroupId = parseInt(groupId);
      if (isNaN(safeGroupId)) {
        return [];
      }
    } catch (e) {
      return [];
    }

    let safeLimit = 20;
    try {
      safeLimit = parseInt(limit);
      if (isNaN(safeLimit) || safeLimit <= 0) {
        safeLimit = 20;
      }
    } catch (e) {
      safeLimit = 20;
    }

    let query = 'SELECT m.id, m.user_id as userId, u.nickname, u.avatar_url as avatarUrl,'
      + 'm.content, m.at_userid, m.message_type as messageType, m.group_id as groupId, m.timestamp,'
      + 'gm.group_nickname as groupNickname'
      + ' FROM scr_messages m'
      + ' JOIN scr_users u ON m.user_id = u.id'
      + ' LEFT JOIN scr_group_members gm ON m.user_id = gm.user_id AND m.group_id = gm.group_id AND gm.deleted_at IS NULL'
      + ' WHERE m.group_id = ?';
    const params = [safeGroupId];

    const isOlderThanValid = olderThan !== null && olderThan !== undefined && olderThan !== '' && olderThan !== 0 && String(olderThan).trim() !== '';
    if (isOlderThanValid) {
      let safeOlderThan = 0;
      try {
        safeOlderThan = parseInt(olderThan);
        if (!isNaN(safeOlderThan)) {
          query += ' AND m.id < ?';
          params.push(safeOlderThan);
        }
      } catch (e) {
        // 解析失败，使用默认值0
      }
    }

    query += ' ORDER BY m.timestamp DESC, m.id DESC LIMIT ?';
    params.push(safeLimit);

    const [messages] = await pool.query(query, params);

    let readMaxId = 0;
    let isGroupDisturb = false;
    if (userId) {
      // 检查用户是否对该群组设置了免打扰
      try {
        const [memberRows] = await pool.execute(
          'SELECT is_disturb FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
          [safeGroupId, parseInt(userId)]
        );
        if (memberRows.length > 0 && memberRows[0].is_disturb === 1) {
          isGroupDisturb = true;
        }
      } catch (e) {
        console.error('检查群组免打扰状态失败:', e.message);
      }

      if (!isGroupDisturb) {
        const readKey = `scr:read:group:${safeGroupId}:${parseInt(userId)}`;
        const readValue = await redisClient.get(readKey);
        readMaxId = readValue ? parseInt(readValue) : 0;
      }
    }

    const processedMessages = messages.map(msg => {
      let atUserIds = null;
      if (msg.at_userid) {
        try {
          const parsed = JSON.parse(msg.at_userid);
          if (Array.isArray(parsed)) {
            atUserIds = parsed.filter(id => id !== null && id !== undefined && id !== '' && !isNaN(Number(id))).map(id => Number(id));
            if (atUserIds.length === 0) atUserIds = null;
          }
        } catch (e) {
          atUserIds = null;
        }
      }
      const baseMessage = {
        id: msg.id,
        userId: msg.userId,
        nickname: msg.nickname,
        avatarUrl: msg.avatarUrl,
        content: msg.content,
        at_userid: atUserIds,
        messageType: msg.messageType,
        groupId: msg.groupId !== null && msg.groupId !== undefined ? parseInt(msg.groupId) : null,
        timestamp: msg.timestamp,
        isRead: userId ? (msg.id <= readMaxId || String(msg.userId) === String(userId)) : false
      };

      if (msg.groupNickname) {
        baseMessage.groupNickname = msg.groupNickname;
      }

      if (msg.messageType === 101) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed && parsed.id) {
            baseMessage.content = msg.content;
          }
        } catch (e) {
          const recallMessageId = String(msg.content || '').trim();
          if (recallMessageId && !isNaN(Number(recallMessageId))) {
            baseMessage.content = JSON.stringify({
              id: Number(recallMessageId),
              nickname: { [msg.userId]: msg.groupNickname || msg.nickname || '用户' }
            });
          }
        }
      }

      if (msg.messageType === 1 && msg.content) {
        try {
          const contentData = JSON.parse(msg.content);
          if (contentData.url) {
            baseMessage.imageUrl = contentData.url;
          }
        } catch (error) {
          console.error(`解析图片消息失败: 消息ID=${msg.id}, 错误=${error.message}`);
        }
      }

      // 免打扰群组：强制所有消息已读
      if (isGroupDisturb) {
        baseMessage.isRead = true;
      }

      return baseMessage;
    });

    return processedMessages.reverse();
  } catch (err) {
    console.error('获取群组消息失败:', err.message);
    return [];
  }
}

export async function sendMessage(req, res) {
  try {
    const { content, groupId, at_userid } = req.body;
    const userId = req.userId;

    const rateLimitResult = await checkRateLimit(userId);
    if (!rateLimitResult.allowed) {
      return res.status(429).json({ 
        status: 'error', 
        message: `发送消息过于频繁，请${rateLimitResult.retryAfter}秒后再试`,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: rateLimitResult.retryAfter
      });
    }

    if (!validateMessageContent(content)) {
      console.error('❌ 消息内容格式错误或超过 10000 字符限制');
      return res.status(400).json({ status: 'error', message: '消息内容格式错误或超过 10000 字符限制' });
    }

    const [users] = await pool.execute(
        'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
        [userId]
    );

    if (users.length === 0) {
      console.error('❌ 用户不存在:', userId);
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const user = users[0];

    const [result] = await pool.execute(
        'INSERT INTO scr_messages (user_id, content, at_userid, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [userId, content, at_userid ? JSON.stringify(at_userid) : null, groupId || null]
    );

    // 同步"范围内最新消息ID"缓存，供 clear-group/global-unread 使用
    if (redisClient) {
      if (groupId) {
        redisClient.set(`scr:max_msg_id:group:${parseInt(groupId)}`, String(result.insertId)).catch(() => {});
      } else {
        redisClient.set('scr:max_msg_id:global', String(result.insertId)).catch(() => {});
      }
    }

    const rawMessage = {
      id: result.insertId,
      userId,
      nickname: user.nickname,
      avatarUrl: user.avatar_url,
      content: content,
      atUserid: at_userid,
      messageType: 0,
      groupId: groupId || null,
      timestamp: new Date()
    };

    const messageTypeStr = groupId ? 'group' : 'public';
    const newMessage = filterMessageFields(rawMessage, messageTypeStr);

    if (groupId) {
      broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', newMessage);
      
    } else {
      // 公共聊天消息广播给所有已认证用户（走 Redis Streams 扇出路径，集群安全）
      broadcastProducer?.enqueue('authenticated_users', 'message-received', newMessage);
    }

    res.json({
      status: 'success',
      messageId: result.insertId,
      message: '消息发送成功'
    });

  } catch (err) {
    console.error('❌ HTTP保存消息失败:', err.message);
    res.status(500).json({ status: 'error', message: '发送消息失败' });
  }
}

export async function getOfflineMessages(req, res) {
  try {
    const userId = req.userId;
    const publicAndGroupMinId = req.query.publicAndGroupMinId ? parseInt(req.query.publicAndGroupMinId) : 0;
    const privateMinId = req.query.privateMinId ? parseInt(req.query.privateMinId) : 0;

    try {
      const result = await runMessageTask('getOfflineMessages', { userId, publicAndGroupMinId, privateMinId });
      return res.json({ status: 'success', ...result });
    } catch (err) {
      console.error('❌ 离线消息 Worker 任务失败，回退主线程逻辑:', err.message);
    }

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const publicLimit = messageConfig.offlineLimits.public;
    const [publicMessages] = await pool.query(`
      SELECT 
        m.id, 
        m.user_id as userId, 
        u.nickname, 
        u.avatar_url as avatarUrl, 
        m.content, 
        m.at_userid as atUserid,
        m.message_type as messageType, 
        m.timestamp,
        'public' as type
      FROM scr_messages m 
      JOIN scr_users u ON m.user_id = u.id 
      WHERE m.group_id IS NULL 
        AND m.timestamp >= ?
        AND m.id > ?
      ORDER BY m.timestamp DESC, m.id DESC
      LIMIT ?
    `, [threeMonthsAgo, publicAndGroupMinId, publicLimit]);
    
    const [allMemberRecords] = await pool.execute(`
      SELECT group_id, joined_at, deleted_at FROM scr_group_members WHERE user_id = ?
    `, [userId]);
    
    const groupRecordsMap = new Map();
    for (const record of allMemberRecords) {
      const groupId = record.group_id;
      if (!groupRecordsMap.has(groupId)) {
        groupRecordsMap.set(groupId, []);
      }
      groupRecordsMap.get(groupId).push(record);
    }
    
    let groupMessages = [];
    if (groupRecordsMap.size > 0) {
      for (const [groupId, records] of groupRecordsMap) {
        const timeConditions = [];
        const params = [groupId, threeMonthsAgo, publicAndGroupMinId];
        
        for (const record of records) {
          if (record.deleted_at) {
            timeConditions.push(`(m.timestamp >= ? AND m.timestamp <= ?)`);
            params.push(record.joined_at, record.deleted_at);
          } else {
            timeConditions.push(`m.timestamp >= ?`);
            params.push(record.joined_at);
          }
        }
        
        const timeCondition = timeConditions.join(' OR ');
        
        const groupLimit = messageConfig.offlineLimits.group;
        params.push(groupLimit);
        
        const [groupMsgs] = await pool.query(`
          SELECT 
            m.id, 
            m.user_id as userId, 
            u.nickname, 
            u.avatar_url as avatarUrl, 
            m.content, 
            m.at_userid as atUserid,
            m.message_type as messageType, 
            m.timestamp,
            'group' as type,
            m.group_id as groupId,
            g.name as groupName,
            g.deleted_at as groupDeletedAt,
            gm.group_nickname as groupNickname
          FROM scr_messages m 
          JOIN scr_users u ON m.user_id = u.id 
          JOIN scr_groups g ON m.group_id = g.id
          LEFT JOIN scr_group_members gm ON m.user_id = gm.user_id AND m.group_id = gm.group_id AND gm.deleted_at IS NULL
          WHERE m.group_id = ?
            AND m.timestamp >= ?
            AND m.id > ?
            AND (${timeCondition})
          ORDER BY m.timestamp DESC, m.id DESC
          LIMIT ?
        `, params);
        
        groupMessages = groupMessages.concat(groupMsgs);
      }
      
      groupMessages.sort((a, b) => {
        if (b.timestamp !== a.timestamp) {
          return new Date(b.timestamp) - new Date(a.timestamp);
        }
        return b.id - a.id;
      });
      
      if (groupMessages.length > 8000) {
        groupMessages = groupMessages.slice(0, 8000);
      }
    }
    
    const privateLimit = messageConfig.offlineLimits.private;
    const [privateMessages] = await pool.query(`
      SELECT
        p.id,
        p.sender_id as senderId,
        p.receiver_id as receiverId,
        p.content,
        p.at_userid as atUserid,
        p.message_type as messageType,
        p.is_read as isRead,
        p.timestamp,
        'private' as type,
        u.nickname,
        u.avatar_url as avatarUrl
      FROM scr_private_messages p
      JOIN scr_users u ON p.sender_id = u.id
      WHERE ((p.sender_id = ? AND p.receiver_id != ?) OR (p.receiver_id = ? AND p.sender_id != ?))
        AND EXISTS (
          SELECT 1 FROM scr_friends cf
          WHERE cf.user_id = ?
            AND cf.friend_id = IF(p.sender_id = ?, p.receiver_id, p.sender_id)
            AND cf.status = 1
        )
        AND p.timestamp >= ?
        AND p.id > ?
      ORDER BY p.timestamp DESC, p.id DESC
      LIMIT ?
    `, [userId, userId, userId, userId, userId, userId, threeMonthsAgo, privateMinId, privateLimit]);

    const processRecallMessage = (msg) => {
      if (msg.messageType === 101) {
        if (msg.type === 'group' && msg.groupId) {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed && parsed.id) {
              return msg;
            }
          } catch (e) {
            // 旧格式，需要转换
          }
          const recallMessageId = String(msg.content || '').trim();
          if (recallMessageId && !isNaN(Number(recallMessageId))) {
            msg.content = JSON.stringify({
              id: Number(recallMessageId),
              nickname: { [msg.userId || msg.senderId]: msg.groupNickname || msg.nickname || '用户' }
            });
          }
        }
      }
      return msg;
    };

    let globalReadMaxId = 0;
    if (userId) {
      try {
        const val = await redisClient.get(`scr:read:global:${userId}`);
        globalReadMaxId = val ? parseInt(val) : 0;
      } catch (e) {
        globalReadMaxId = 0;
      }
    }

    const processedPublicMessages = publicMessages.map(msg => {
      const processed = processRecallMessage(msg);
      processed.isRead = globalReadMaxId > 0 ? (msg.id <= globalReadMaxId) : false;
      return processed;
    });

    const groupReadMaxIds = {};
    if (userId) {
      const uniqueGroupIds = [...new Set(groupMessages.map(m => m.groupId))];
      for (const gid of uniqueGroupIds) {
        try {
          const val = await redisClient.get(`scr:read:group:${gid}:${userId}`);
          groupReadMaxIds[gid] = val ? parseInt(val) : 0;
        } catch (e) {
          groupReadMaxIds[gid] = 0;
        }
      }
    }

    const processedGroupMessages = groupMessages.map(msg => {
      const processed = processRecallMessage(msg);
      const maxId = groupReadMaxIds[msg.groupId] || 0;
      const isOwnMessage = String(msg.userId || msg.senderId) === String(userId);
      processed.isRead = isOwnMessage || (maxId > 0 ? (msg.id <= maxId) : false);
      return processed;
    });

    const processedPrivateMessages = privateMessages.map(processRecallMessage);

    res.json({
      status: 'success',
      publicMessages: processedPublicMessages.reverse(),
      groupMessages: processedGroupMessages.reverse(),
      privateMessages: processedPrivateMessages.reverse(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ 获取离线消息失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取离线消息失败' });
  }
}

export async function deleteDeletedSession(req, res) {
  try {
    const userId = req.headers['user-id'];
    const { type, id } = req.body;
    
    if (!userId) {
      return res.status(401).json({ status: 'error', message: '未授权' });
    }
    
    if (!type || !id) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }
    
    if (type !== 'group' && type !== 'private') {
      return res.status(400).json({ status: 'error', message: '类型必须是 group 或 private' });
    }
    
    if (type === 'group') {
      const [result] = await pool.execute(
        'DELETE FROM scr_group_members WHERE user_id = ? AND group_id = ? AND deleted_at IS NOT NULL',
        [userId, parseInt(id)]
      );
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: '未找到该群组的已删除会话记录' });
      }
    } else if (type === 'private') {
      const [updateResult5] = await pool.execute(
        'UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 5',
        [userId, parseInt(id)]
      );

      if (updateResult5.affectedRows > 0) {
        // 状态5已更新，继续
      } else {
        const [updateResult10] = await pool.execute(
          'UPDATE scr_friends SET status = 11, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 10',
          [userId, parseInt(id)]
        );

        if (updateResult10.affectedRows > 0) {
          // 状态10已更新，继续
        } else {
          const [updateResult0] = await pool.execute(
            'UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 0',
            [userId, parseInt(id)]
          );

          if (updateResult0.affectedRows > 0) {
            // 状态0已更新，继续
          } else {
            const [updateResult11] = await pool.execute(
              'UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 11',
              [userId, parseInt(id)]
            );

            if (updateResult11.affectedRows > 0) {
              // 状态11已更新，继续
            } else {
              const [deleteResult6] = await pool.execute(
                'DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status = 6',
                [userId, parseInt(id)]
              );

              if (deleteResult6.affectedRows > 0) {
                // 状态6已删除，继续
              } else {
                return res.status(404).json({ status: 'error', message: '未找到该好友的已删除会话记录' });
              }
            }
          }
        }
      }
    }

    res.json({ status: 'success', message: '已删除会话记录已成功清除' });
  } catch (error) {
    console.error('❌ 删除单个已删除会话失败:', error);
    res.status(500).json({ status: 'error', message: '服务器错误，请重试' });
  }
}

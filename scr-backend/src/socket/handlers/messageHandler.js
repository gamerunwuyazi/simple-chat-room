import { SocketEvents } from '../events.js';
import path from 'path';
import fs from 'fs';
import { pool as dbPool, redisClient } from '../../models/database.js';

function checkIfUserMuted(isMutedValue) {
  const result = {
    muted: false,
    permanent: false,
    remainingMinutes: 0,
    remainingSeconds: 0
  };
  
  // 情况1: NULL - 未禁言
  if (isMutedValue === null || isMutedValue === undefined) {
    return result;
  }
  
  const valueStr = String(isMutedValue).trim();
  
  // 情况2: 旧格式 TINYINT - 值为 '0' 或 '1'
  if (valueStr === '0') {
    return result; // 未禁言
  }
  
  if (valueStr === '1') {
    result.muted = true;
    result.permanent = true; // 旧格式的1视为永久禁言
    return result;
  }
  
  // 情况3: 新格式 DATETIME - 包含9999表示永久禁言
  if (valueStr.includes('9999')) {
    result.muted = true;
    result.permanent = true;
    return result;
  }
  
  // 情况4: 解析为日期时间（支持多种格式）
  let mutedTime;
  
  // 尝试解析MySQL DATETIME格式: "2026-05-13 19:35:15"（存储为 UTC，显式按 UTC 解析）
  const mysqlDateTimeMatch = valueStr.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (mysqlDateTimeMatch) {
    const [, year, month, day, hour, minute, second] = mysqlDateTimeMatch;
    mutedTime = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour),
        parseInt(minute),
        parseInt(second)
      )
    );
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(valueStr)) {
    // 无时区的 ISO 格式同样按 UTC 解析
    mutedTime = new Date(valueStr + 'Z');
  } else {
    // 尝试ISO格式或其他格式（带时区标识的可直接解析）
    mutedTime = new Date(valueStr);
  }

  if (!isNaN(mutedTime.getTime())) {
    // 计算时间差（毫秒），now 为绝对时间戳，与时区无关
    const now = new Date();
    
    // 计算时间差（毫秒）
    const diffMs = mutedTime.getTime() - now.getTime();
    const diffMinutes = Math.ceil(diffMs / (1000 * 60));
    
    if (diffMinutes > 0) {
      result.muted = true;
      result.remainingMinutes = diffMinutes;
      result.remainingSeconds = Math.ceil(diffMs / 1000);
    } else {
      result.muted = false; // 已过期
    }
  } else {
    console.error('❌ 无法解析禁言时间值:', isMutedValue, valueStr);
  }
  
  return result;
}

export function registerMessageHandlers(socket, io, { pool, checkRateLimit, validateMessageContent, filterMessageFields, getAllOnlineUsers, getGlobalMessages, getGroupMessages, isGroupAdmin, broadcastProducer }) {
  
  // 发送消息
  socket.on(SocketEvents.SEND_MESSAGE, async (messageData) => {
    try {
      const { userId, content, groupId, sessionToken, at_userid } = messageData;
  
      // 速率限制检查
      const rateLimitResult = await checkRateLimit(userId);
      if (!rateLimitResult.allowed) {
        // 通过 message-sent 事件返回速率限制错误
        socket.emit(SocketEvents.MESSAGE_SENT, { 
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `发送消息过于频繁，请${rateLimitResult.retryAfter}秒后再试`,
            retryAfter: rateLimitResult.retryAfter
          }
        });
        return;
      }
  
      // 验证消息内容...
      if (!validateMessageContent(content)) {
        socket.emit(SocketEvents.MESSAGE_SENT, {
          success: false,
          error: {
            code: 'INVALID_CONTENT',
            message: '消息内容格式错误或超过 10000 字符限制'
          }
        });
        return;
      }
  
      // 如果是群组消息，验证用户是否在群组中
      if (groupId) {
        // 合并查询1：群组存在性 + 群主 + 删除状态 + 全员禁言（原查询1+3合并为一次）
        const [groupRows] = await pool.execute(
          'SELECT id, creator_id, deleted_at, is_mute_all FROM scr_groups WHERE id = ?',
          [groupId]
        );

        if (groupRows.length === 0) {
          socket.emit(SocketEvents.MESSAGE_SENT, { 
            success: false,
            error: {
              code: 'GROUP_NOT_FOUND',
              message: '群组不存在'
            }
          });
          return;
        }

        const groupInfo = groupRows[0];

        // 检查群组是否已被删除
        if (groupInfo.deleted_at !== null) {
          socket.emit(SocketEvents.MESSAGE_SENT, { 
            success: false,
            error: {
              code: 'GROUP_DELETED',
              message: '该群组已被解散，无法发送消息'
            }
          });
          return;
        }

        // 合并查询2：成员存在性 + 管理员 + 禁言状态（原查询2+4合并为一次）
        const [memberRows] = await pool.execute(
          "SELECT is_admin, DATE_FORMAT(is_muted, '%Y-%m-%d %H:%i:%s') AS is_muted FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL",
          [groupId, userId]
        );

        if (memberRows.length === 0) {
          socket.emit(SocketEvents.MESSAGE_SENT, { 
            success: false,
            error: {
              code: 'NOT_IN_GROUP',
              message: '您不在该群组中，无法发送消息'
            }
          });
          return;
        }

        const member = memberRows[0];
        const isGroupOwner = groupInfo.creator_id === userId;

        if (!isGroupOwner) {
          // 检查全员禁言：如果开启了全员禁言，只有管理员可以发言
          if (groupInfo.is_mute_all === 1 && member.is_admin !== 1) {
            socket.emit(SocketEvents.MESSAGE_SENT, { 
              success: false,
              error: {
                code: 'GROUP_MUTE_ALL',
                message: '当前已开启全员禁言，只有管理员可以发言'
              }
            });
            return;
          }

          // 检查个人禁言状态（优化后的单字段设计）
          const isUserMuted = checkIfUserMuted(member.is_muted);

          if (isUserMuted.muted) {
            // 剩余时间精确到秒（checkIfUserMuted 已确保未过期，remainingSeconds > 0）
            const remainMin = Math.floor(isUserMuted.remainingSeconds / 60);
            const remainSec = isUserMuted.remainingSeconds % 60;
            const remainText = remainMin > 0
              ? `剩余时间${remainMin}分${remainSec}秒`
              : `剩余时间${remainSec}秒`;
            socket.emit(SocketEvents.MESSAGE_SENT, {
              success: false,
              error: {
                code: 'USER_MUTED',
                message: isUserMuted.permanent
                  ? '您已被永久禁言，无法发送消息'
                  : `您已被禁言，${remainText}，到期后即可自动发送`
              }
            });
            return;
          }
        }

        // 检查是否包含 @全体成员 (-1)，只有群主或管理员才能发送（复用上面的查询结果，不再额外查询）
        if (at_userid && Array.isArray(at_userid)) {
          const hasAllMemberAt = at_userid.some(id => id === -1);
          if (hasAllMemberAt) {
            const isAdmin = isGroupOwner || member.is_admin === 1;
            if (!isAdmin) {
              socket.emit(SocketEvents.MESSAGE_SENT, { 
                success: false,
                error: {
                  code: 'NOT_GROUP_ADMIN',
                  message: '只有群主或管理员才能@全体成员'
                }
              });
              return;
            }
          }
        }
      }
  
      // 获取用户信息...
      const [users] = await pool.execute(
          'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
          [userId]
      );

      if (users.length === 0) {
        console.error('❌ 用户不存在:', userId);
        socket.emit(SocketEvents.ERROR, { message: '用户不存在' });
        return;
      }

      const user = users[0];
      
      // 群组消息：获取群昵称作为独立字段（不覆盖全局 nickname）
      let groupNickname = null;
      
      if (groupId) {
        try {
          const [memberInfo] = await pool.execute(
            'SELECT group_nickname FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
            [groupId, userId]
          );

          if (memberInfo.length > 0 && memberInfo[0].group_nickname) {
            groupNickname = memberInfo[0].group_nickname;
          }
        } catch (nicknameErr) {
          console.error('获取群昵称失败:', nicknameErr.message);
        }
      }

      // 不进行严格转义，保持原始内容格式，让前端处理安全的解析和链接显示
      const cleanContent = content;

      // 获取当前精确时间戳（毫秒级和ISO格式）
      const now = new Date();
      const timestamp = now.toISOString();
      const timestampMs = now.getTime();

      // 插入消息到数据库（使用MySQL的NOW()函数而不是JavaScript生成的ISO格式时间）
      // 使用前端发送的消息类型，默认为文字消息类型
      const messageType = messageData.message_type || messageData.messageType || 0;
      
      const messageContent = cleanContent;
      
      const [result] = await pool.execute(
          'INSERT INTO scr_messages (user_id, content, at_userid, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, ?, NOW())',
          [userId, messageContent, at_userid ? JSON.stringify(at_userid) : null, messageType, groupId || null]
      );

      // 同步"范围内最新消息ID"缓存，供 clear-group/global-unread 使用（消除每包 MAX(id) DB 查询）
      // fire-and-forget，失败不影响消息发送
      if (groupId) {
        redisClient.set(`scr:max_msg_id:group:${parseInt(groupId)}`, String(result.insertId)).catch(() => {});
      } else {
        redisClient.set('scr:max_msg_id:global', String(result.insertId)).catch(() => {});
      }
      
      // 广播消息 - 使用已经过HTML转义的内容
      const rawMessage = {
        id: result.insertId,
        userId,
        nickname: user.nickname,  // 全局昵称（不覆盖）
        avatarUrl: user.avatar_url,
        content: messageContent,
        atUserid: at_userid,
        messageType: messageType,
        groupId: groupId || null,
        timestamp: timestampMs,
        timestampISO: timestamp
      };

      // 群组消息：加上群昵称作为独立字段
      if (groupId && groupNickname) {
        rawMessage.groupNickname = groupNickname;
      }
      
      // 处理图片消息：从content字段解析图片URL
      if (messageType === 1 && cleanContent) {
        try {
          const contentData = JSON.parse(cleanContent);
          if (contentData.url) {
            rawMessage.imageUrl = contentData.url;
          }
        } catch (error) {
          console.error(`❌ 解析图片消息失败: 消息ID=${result.insertId}, 错误=${error.message}`);
        }
      }
      
      // 根据消息类型过滤字段
      const messageTypeStr = groupId ? 'group' : 'public';
      const newMessage = filterMessageFields(rawMessage, messageTypeStr);
      
      if (groupId) {
        // 确保groupId是字符串类型，避免Map键类型不一致
        const groupIdStr = String(groupId);
        
        // 先让发送者立即收到发送结果（大群广播异步化后，发送者无需等待广播完成）
        socket.emit(SocketEvents.MESSAGE_SENT, { messageId: result.insertId, message: newMessage });
        
        // 群组消息：入队广播任务，由消费者异步扇出给群里其他成员（避开发送者）
        try {
          await broadcastProducer.enqueue(`group_${groupId}`, SocketEvents.MESSAGE_RECEIVED, newMessage, socket.id);
        } catch (directSendErr) {
          console.error('发送群组消息失败:', directSendErr.message);
        }
        
      } else {
        // 先让发送者立即收到发送结果
        socket.emit(SocketEvents.MESSAGE_SENT, { messageId: result.insertId, message: newMessage });
        
        // 全局消息：入队广播任务（避开发送者）
        try {
          await broadcastProducer.enqueue('authenticated_users', SocketEvents.MESSAGE_RECEIVED, newMessage, socket.id);
        } catch (directSendErr) {
          console.error('发送全局消息失败:', directSendErr.message);
        }
      }

  } catch (err) {
      console.error('❌ 保存消息失败:', err.message);
      socket.emit(SocketEvents.ERROR, { message: '发送消息失败' });
    }
  });

  // 删除消息
  socket.on(SocketEvents.DELETE_MESSAGE, async (data) => {
    try {
      const { messageId, userId, sessionToken } = data;

      // 速率限制检查（与发送消息共用同一速率限制）
      const rateLimitResult = await checkRateLimit(userId);
      if (!rateLimitResult.allowed) {
        socket.emit(SocketEvents.MESSAGE_SENT, { 
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `撤回消息过于频繁，请${rateLimitResult.retryAfter}秒后再试`,
            retryAfter: rateLimitResult.retryAfter
          }
        });
        return;
      }

      // 先获取消息信息，检查是否有图片和权限
      const [messages] = await pool.execute(
          'SELECT content, message_type, user_id, group_id FROM scr_messages WHERE id = ?',
          [messageId]
      );

      if (messages.length === 0) {
        socket.emit(SocketEvents.ERROR, { message: '消息不存在' });
        return;
      }

      const message = messages[0];

      // 检查权限：只能删除自己的消息
      if (message.user_id !== userId) {
        console.error('❌ 权限不足，只能删除自己的消息:', { messageUserId: message.user_id, requestUserId: userId });
        socket.emit(SocketEvents.ERROR, { message: '只能删除自己的消息' });
        return;
      }
      
      // 如果是群组消息，验证用户是否在群组中
      if (message.group_id) {
        const [memberCheck] = await pool.execute(
          'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
          [message.group_id, userId]
        );
        
        if (memberCheck.length === 0) {
          console.error('❌ 用户不在群组中，无法删除消息:', { userId, groupId: message.group_id });
          socket.emit(SocketEvents.ERROR, { message: '您不在该群组中，无法删除消息' });
          return;
        }
      }

      // 处理文件删除 - 根据message_type和JSON内容判断
      let contentData = null;
      try {
        if (message.content && (message.message_type === 1 || message.message_type === 2)) {
          contentData = JSON.parse(message.content);
        }
      } catch (jsonError) {
        console.error('❌ 解析消息内容失败:', jsonError.message);
      }
      
      if (contentData && typeof contentData.url === 'string') {
        // 有文件需要删除；仅允许删除 public 目录内的文件，防止路径穿越删除服务器任意文件
        const publicDir = path.resolve(process.cwd(), 'public');
        const filePath = path.resolve(publicDir, contentData.url);
        if (filePath.startsWith(publicDir + path.sep) && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      // 将messageId转换为数字类型，确保与缓存中的msg.id类型匹配
      const numericMessageId = Number(messageId);
      
      // 查询操作者（发送撤回请求的用户）的昵称和头像
      const [operatorInfo] = await pool.execute(
        'SELECT nickname, avatar_url FROM scr_users WHERE id = ?',
        [userId]
      );
      const operatorNickname = operatorInfo[0]?.nickname || '未知用户';
      const operatorAvatarUrl = operatorInfo[0]?.avatar_url || '';
      
      // 群组撤回：获取群昵称作为独立字段
      let recallGroupNickname = null;
      if (message.group_id) {
        try {
          const [memberInfo] = await pool.execute(
            'SELECT group_nickname FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
            [message.group_id, userId]
          );
          if (memberInfo.length > 0 && memberInfo[0].group_nickname) {
            recallGroupNickname = memberInfo[0].group_nickname;
          }
        } catch (e) {
          console.error('获取撤回操作的群昵称失败:', e.message);
        }
      }

      // 构建被撤回消息的JSON格式内容（用于更新原数据库记录）
      const recallJson = JSON.stringify({ [userId]: operatorNickname || recallGroupNickname || '用户' });

      // 更新原数据库记录的内容为JSON格式（不是文本占位符）
      await pool.execute(
        'UPDATE scr_messages SET content = ? WHERE id = ?',
        [recallJson, messageId]
      );

      // 单独生成一条101消息
      let insertResult;
      let dbRecallContent;
      let socketRecallContent;
      if (message.group_id) {
        dbRecallContent = JSON.stringify({ id: numericMessageId, nickname: { [userId]: recallGroupNickname || operatorNickname || '用户' } });
        socketRecallContent = dbRecallContent;
        [insertResult] = await pool.execute(
          'INSERT INTO scr_messages (user_id, group_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
          [userId, message.group_id, dbRecallContent, 101]
        );
      } else {
        dbRecallContent = String(numericMessageId);
        socketRecallContent = dbRecallContent;
        [insertResult] = await pool.execute(
          'INSERT INTO scr_messages (user_id, content, message_type, timestamp) VALUES (?, ?, ?, NOW())',
          [userId, dbRecallContent, 101]
        );
      }

      // 撤回(101)消息同样推进缓存
      if (message.group_id) {
        redisClient.set(`scr:max_msg_id:group:${parseInt(message.group_id)}`, String(insertResult.insertId)).catch(() => {});
      } else {
        redisClient.set('scr:max_msg_id:global', String(insertResult.insertId)).catch(() => {});
      }

      // 发送101消息
      const rawType101Message = {
        id: insertResult.insertId,
        userId: userId,
        nickname: operatorNickname,
        avatarUrl: operatorAvatarUrl,
        content: socketRecallContent,
        messageType: 101,
        groupId: message.group_id || null,
        timestamp: Date.now(),
        timestampISO: new Date().toISOString()
      };

      // 群组撤回：加上群昵称
      if (recallGroupNickname) {
        rawType101Message.groupNickname = recallGroupNickname;
      }
      
      // 根据消息类型过滤字段
      const messageTypeStr = message.group_id ? 'group' : 'public';
      const type101Message = filterMessageFields(rawType101Message, messageTypeStr);
      
      // 发送确认事件给发送者
      socket.emit(SocketEvents.MESSAGE_SENT, { messageId: type101Message.id, message: type101Message });
      
      // 广播类型101消息给其他用户（发送者已通过上方确认事件立即接收，这里异步入队广播）
      if (message.group_id) {
        // 群组消息：向群组房间入队广播（排除发送者）
        await broadcastProducer.enqueue(`group_${message.group_id}`, SocketEvents.MESSAGE_RECEIVED, type101Message, socket.id);
      } else {
        // 公共消息：全局入队广播（发送者通过确认事件接收）
        await broadcastProducer.enqueue('authenticated_users', SocketEvents.MESSAGE_RECEIVED, type101Message, socket.id);
      }
      
    } catch (err) {
      console.error('删除消息失败:', err.message);
      socket.emit(SocketEvents.ERROR, { message: '删除消息失败' });
    }
  });

  // 消息已读事件（支持私信和群组）
  socket.on(SocketEvents.MESSAGE_READ, async (data) => {
    try {
      if (!data) {
        return;
      }
      
      const { type, userId, friendId, groupId } = data;
      
      // 验证必需参数
      if (!type || !userId) {
        return;
      }
      
      // 速率限制检查
      const rateLimitResult = await checkRateLimit(userId);
      if (!rateLimitResult.allowed) {
        socket.emit(SocketEvents.ERROR, { 
          message: `操作过于频繁，请${rateLimitResult.retryAfter}秒后再试`
        });
        return;
      }
      
      const numericUserId = parseInt(userId);
      if (isNaN(numericUserId)) {
        return;
      }
      
      if (type === 'private') {
        if (!friendId) {
          return;
        }
        
        const numericFriendId = parseInt(friendId);
        if (isNaN(numericFriendId)) {
          return;
        }
        
        // 处理私信已读
        // 更新数据库中对方发给自己的未读消息为已读
        await pool.execute(
          'UPDATE scr_private_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
          [numericFriendId, numericUserId]
        );
        
        // 发送已读事件给对方
        io.to(`user_${numericFriendId}`).emit(SocketEvents.PRIVATE_MESSAGE_READ, {
          fromUserId: numericUserId,
          friendId: numericFriendId
        });
        
        // 检查对方是否在线
        const allOnlineUsers = await getAllOnlineUsers();
        const friendIsOnline = allOnlineUsers.some(u => u.id === numericFriendId);
        
        if (!friendIsOnline) {
          // 对方不在线，保存已读回执消息（103）到数据库
          
          // 获取刚才已读的最后一条消息的id作为内容
          // 优先走 Redis 缓存（私信发送路径写入），未命中才回源 DB 一次
          let lastReadMessageId = 0;
          try {
            const cachedMax = await redisClient.get(`scr:priv:max_from:${numericUserId}:${numericFriendId}`);
            if (cachedMax != null) {
              lastReadMessageId = parseInt(cachedMax) || 0;
            } else {
              const [readMessages] = await pool.execute(
                'SELECT id FROM scr_private_messages WHERE sender_id = ? AND receiver_id = ? AND is_read = 1 ORDER BY id DESC LIMIT 1',
                [numericFriendId, numericUserId]
              );
              lastReadMessageId = readMessages[0]?.id || 0;
              if (lastReadMessageId > 0) {
                redisClient.set(
                  `scr:priv:max_from:${numericUserId}:${numericFriendId}`,
                  String(lastReadMessageId),
                  { EX: 604800 }
                ).catch(() => {});
              }
            }
          } catch (readIdErr) {
            console.error('获取最后已读消息id失败:', readIdErr.message);
            lastReadMessageId = 0;
          }
          
          // 保存已读回执消息（103）到数据库
          const [insertResult] = await pool.execute(
            'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp, is_read) VALUES (?, ?, ?, ?, NOW(), 1)',
            [numericUserId, numericFriendId, String(lastReadMessageId), 103]
          );
          
          // 发送类型103消息给对方（虽然不在线，但可能重连后会收到历史消息）
          const rawType103Message = {
            id: insertResult.insertId,
            userId: numericUserId,
            nickname: '',
            avatarUrl: '',
            senderId: numericUserId,
            receiverId: numericFriendId,
            content: String(lastReadMessageId),
            messageType: 103,
            isRead: 1,
            timestamp: Date.now(),
            timestampISO: new Date().toISOString()
          };
          
          // 过滤私信消息字段
          const type103Message = filterMessageFields(rawType103Message, 'private');
          
          io.to(`user_${numericFriendId}`).emit(SocketEvents.PRIVATE_MESSAGE_RECEIVED, type103Message);
        }
        
      } else if (type === 'group') {
        if (!groupId) {
          return;
        }
        
        // 处理群组已读（预留，后续实现）
        const numericGroupId = parseInt(groupId);
        if (isNaN(numericGroupId)) {
          return;
        }
      } else {
        return;
      }
      
    } catch (err) {
      console.error('❌ 处理消息已读事件失败:', err.message);
      console.error('❌ 错误详情:', err);
    }
  });

  // 统一加载消息事件（支持全局、群组、私信）
  socket.on(SocketEvents.LOAD_MESSAGES, async (data) => {
    try {
      const { type, userId, sessionToken, limit = 20, olderThan, groupId, friendId, loadMore = false } = data;
      
      let messages = [];
      const numericUserId = parseInt(userId);
      let responseData = { type, messages: [], loadMore: loadMore };
      
      if (type === 'global') {
        const [loadedMessages, [groupMessages], [privateMessages]] = await Promise.all([
          getGlobalMessages(limit, olderThan || null, numericUserId),
          pool.execute(
            `SELECT m.group_id, MAX(m.timestamp) as last_time
             FROM scr_messages m
             INNER JOIN scr_group_members gm
               ON gm.group_id = m.group_id
              AND gm.user_id = ?
              AND gm.deleted_at IS NULL
             WHERE m.group_id IS NOT NULL
             GROUP BY m.group_id`,
            [numericUserId]
          ),
          pool.execute(
            'SELECT sender_id, receiver_id, MAX(timestamp) as last_time FROM scr_private_messages WHERE sender_id = ? OR receiver_id = ? GROUP BY sender_id, receiver_id',
            [numericUserId, numericUserId]
          )
        ]);
        messages = loadedMessages;

        const groupLastMessageTimes = {};
        groupMessages.forEach(msg => {
          if (msg.last_time) {
            groupLastMessageTimes[msg.group_id] = msg.last_time;
          }
        });

        const privateLastMessageTimes = {};
        privateMessages.forEach(msg => {
          const otherUserId = String(msg.sender_id) === String(numericUserId) ? msg.receiver_id : msg.sender_id;
          if (!privateLastMessageTimes[otherUserId] || new Date(msg.last_time) > new Date(privateLastMessageTimes[otherUserId])) {
            privateLastMessageTimes[otherUserId] = msg.last_time;
          }
        });
        
        responseData.messages = messages.reverse();
        responseData.groupLastMessageTimes = groupLastMessageTimes;
        responseData.privateLastMessageTimes = privateLastMessageTimes;
        socket.emit(SocketEvents.MESSAGES_LOADED, responseData);
      } else if (type === 'group') {
        // 加载群组消息 - 完全复刻 group-chat-history 事件
        const numericGroupId = parseInt(groupId);
        
        // 验证用户是否在群组中
        const [memberCheck] = await pool.query(
          'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
          [numericGroupId, numericUserId]
        );
        
        if (memberCheck.length === 0) {
          socket.emit(SocketEvents.ERROR, { message: '您不在该群组中，无法查看聊天记录' });
          return;
        }
        
        // 获取群组消息
        if (loadMore && olderThan) {
          messages = await getGroupMessages(numericGroupId, limit, olderThan, numericUserId);
        } else {
          // 直接从数据库获取最新消息
          messages = await getGroupMessages(numericGroupId, limit, null, numericUserId);
        }
        
        responseData.messages = messages.reverse();
        responseData.groupId = numericGroupId;
        socket.emit(SocketEvents.MESSAGES_LOADED, responseData);
      } else if (type === 'private') {
        // 加载私信消息 - 完全复刻 private-chat-history 事件
        const numericFriendId = parseInt(friendId);
        
        // 验证对方是否是自己的好友
        const [friendCheck] = await pool.query(
          'SELECT id FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status = 1',
          [numericUserId, numericFriendId]
        );
        
        if (friendCheck.length === 0) {
          socket.emit(SocketEvents.ERROR, { message: '对方不是您的好友，无法查看聊天记录' });
          return;
        }
        
        let query = `
          SELECT p.id, p.sender_id as senderId, p.receiver_id as receiverId, 
                 p.content, p.at_userid, p.message_type as messageType, p.is_read as isRead, p.timestamp,
                 u1.nickname as senderNickname, u1.avatar_url as senderAvatarUrl,
                 u2.nickname as receiverNickname, u2.avatar_url as receiverAvatarUrl
          FROM scr_private_messages p
          JOIN scr_users u1 ON p.sender_id = u1.id
          JOIN scr_users u2 ON p.receiver_id = u2.id
          WHERE ((p.sender_id = ? AND p.receiver_id = ?) OR (p.sender_id = ? AND p.receiver_id = ?))`;
        
        const params = [numericUserId, numericFriendId, numericFriendId, numericUserId];
        
        if (loadMore) {
          const olderThanNum = parseInt(olderThan);
          if (!isNaN(olderThanNum)) {
            query += ' AND p.id < ?';
            params.push(olderThanNum);
          }
        }
        
        const safeLimit = parseInt(limit);
        const finalLimit = isNaN(safeLimit) ? 20 : safeLimit;
        query += ' ORDER BY p.timestamp DESC, p.id DESC LIMIT ?';
        params.push(finalLimit);
        
        const [results] = await pool.query(query, params);
        
        messages = results.map(msg => {
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
          const message = {
            id: msg.id,
            senderId: msg.senderId,
            receiverId: msg.receiverId,
            senderNickname: msg.senderNickname,
            senderAvatarUrl: msg.senderAvatarUrl,
            receiverNickname: msg.receiverNickname,
            receiverAvatarUrl: msg.receiverAvatarUrl,
            content: msg.content,
            at_userid: atUserIds,
            messageType: msg.messageType,
            isRead: msg.isRead || 0,
            timestamp: new Date(msg.timestamp).getTime(),
            timestampISO: new Date(msg.timestamp).toISOString()
          };
          
          if (msg.messageType === 1 && msg.content) {
            try {
              const contentData = JSON.parse(msg.content);
              if (contentData.url) {
                message.imageUrl = contentData.url;
              }
            } catch (error) {
              console.error(`解析图片消息失败: 消息ID=${msg.id}, 错误=${error.message}`);
            }
          }
          
          return message;
        });
        
        responseData.messages = messages.reverse();
        responseData.friendId = numericFriendId;
        socket.emit(SocketEvents.MESSAGES_LOADED, responseData);
      } else {
        socket.emit(SocketEvents.ERROR, { message: '无效的消息类型' });
      }
    } catch (err) {
      console.error('❌ 加载消息失败:', err.message);
      socket.emit(SocketEvents.ERROR, { message: '加载消息失败', error: err.message });
    }
  });

  // 清除群组未读计数
  socket.on(SocketEvents.CLEAR_GROUP_UNREAD, async (data) => {
    try {
      const { userId, groupId } = data || {};
      if (!userId || !groupId) return;

      const numericUserId = parseInt(userId);
      const numericGroupId = parseInt(groupId);
      if (isNaN(numericUserId) || isNaN(numericGroupId)) return;

      // 最新消息ID走 Redis 缓存（发消息/撤回路径写入），缓存未命中才回源 DB 一次
      // 前端已按 10s 轮询批量发送，此 handler 不能再承担每包一次的 MAX(id) 全表/索引查询
      const cacheKey = `scr:max_msg_id:group:${numericGroupId}`;
      let maxMessageId = await redisClient.get(cacheKey);
      if (maxMessageId == null) {
        const [rows] = await dbPool.execute(
          'SELECT MAX(id) as maxId FROM scr_messages WHERE group_id = ?',
          [numericGroupId]
        );
        maxMessageId = String(rows[0]?.maxId || 0);
        await redisClient.set(cacheKey, maxMessageId);
      }

      await redisClient.set(`scr:read:group:${numericGroupId}:${numericUserId}`, String(maxMessageId));
    } catch (err) {
      console.error('清除群组未读计数失败:', err.message);
    }
  });

  // 清除主聊天室未读计数
  socket.on(SocketEvents.CLEAR_GLOBAL_UNREAD, async (data) => {
    try {
      const { userId } = data || {};
      if (!userId) return;

      const numericUserId = parseInt(userId);
      if (isNaN(numericUserId)) return;

      // 最新消息ID走 Redis 缓存（发消息/撤回路径写入），缓存未命中才回源 DB 一次
      const cacheKey = 'scr:max_msg_id:global';
      let maxMessageId = await redisClient.get(cacheKey);
      if (maxMessageId == null) {
        const [rows] = await dbPool.execute(
          'SELECT MAX(id) as maxId FROM scr_messages WHERE group_id IS NULL',
          []
        );
        maxMessageId = String(rows[0]?.maxId || 0);
        await redisClient.set(cacheKey, maxMessageId);
      }

      await redisClient.set(`scr:read:global:${numericUserId}`, String(maxMessageId));
    } catch (err) {
      console.error('清除主聊天室未读计数失败:', err.message);
    }
  });
}

import { SocketEvents } from '../events.js';
import path from 'path';
import fs from 'fs';
import { redisClient } from '../../models/database.js';
import {
  normalizeClientMsgId,
  isIdempotencyReady,
  findExistingPrivateMessage,
  buildReplayPrivateMessage,
  isDuplicateKeyError
} from '../../utils/messageIdempotency.js';

export function registerPrivateHandlers(socket, io, { pool, checkRateLimit, validateMessageContent, filterMessageFields, getAllOnlineUsers, broadcastProducer }) {
  
  // 发送私信
  socket.on(SocketEvents.SEND_PRIVATE_MESSAGE, async (messageData) => {
    try {
      const { userId, content, receiverId, sessionToken, at_userid, clientMsgId: rawClientMsgId } = messageData;

      // clientMsgId 是重发幂等键：同一发送者下唯一，落库时写进 client_msg_id。
      const clientMsgId = normalizeClientMsgId(rawClientMsgId);

      // 与群聊 send-message 对齐：所有 private-message-sent 回执原样回带 clientMsgId，
      // 前端靠它把回执与本地「发送中」气泡一一对应。
      const ack = (payload) => socket.emit(SocketEvents.PRIVATE_MESSAGE_SENT, {
        ...payload,
        clientMsgId: clientMsgId || null
      });

      // 速率限制检查
      const rateLimitResult = await checkRateLimit(userId);
      if (!rateLimitResult.allowed) {
        // 通过 private-message-sent 事件返回速率限制错误
        ack({ 
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `发送消息过于频繁，请${rateLimitResult.retryAfter}秒后再试`,
            retryAfter: rateLimitResult.retryAfter
          }
        });
        return;
      }

      // 验证消息内容
      if (!validateMessageContent(content)) {
        ack({
          success: false,
          error: {
            code: 'INVALID_CONTENT',
            message: '消息内容格式错误或超过 10000 字符限制'
          }
        });
        return;
      }

      // 获取用户信息
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

      // 验证对方是否是自己的好友，并检查是否已删除
      const [friendCheck] = await pool.query(
        'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
        [parseInt(userId), parseInt(receiverId)]
      );

      if (friendCheck.length === 0) {
        ack({
          success: false,
          error: {
            code: 'NOT_FRIEND',
            message: '对方不是您的好友，无法发送消息'
          }
        });
        return;
      }

      // 检查好友关系状态（允许进入检查流程的状态：好友列表显示或可拉取历史消息的状态）
      const allowedStatuses = [0, 1, 4, 5, 6, 10, 11];
      if (!allowedStatuses.includes(friendCheck[0].status)) {
        ack({
          success: false,
          error: {
            code: 'INVALID_FRIEND_STATUS',
            message: '好友关系状态异常，无法发送消息'
          }
        });
        return;
      }

      // 检查是否被拉黑、被删除、双向拉黑等禁止发送消息的状态
      const blockedStatuses = [0, 5, 10, 11];
      if (blockedStatuses.includes(friendCheck[0].status)) {
        let blockMessage = '';
        switch (friendCheck[0].status) {
          case 5:
            blockMessage = '你已被对方拉黑，无法发送消息';
            break;
          case 0:
            blockMessage = '该好友关系已被删除，无法发送消息';
            break;
          case 10:
            blockMessage = '你们已互相拉黑，无法发送消息';
            break;
          case 11:
            blockMessage = '你们曾互相拉黑并删除，无法发送消息';
            break;
          default:
            blockMessage = '无法发送消息';
        }
        ack({
          success: false,
          error: {
            code: 'FRIEND_BLOCKED_OR_DELETED',
            message: blockMessage
          }
        });
        return;
      }

      // 不进行严格转义，保持原始内容格式，让前端处理安全的解析和链接显示
      const cleanContent = content;

      // 获取当前精确时间戳（毫秒级和ISO格式）
      const now = new Date();
      const timestamp = now.toISOString();
      const timestampMs = now.getTime();

      // 插入私信到数据库
      const messageType = messageData.message_type || messageData.messageType || 0;

      const messageContent = cleanContent;

      // 私聊没有「@全体」语义：at_userid 只保留真实用户 id，
      // 客户端塞进来的 -1（群聊 @全体 哨兵值）在私聊里会被剔除，
      // 避免私聊出现假的「@所有人」气泡/提示。
      const sanitizedAtUserid = Array.isArray(at_userid)
        ? at_userid.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : null;
      const atUseridPayload = sanitizedAtUserid && sanitizedAtUserid.length > 0
        ? JSON.stringify(sanitizedAtUserid)
        : null;

      // 幂等：同一 clientMsgId 已经落库（首包成功但回执丢了，前端重发）时，
      // 直接回首包那条消息，不再插第二条，也不再广播一次。
      // 存量库未执行 DDL（client_msg_id 列不存在）时自动降级为「不写幂等键」。
      const idempotencyReady = clientMsgId ? await isIdempotencyReady('scr_private_messages', pool) : false;

      if (clientMsgId && idempotencyReady) {
        const existing = await findExistingPrivateMessage(pool, userId, clientMsgId);
        if (existing) {
          const replayMessage = filterMessageFields(
            buildReplayPrivateMessage(existing, user),
            'private'
          );
          replayMessage.clientMsgId = clientMsgId;
          ack({ success: true, messageId: Number(existing.id), message: replayMessage, duplicate: true });
          return;
        }
      }

      let result;
      try {
        // 存量库未执行 DDL 时不写 client_msg_id（否则列不存在会直接报错）
        const insertSql = idempotencyReady
          ? 'INSERT INTO scr_private_messages (sender_id, receiver_id, content, at_userid, message_type, is_read, client_msg_id, timestamp) VALUES (?, ?, ?, ?, ?, 0, ?, NOW())'
          : 'INSERT INTO scr_private_messages (sender_id, receiver_id, content, at_userid, message_type, is_read, timestamp) VALUES (?, ?, ?, ?, ?, 0, NOW())';
        const insertParams = idempotencyReady
          ? [userId, receiverId, messageContent, atUseridPayload, messageType, clientMsgId]
          : [userId, receiverId, messageContent, atUseridPayload, messageType];
        const [insertResult] = await pool.execute(insertSql, insertParams);
        result = { insertId: insertResult.insertId };
      } catch (insertErr) {
        // 并发重发撞唯一索引：同样按幂等处理，回首包那条
        if (clientMsgId && idempotencyReady && isDuplicateKeyError(insertErr)) {
          const existing = await findExistingPrivateMessage(pool, userId, clientMsgId);
          if (existing) {
            const replayMessage = filterMessageFields(
              buildReplayPrivateMessage(existing, user),
              'private'
            );
            replayMessage.clientMsgId = clientMsgId;
            ack({ success: true, messageId: Number(existing.id), message: replayMessage, duplicate: true });
            return;
          }
        }
        throw insertErr;
      }

      // 同步"对方收到的我的最大消息id"缓存，供 message-read 已读回执使用（消除每次已读的 DB 查询）
      // 每个会话方向一个键，7 天 TTL 自动回收；fire-and-forget，失败不影响消息发送
      if (messageType < 101) {
        redisClient.set(
          `scr:priv:max_from:${parseInt(receiverId)}:${parseInt(userId)}`,
          String(result.insertId),
          { EX: 604800 }
        ).catch(() => {});
      }

      // 构建私信消息对象
      const rawMessage = {
        id: result.insertId,
        userId: userId,
        nickname: user.nickname,
        avatarUrl: user.avatar_url,
        senderId: userId,
        receiverId: parseInt(receiverId),
        content: messageContent,
        atUserid: sanitizedAtUserid,
        messageType: messageType,
        isRead: 0,
        timestamp: timestampMs,
        timestampISO: timestamp
      };

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
      
      // 过滤私信消息字段
      const newMessage = filterMessageFields(rawMessage, 'private');

      // 确认私信已发送，只给发送者发送确认事件（不再发送 private-message-received 给发送者）
      ack({ success: true, messageId: result.insertId, message: newMessage, duplicate: false });

      // 发送私信给接收者：走 Redis Streams 分片扇出（room=user_<id>），
      // 不在 socket.on 里直接 io.to(...).emit，保证多进程各自只投递本地连接。
      if (broadcastProducer) {
        try {
          await broadcastProducer.enqueue(
            `user_${parseInt(receiverId)}`,
            SocketEvents.PRIVATE_MESSAGE_RECEIVED,
            newMessage
          );
        } catch (fanoutErr) {
          console.error('私信扇出失败:', fanoutErr.message);
        }
      }

    } catch (err) {
      console.error('❌ 保存私信失败:', err.message);
      socket.emit(SocketEvents.ERROR, { message: '发送私信失败' });
    }
  });
  
  // 撤回私信消息
  socket.on(SocketEvents.DELETE_PRIVATE_MESSAGE, async (data) => {
    try {
      const { userId, messageId, sessionToken } = data;
      
      // 速率限制检查
      const rateLimitResult = await checkRateLimit(userId);
      if (!rateLimitResult.allowed) {
        socket.emit(SocketEvents.PRIVATE_MESSAGE_SENT, { 
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `撤回消息过于频繁，请${rateLimitResult.retryAfter}秒后再试`,
            retryAfter: rateLimitResult.retryAfter
          }
        });
        return;
      }
      
      // 获取消息详情
      const [messages] = await pool.execute(
        'SELECT id, sender_id, receiver_id, content, message_type FROM scr_private_messages WHERE id = ?',
        [messageId]
      );
      
      if (messages.length === 0) {
        socket.emit(SocketEvents.ERROR, { message: '消息不存在' });
        return;
      }
      
      const message = messages[0];
      const numericUserId = parseInt(userId);
      
      // 检查是否是消息发送者
      if (numericUserId !== message.sender_id) {
        console.error('❌ 只有消息发送者才能撤回消息:', { userId: numericUserId, senderId: message.sender_id });
        socket.emit(SocketEvents.ERROR, { message: '只有消息发送者才能撤回消息' });
        return;
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
      
      // 将messageId转换为数字类型
      const numericMessageId = parseInt(messageId);
      
      // 查询操作者（发送撤回请求的用户）的昵称和头像
      const [operatorInfo] = await pool.execute(
        'SELECT nickname, avatar_url FROM scr_users WHERE id = ?',
        [numericUserId]
      );
      const operatorNickname = operatorInfo[0]?.nickname || '未知用户';
      const operatorAvatarUrl = operatorInfo[0]?.avatar_url || '';
      
      // 构建撤回提示内容（使用操作者昵称，纯文本格式）
      const recallContent = `${operatorNickname}撤回了一条消息`;
      
      // 更新原数据库记录（只修改内容为纯文本，不修改messageType）
      await pool.execute(
        'UPDATE scr_private_messages SET content = ? WHERE id = ?',
        [recallContent, messageId]
      );
      
      // 单独生成一条简单的101消息（只包含被撤回消息ID）
      const [insertResult] = await pool.execute(
        'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [numericUserId, message.receiver_id, String(numericMessageId), 101]
      );
      
      // 发送简单格式的101消息（content只是被撤回消息ID）
      const rawType101Message = {
        id: insertResult.insertId,  // 101消息自己的ID
        userId: numericUserId,
        nickname: operatorNickname,
        avatarUrl: operatorAvatarUrl,
        senderId: numericUserId,
        receiverId: message.receiver_id,
        content: String(numericMessageId),  // 只包含被撤回消息ID
        messageType: 101,
        timestamp: Date.now(),
        timestampISO: new Date().toISOString()
      };
      
      // 过滤私信消息字段
      const type101Message = filterMessageFields(rawType101Message, 'private');
      
      // 发送确认事件给发送者
      socket.emit(SocketEvents.PRIVATE_MESSAGE_SENT, { messageId: type101Message.id, message: type101Message });
      
      // 只给接收者发送消息接收事件（Redis Streams 分片扇出，不直接 io.to）
      if (broadcastProducer) {
        await broadcastProducer.enqueue(
          `user_${message.receiver_id}`,
          SocketEvents.PRIVATE_MESSAGE_RECEIVED,
          type101Message
        );
      }
      
    } catch (err) {
      console.error('❌ 撤回私信失败:', err.message);
      console.error('❌ 错误详情:', err);
      socket.emit(SocketEvents.ERROR, { message: '撤回私信失败', error: err.message });
    }
  });
}

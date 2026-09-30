import { pool, redisClient } from '../models/database.js';
import { filterMessageFields } from '../utils/messageFilters.js';

export async function handleGetFriends(req, res, io) {
  try {
    const userId = parseInt(req.userId);

    const [friends] = await pool.execute(`
      SELECT cu.id, cu.nickname, cu.username, cu.gender, cu.avatar_url, cf.status, cf.remark, cf.is_disturb
      FROM scr_friends cf
      JOIN scr_users cu ON cf.friend_id = cu.id
      WHERE cf.user_id = ? AND cf.status IN (1, 0, 4, 5, 6, 10, 11)
      ORDER BY cf.id DESC
    `, [userId]);

    res.json({
      status: 'success',
      friends: friends,
      message: '获取好友列表成功'
    });
  } catch (err) {
    console.error('获取好友列表失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取好友列表失败' });
  }
}

export async function handleSetFriendVerification(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { requireVerification } = req.body;

    if (typeof requireVerification !== 'boolean') {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    await pool.execute(
      'UPDATE scr_users SET friend_verification = ? WHERE id = ?',
      [requireVerification ? 1 : 0, userId]
    );

    res.json({
      status: 'success',
      message: requireVerification ? '已开启好友验证' : '已关闭好友验证'
    });
  } catch (err) {
    console.error('设置好友验证失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置好友验证失败' });
  }
}

export async function handleGetFriendRequests(req, res, io) {
  try {
    const userId = parseInt(req.userId);

    const [receivedRequests] = await pool.execute(`
      SELECT cu.id, cu.nickname, cu.username, cu.avatar_url, cf.created_at, cf.status
      FROM scr_friends cf
      JOIN scr_users cu ON cf.friend_id = cu.id
      WHERE cf.user_id = ? AND cf.status IN (3, 7, 14)
      ORDER BY cf.created_at DESC
    `, [userId]);

    // 为收到的请求获取留言
    const enrichedReceived = await Promise.all(receivedRequests.map(async (req) => {
      const msg = await redisClient.get(`friend_request_msg:${userId}:${req.id}`);
      return { ...req, request_message: msg || '' };
    }));

    const [sentRequests] = await pool.execute(`
      SELECT cu.id, cu.nickname, cu.username, cu.avatar_url, cf.created_at, cf.status
      FROM scr_friends cf 
      JOIN scr_users cu ON cf.friend_id = cu.id 
      WHERE cf.user_id = ? AND cf.status IN (2, 8, 13)
      ORDER BY cf.created_at DESC
    `, [userId]);

    res.json({
      status: 'success',
      received: enrichedReceived,
      sent: sentRequests
    });
  } catch (err) {
    console.error('获取好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取好友请求失败' });
  }
}

export async function handleGetReceivedFriendRequests(req, res, io) {
  try {
    const userId = parseInt(req.userId);

    const [requests] = await pool.execute(`
      SELECT cu.id, cu.nickname, cu.username, cu.avatar_url, cf.created_at, cf.status
      FROM scr_friends cf
      JOIN scr_users cu ON cf.friend_id = cu.id
      WHERE cf.user_id = ? AND cf.status IN (3, 7, 14)
      ORDER BY cf.created_at DESC
    `, [userId]);

    // 为每个收到的请求获取留言
    const enrichedRequests = await Promise.all(requests.map(async (req) => {
      const msg = await redisClient.get(`friend_request_msg:${userId}:${req.id}`);
      return { ...req, request_message: msg || '' };
    }));

    res.json({
      status: 'success',
      requests: enrichedRequests
    });
  } catch (err) {
    console.error('获取好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取好友请求失败' });
  }
}

export async function handleGetSentFriendRequests(req, res, io) {
  try {
    const userId = parseInt(req.userId);

    const [requests] = await pool.execute(`
      SELECT cu.id, cu.nickname, cu.username, cu.avatar_url, cf.created_at, cf.status
      FROM scr_friends cf 
      JOIN scr_users cu ON cf.friend_id = cu.id 
      WHERE cf.user_id = ? AND cf.status IN (2, 8, 13)
      ORDER BY cf.created_at DESC
    `, [userId]);

    res.json({
      status: 'success',
      requests: requests
    });
  } catch (err) {
    console.error('获取发送的好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取发送的好友请求失败' });
  }
}

export async function handleAcceptFriendRequest(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { requesterId } = req.body;

    if (!requesterId || isNaN(requesterId)) {
      return res.status(400).json({ status: 'error', message: '请求者ID无效' });
    }

    const [myRecord] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status IN (3, 7, 14)',
      [userId, requesterId]
    );

    if (myRecord.length === 0) {
      return res.status(404).json({ status: 'error', message: '好友请求不存在' });
    }

    const myStatus = myRecord[0].status;

    const [requesterRecord] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [requesterId, userId]
    );

    const requesterStatus = requesterRecord.length > 0 ? requesterRecord[0].status : null;

    await pool.query('START TRANSACTION');
    
    try {
      if (myStatus === 7) {
        await pool.execute(
          'UPDATE scr_friends SET status = 5, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 7',
          [userId, requesterId]
        );

        if (requesterRecord.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 4, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [requesterId, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 4, NOW())',
            [requesterId, userId]
          );
        }
      } else if (requesterStatus === 8) {
        await pool.execute(
          'UPDATE scr_friends SET status = 5, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 8',
          [requesterId, userId]
        );

        await pool.execute(
          'UPDATE scr_friends SET status = 4, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 3',
          [userId, requesterId]
        );
      } else if (myStatus === 14 || requesterStatus === 13) {
        await pool.execute(
          'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (3, 7, 14)',
          [userId, requesterId]
        );

        if (requesterRecord.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (2, 8, 13)',
            [requesterId, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 10, NOW())',
            [requesterId, userId]
          );
        }
      } else {
        const mutualStainStatuses = [11, 12];
        const hasMutualStain = mutualStainStatuses.includes(requesterStatus);

        if (hasMutualStain) {
          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (3, 7)',
            [userId, requesterId]
          );

          if (requesterRecord.length > 0) {
            await pool.execute(
              'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (11, 12)',
              [requesterId, userId]
            );
          }

          await pool.execute(
            'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 1',
            [userId, requesterId]
          );
        } else {
          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (3, 7)',
            [userId, requesterId]
          );

          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status IN (2, 8)',
            [requesterId, userId]
          );
        }
      }

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );
    const [requesterInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [requesterId]
    );

    const now = new Date();

    // 从Redis读取好友申请留言
    const redisKey = `friend_request_msg:${userId}:${requesterId}`;
    const friendRequestMsg = await redisClient.get(redisKey);
    if (friendRequestMsg) {
      await redisClient.del(redisKey);
    }

    const addedContent = '你们已成为好友';

    const [insertResult] = await pool.execute(
      'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, requesterId, addedContent, 100]
    );

    // 如果有留言，自动以申请方身份发送留言内容作为私信
    let msgInsertId2 = null;
    if (friendRequestMsg) {
      const [msgResult] = await pool.execute(
        'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, 0, NOW())',
        [requesterId, userId, friendRequestMsg]
      );
      msgInsertId2 = msgResult.insertId;
    }

    const type100Message1 = {
      id: insertResult.insertId,
      userId: userId,
      nickname: userInfo[0]?.nickname || '',
      avatarUrl: userInfo[0]?.avatar_url || '',
      senderId: userId,
      receiverId: requesterId,
      content: addedContent,
      messageType: 100,
      isRead: 1,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    const type100Message2 = {
      ...type100Message1,
      isRead: 0
    };

    const filteredMsg1 = filterMessageFields(type100Message1, 'private');
    const filteredMsg2 = filterMessageFields(type100Message2, 'private');

    io.to(`user_${userId}`).emit('private-message-received', filteredMsg1);
    io.to(`user_${requesterId}`).emit('private-message-received', filteredMsg2);

    // 如果有留言，发送留言私信给双方
    if (friendRequestMsg && msgInsertId2) {
      const requesterNickname = requesterInfo[0]?.nickname || '用户';
      const requesterAvatar = requesterInfo[0]?.avatar_url || '';
      const msgForAcceptor = {
        id: msgInsertId2,
        userId: requesterId,
        nickname: requesterNickname,
        avatarUrl: requesterAvatar,
        senderId: requesterId,
        receiverId: userId,
        content: friendRequestMsg,
        messageType: 0,
        isRead: 0,
        timestamp: now.getTime() + 1,
        timestampISO: now.toISOString()
      };
      const msgForSender = {
        ...msgForAcceptor,
        id: msgInsertId2,
        isRead: 1
      };
      const filteredMsgForAcceptor = filterMessageFields(msgForAcceptor, 'private');
      const filteredMsgForSender = filterMessageFields(msgForSender, 'private');
      io.to(`user_${userId}`).emit('private-message-received', filteredMsgForAcceptor);
      // 申请方使用消息发送确认事件（不计入未读计数）
      io.to(`user_${requesterId}`).emit('private-message-sent', { messageId: msgInsertId2, message: filteredMsgForSender });
    }

    io.to(`user_${userId}`).emit('friend-added', { friendId: requesterId, timestamp: Date.now() });
    io.to(`user_${requesterId}`).emit('friend-added', { friendId: userId, timestamp: Date.now() });

    io.to(`user_${userId}`).emit('friend-requests-updated', {
      type: 'received',
      action: 'accepted',
      timestamp: Date.now()
    });

    io.to(`user_${requesterId}`).emit('friend-requests-updated', {
      type: 'sent',
      action: 'accepted',
      timestamp: Date.now()
    });

    res.json({ status: 'success', message: '已接受好友请求' });
  } catch (err) {
    console.error('接受好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '接受好友请求失败' });
  }
}

export async function handleRejectFriendRequest(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { requesterId } = req.body;

    if (!requesterId || isNaN(requesterId)) {
      return res.status(400).json({ status: 'error', message: '请求者ID无效' });
    }

    const requesterIdNum = parseInt(requesterId);

    const [myRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, requesterIdNum]
    );
    const [requesterRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [requesterIdNum, userId]
    );

    const myStatus = myRecord.length > 0 ? myRecord[0].status : null;
    const requesterStatus = requesterRecord.length > 0 ? requesterRecord[0].status : null;

    const stainStatuses = [0, 5, 7, 8, 9, 10, 11, 12, 13, 14];

    const singleStainRequestStatuses = [7, 8];

    const mutualStainRequestStatuses = [13, 14];

    const iHaveStain = myStatus !== null && stainStatuses.includes(myStatus);
    const requesterHasStain = requesterStatus !== null && stainStatuses.includes(requesterStatus);

    const isMutualStainRequest = singleStainRequestStatuses.includes(myStatus) || singleStainRequestStatuses.includes(requesterStatus) ||
                                  mutualStainRequestStatuses.includes(myStatus) || mutualStainRequestStatuses.includes(requesterStatus);

    if (mutualStainRequestStatuses.includes(myStatus) || mutualStainRequestStatuses.includes(requesterStatus)) {
      if (myRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
      }
      if (requesterRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
      }
    } else if (singleStainRequestStatuses.includes(myStatus) || singleStainRequestStatuses.includes(requesterStatus)) {
      if (singleStainRequestStatuses.includes(myStatus)) {
        if (requesterRecord.length > 0 && !stainStatuses.includes(requesterStatus)) {
          await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
        } else if (requesterRecord.length > 0 && stainStatuses.includes(requesterStatus)) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
        }

        if (myRecord.length > 0) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
        }
      } else if (singleStainRequestStatuses.includes(requesterStatus)) {
        if (myRecord.length > 0 && !stainStatuses.includes(myStatus)) {
          await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
        } else if (myRecord.length > 0 && stainStatuses.includes(myStatus)) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
        }

        if (requesterRecord.length > 0) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
        }
      }
    } else if (iHaveStain && requesterHasStain) {
      if (myRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
      }
      if (requesterRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
      }
    } else if (iHaveStain) {
      if (requesterRecord.length > 0) {
        await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
      }

      if (myRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
      } else {
        await pool.execute('INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 0, NOW())', [userId, requesterIdNum]);
      }
    } else if (requesterHasStain) {
      if (myRecord.length > 0) {
        await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [userId, requesterIdNum]);
      }

      if (requesterRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [requesterIdNum, userId]);
      } else {
        await pool.execute('INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 0, NOW())', [requesterIdNum, userId]);
      }
    } else {
      await pool.execute(
        'DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status IN (3, 7)',
        [userId, requesterIdNum]
      );
      await pool.execute(
        'DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status IN (2, 8)',
        [requesterIdNum, userId]
      );
    }

    io.to(`user_${userId}`).emit('friend-requests-updated', {
      type: 'received',
      action: 'rejected',
      timestamp: Date.now()
    });

    io.to(`user_${requesterIdNum}`).emit('friend-requests-updated', {
      type: 'sent',
      action: 'rejected',
      timestamp: Date.now()
    });

    io.to(`user_${requesterIdNum}`).emit('friend-request-rejected', {
      rejecterId: userId,
      timestamp: Date.now()
    });

    res.json({ status: 'success', message: '已拒绝好友请求' });
  } catch (err) {
    console.error('拒绝好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '拒绝好友请求失败' });
  }
}

export async function handleCancelFriendRequest(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { friendId } = req.body;

    if (!friendId || isNaN(friendId)) {
      return res.status(400).json({ status: 'error', message: '好友ID无效' });
    }

    const friendIdNum = parseInt(friendId);

    const [myRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, friendIdNum]
    );
    const [friendRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [friendIdNum, userId]
    );

    const validCancelStatuses = [2, 8, 13];
    if (myRecord.length === 0 || !validCancelStatuses.includes(myRecord[0].status)) {
      return res.status(404).json({ status: 'error', message: '未找到可撤销的好友请求' });
    }

    const myStatus = myRecord[0].status;
    const friendStatus = friendRecord.length > 0 ? friendRecord[0].status : null;

    const stainStatuses = [0, 5, 7, 8, 9, 10, 11, 12, 13, 14];

    const singleStainRequestStatuses = [7, 8];

    const mutualStainRequestStatuses = [13, 14];

    if (mutualStainRequestStatuses.includes(myStatus)) {
      await pool.execute('UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);

      if (friendRecord.length > 0) {
        await pool.execute('UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
      }
    } else if (singleStainRequestStatuses.includes(myStatus)) {
      await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);

      if (friendRecord.length > 0) {
        if (stainStatuses.includes(friendStatus)) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        } else {
          await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        }
      }
    } else {
      await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status IN (2, 8, 13)', [userId, friendIdNum]);
      await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status IN (3, 7, 14)', [friendIdNum, userId]);
    }

    io.to(`user_${userId}`).emit('friend-requests-updated', {
      type: 'sent',
      action: 'cancelled',
      timestamp: Date.now()
    });

    io.to(`user_${friendIdNum}`).emit('friend-requests-updated', {
      type: 'received',
      action: 'cancelled',
      timestamp: Date.now()
    });

    io.to(`user_${friendIdNum}`).emit('friend-request-cancelled', {
      cancellerId: userId,
      timestamp: Date.now()
    });

    res.json({ status: 'success', message: '已撤销好友请求' });
  } catch (err) {
    console.error('撤销好友请求失败:', err.message);
    res.status(500).json({ status: 'error', message: '撤销好友请求失败' });
  }
}

export async function handleAddFriend(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { friendId, message } = req.body;
    
    if (!friendId || isNaN(friendId)) {
      return res.status(400).json({ status: 'error', message: '好友ID无效' });
    }
    
    const friendIdNum = parseInt(friendId);
    
    if (userId === friendIdNum) {
      return res.status(400).json({ status: 'error', message: '不能添加自己为好友' });
    }
    
    const [users] = await pool.execute('SELECT id FROM scr_users WHERE id = ?', [friendIdNum]);
    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }
    
    // 获取当前用户昵称（用于默认留言）
    const [myUserInfo] = await pool.execute(
      'SELECT nickname FROM scr_users WHERE id = ?',
      [userId]
    );
    const myNickname = myUserInfo[0]?.nickname || '用户';
    
    const [targetUser] = await pool.execute(
      'SELECT friend_verification FROM scr_users WHERE id = ?',
      [friendIdNum]
    );
    
    const requireVerification = targetUser[0]?.friend_verification === 1;
    
    const [existingForward] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, friendIdNum]
    );

    const [existingReverse] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [friendIdNum, userId]
    );

    if ((existingForward.length > 0 && existingForward[0].status === 1) ||
        (existingReverse.length > 0 && existingReverse[0].status === 1)) {
      return res.status(400).json({ status: 'error', message: '已经是好友了' });
    }

    const myPendingRequest = existingForward.length > 0 && (existingForward[0].status === 2 || existingForward[0].status === 3);
    const theirPendingRequest = existingReverse.length > 0 && (existingReverse[0].status === 2 || existingReverse[0].status === 3);

    if (myPendingRequest && existingForward[0].status === 2) {
      return res.status(400).json({ status: 'error', message: '您已发送过好友请求，请等待对方接受' });
    }

    if (theirPendingRequest && existingReverse[0].status === 2) {
      if (requireVerification) {
        return res.json({
          status: 'success',
          message: '对方已向您发送好友请求，请在好友请求列表中处理',
          hasPendingRequest: true,
          requestDirection: 'received',
          needAction: 'accept_or_reject'
        });
      }
    }
    
    await pool.query('START TRANSACTION');

    try {
      if (requireVerification) {
        const singleStainStatuses = [0, 4, 5, 7, 8, 9];

        const mutualStainStatuses = [10, 11, 12];

        const allStainStatuses = [...singleStainStatuses, ...mutualStainStatuses];

        const hasHistoryStain = (existingForward.length > 0 && allStainStatuses.includes(existingForward[0].status)) ||
                                 (existingReverse.length > 0 && allStainStatuses.includes(existingReverse[0].status));

        const hasMutualStain = (existingForward.length > 0 && mutualStainStatuses.includes(existingForward[0].status)) ||
                                (existingReverse.length > 0 && mutualStainStatuses.includes(existingReverse[0].status));

        if (hasHistoryStain) {
          const myStatusIsStain = existingForward.length > 0 && allStainStatuses.includes(existingForward[0].status);
          const theirStatusIsStain = existingReverse.length > 0 && allStainStatuses.includes(existingReverse[0].status);

          const myStatusIsMutualStain = existingForward.length > 0 && mutualStainStatuses.includes(existingForward[0].status);
          const theirStatusIsMutualStain = existingReverse.length > 0 && mutualStainStatuses.includes(existingReverse[0].status);

          if (hasMutualStain) {
            if (myStatusIsStain) {
              if (existingForward.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 13, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [userId, friendIdNum]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 13, NOW())',
                  [userId, friendIdNum]
                );
              }

              if (existingReverse.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 14, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [friendIdNum, userId]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 14, NOW())',
                  [friendIdNum, userId]
                );
              }
            } else {
              if (existingForward.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 13, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [userId, friendIdNum]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 13, NOW())',
                  [userId, friendIdNum]
                );
              }

              if (existingReverse.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 14, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [friendIdNum, userId]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 14, NOW())',
                  [friendIdNum, userId]
                );
              }
            }
          } else {
            if (myStatusIsStain) {
              if (existingForward.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 8, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [userId, friendIdNum]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 8, NOW())',
                  [userId, friendIdNum]
                );
              }

              if (existingReverse.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 3, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [friendIdNum, userId]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 3, NOW())',
                  [friendIdNum, userId]
                );
              }
            } else if (theirStatusIsStain) {
              if (existingForward.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 2, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [userId, friendIdNum]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 2, NOW())',
                  [userId, friendIdNum]
                );
              }

              if (existingReverse.length > 0) {
                await pool.execute(
                  'UPDATE scr_friends SET status = 7, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
                  [friendIdNum, userId]
                );
              } else {
                await pool.execute(
                  'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 7, NOW())',
                  [friendIdNum, userId]
                );
              }
            }
          }

          await pool.query('COMMIT');

          io.to(`user_${friendIdNum}`).emit('friend-request-received', {
            requesterId: userId,
            timestamp: Date.now()
          });

          io.to(`user_${userId}`).emit('friend-request-sent', {
            friendId: friendIdNum,
            timestamp: Date.now()
          });

          // 存储留言到Redis
          const finalMessage = message || `我是${myNickname}`;
          await redisClient.set(`friend_request_msg:${friendIdNum}:${userId}`, finalMessage, 'EX', 7 * 24 * 60 * 60);

          res.json({
            status: 'success',
            message: '已发送好友申请，等待对方接受',
            needVerification: true
          });
          return;
        }

        if (existingForward.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 2, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [userId, friendIdNum]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 2, NOW())',
            [userId, friendIdNum]
          );
        }

        if (existingReverse.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 3, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [friendIdNum, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 3, NOW())',
            [friendIdNum, userId]
          );
        }

        await pool.query('COMMIT');

        io.to(`user_${friendIdNum}`).emit('friend-request-received', {
          requesterId: userId,
          timestamp: Date.now()
        });

        io.to(`user_${userId}`).emit('friend-requests-updated', {
          type: 'sent',
          timestamp: Date.now()
        });

        io.to(`user_${friendIdNum}`).emit('friend-requests-updated', {
          type: 'received',
          timestamp: Date.now()
        });

        // 存储留言到Redis
        const finalMessage = message || `我是${myNickname}`;
        await redisClient.set(`friend_request_msg:${friendIdNum}:${userId}`, finalMessage, 'EX', 7 * 24 * 60 * 60);

        res.json({
          status: 'success',
          message: '已发送好友申请，等待对方接受',
          needVerification: true
        });
      } else {
        const allStainStatuses = [0, 4, 5, 7, 8, 9, 10, 11, 12];

        const hasAnyStain = (existingForward.length > 0 && allStainStatuses.includes(existingForward[0].status)) ||
                             (existingReverse.length > 0 && allStainStatuses.includes(existingReverse[0].status));

        if (hasAnyStain) {
          const myOriginalStatus = existingForward.length > 0 ? existingForward[0].status : null;
          const theirOriginalStatus = existingReverse.length > 0 ? existingReverse[0].status : null;

          const blockedStatuses = [0, 5];

          const mutualStainStatuses = [10, 11, 12];

          const blockingStatus = 4;

          let myNewStatus, theirNewStatus;

          const iHaveMutualStain = mutualStainStatuses.includes(myOriginalStatus);
          const theyHaveMutualStain = mutualStainStatuses.includes(theirOriginalStatus);

          if (iHaveMutualStain || theyHaveMutualStain) {
            if (myOriginalStatus === 12 || theirOriginalStatus === 12) {
              myNewStatus = 10;
              theirNewStatus = 10;
            } else if (myOriginalStatus === 11 || theirOriginalStatus === 11) {
              myNewStatus = 10;
              theirNewStatus = 10;
            } else {
              myNewStatus = 10;
              theirNewStatus = 10;
            }
          } else if (myOriginalStatus === blockingStatus && theirOriginalStatus === blockingStatus) {
            myNewStatus = 10;
            theirNewStatus = 10;
          } else if (blockedStatuses.includes(myOriginalStatus)) {
            myNewStatus = 5;
            theirNewStatus = 4;
          } else if (blockedStatuses.includes(theirOriginalStatus)) {
            myNewStatus = 4;
            theirNewStatus = 5;
          } else {
            myNewStatus = 4;
            theirNewStatus = 5;
          }

          if (existingForward.length > 0) {
            await pool.execute(
              'UPDATE scr_friends SET status = ?, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
              [myNewStatus, userId, friendIdNum]
            );
          } else {
            await pool.execute(
              'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, ?, NOW())',
              [userId, friendIdNum, myNewStatus]
            );
          }

          if (existingReverse.length > 0) {
            await pool.execute(
              'UPDATE scr_friends SET status = ?, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
              [theirNewStatus, friendIdNum, userId]
            );
          } else {
            await pool.execute(
              'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, ?, NOW())',
              [friendIdNum, userId, theirNewStatus]
            );
          }

          await pool.query('COMMIT');

          const [userInfo] = await pool.execute(
            'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
            [userId]
          );
          const [friendInfo] = await pool.execute(
            'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
            [friendIdNum]
          );

          const now = new Date();
          const addedContent = '你们已成为好友';

          const [insertResult] = await pool.execute(
            'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
            [userId, friendIdNum, addedContent, 100]
          );

          const rawType100Message1 = {
            id: insertResult.insertId,
            userId: userId,
            nickname: userInfo[0]?.nickname || '',
            avatarUrl: userInfo[0]?.avatar_url || '',
            senderId: userId,
            receiverId: friendIdNum,
            content: addedContent,
            messageType: 100,
            isRead: 1,
            timestamp: now.getTime(),
            timestampISO: now.toISOString()
          };

          const rawType100Message2 = {
            ...rawType100Message1,
            isRead: 0
          };

          const type100Message1 = filterMessageFields(rawType100Message1, 'private');
          const type100Message2 = filterMessageFields(rawType100Message2, 'private');

          io.to(`user_${userId}`).emit('private-message-received', type100Message1);
          io.to(`user_${friendIdNum}`).emit('private-message-received', type100Message2);

          io.to(`user_${friendIdNum}`).emit('friend-added', {
            friendId: userId,
            timestamp: Date.now()
          });
          io.to(`user_${userId}`).emit('friend-added', {
            friendId: friendIdNum,
            timestamp: Date.now()
          });

          res.json({
            status: 'success',
            message: '添加好友成功'
          });
          return;
        }

        if (existingForward.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [userId, friendIdNum]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 1, NOW())',
            [userId, friendIdNum]
          );
        }

        if (existingReverse.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [friendIdNum, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 1, NOW())',
            [friendIdNum, userId]
          );
        }

        await pool.query('COMMIT');

        const [userInfo] = await pool.execute(
          'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
          [userId]
        );
        const [friendInfo] = await pool.execute(
          'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
          [friendIdNum]
        );

        const now = new Date();
        const addedContent = '你们已成为好友';

        const [insertResult] = await pool.execute(
          'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
          [userId, friendIdNum, addedContent, 100]
        );

        const rawType100Message1 = {
          id: insertResult.insertId,
          userId: userId,
          nickname: userInfo[0]?.nickname || '',
          avatarUrl: userInfo[0]?.avatar_url || '',
          senderId: userId,
          receiverId: friendIdNum,
          content: addedContent,
          messageType: 100,
          isRead: 1,
          timestamp: now.getTime(),
          timestampISO: now.toISOString()
        };

        const rawType100Message2 = {
          ...rawType100Message1,
          isRead: 0
        };

        const type100Message1 = filterMessageFields(rawType100Message1, 'private');
        const type100Message2 = filterMessageFields(rawType100Message2, 'private');

        io.to(`user_${userId}`).emit('private-message-received', type100Message1);
        io.to(`user_${friendIdNum}`).emit('private-message-received', type100Message2);

        io.to(`user_${friendIdNum}`).emit('friend-added', {
          friendId: userId,
          timestamp: Date.now()
        });
        io.to(`user_${userId}`).emit('friend-added', {
          friendId: friendIdNum,
          timestamp: Date.now()
        });

        res.json({
          status: 'success',
          message: '添加好友成功'
        });
      }
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    // 并发重复提交会触发 scr_friends.unique_friendship 唯一键冲突：
    // SELECT 检查与 INSERT 之间存在竞态窗口，此时对方请求已写入行，
    // 重试一次即可命中 UPDATE 分支正常完成添加
    if (err && err.code === 'ER_DUP_ENTRY' && !req.__addFriendRetried) {
      req.__addFriendRetried = true;
      return handleAddFriend(req, res, io);
    }
    console.error('添加好友失败:', err.message);
    res.status(500).json({ status: 'error', message: '添加好友失败' });
  }
}

export async function handleRemoveFriend(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { friendId } = req.body;

    if (!friendId || isNaN(friendId)) {
      return res.status(400).json({ status: 'error', message: '好友ID无效' });
    }

    const friendIdNum = parseInt(friendId);

    const [myRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, friendIdNum]
    );
    
    const [friendRecord] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [friendIdNum, userId]
    );
    
    const myStatus = myRecord.length > 0 ? myRecord[0].status : null;
    const friendStatus = friendRecord.length > 0 ? friendRecord[0].status : null;
    
    const stainStatuses = [0, 5, 7, 8, 9, 10, 11, 12];
    const iHaveStain = myStatus !== null && stainStatuses.includes(myStatus);
    const friendHasStain = friendStatus !== null && stainStatuses.includes(friendStatus);

    // 单向删除：我方的记录按污点状态机处理（保留对向记录，等对方主动清理）
    if (myRecord.length > 0) {
      if (iHaveStain) {
        if (myStatus === 5 || myStatus === 0) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);
        } else if (myStatus === 10 || myStatus === 11) {
          await pool.execute('UPDATE scr_friends SET status = 12, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);
        } else {
          await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);
        }
      } else {
        if (myStatus === 6) {
          await pool.execute('UPDATE scr_friends SET status = 9, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);
        } else {
          await pool.execute('DELETE FROM scr_friends WHERE user_id = ? AND friend_id = ?', [userId, friendIdNum]);
        }
      }
    }

    if (friendRecord.length > 0) {
      if (friendHasStain) {
        if (friendStatus === 5) {
          await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        } else if (friendStatus === 10) {
          await pool.execute('UPDATE scr_friends SET status = 11, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        } else if (friendStatus === 0 || friendStatus === 9 || friendStatus === 12) {
          // 状态已正确，无需更新
        } else if (friendStatus === 7 || friendStatus === 8) {
          await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        } else if (friendStatus === 11) {
          // 状态已正确，无需更新
        } else {
          await pool.execute('UPDATE scr_friends SET status = 0, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
        }
      } else {
        await pool.execute('UPDATE scr_friends SET status = 6, created_at = NOW() WHERE user_id = ? AND friend_id = ?', [friendIdNum, userId]);
      }
    } else {
      if (iHaveStain) {
        await pool.execute('INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 0, NOW())', [friendIdNum, userId]);
      } else {
        await pool.execute('INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 6, NOW())', [friendIdNum, userId]);
      }
    }

    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );
    
    const deletedContent = '你们的好友关系已解除';
    
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_private_messages (sender_id, receiver_id, content, message_type, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, friendIdNum, deletedContent, 100]
    );
    
    const rawType100Message1 = {
      id: insertResult.insertId,
      userId: userId,
      nickname: userInfo[0]?.nickname || '',
      avatarUrl: userInfo[0]?.avatar_url || '',
      senderId: userId,
      receiverId: friendIdNum,
      content: deletedContent,
      messageType: 100,
      isRead: 1,
      timestamp: Date.now(),
      timestampISO: new Date().toISOString()
    };
    
    const rawType100Message2 = {
      ...rawType100Message1,
      isRead: 0
    };
    
    const type100Message1 = filterMessageFields(rawType100Message1, 'private');
    const type100Message2 = filterMessageFields(rawType100Message2, 'private');
    
    io.to(`user_${userId}`).emit('private-message-received', type100Message1);
    io.to(`user_${friendIdNum}`).emit('private-message-received', type100Message2);

    const friendDeletedEventForFriend = {
      friendId: userId,
      nickname: userInfo[0]?.nickname || '',
      avatarUrl: userInfo[0]?.avatar_url || '',
      timestamp: Date.now()
    };

    // 只通知被删除方（friendIdNum）；删除方自己通过 HTTP 响应处理本地，避免把自己会话误标为"已删除"
    io.to(`user_${friendIdNum}`).emit('friend-deleted', friendDeletedEventForFriend);
    io.to(`user_${friendIdNum}`).emit('friend-removed', { friendId: userId });

    res.json({ status: 'success', message: '删除好友成功' });
  } catch (err) {
    console.error('删除好友失败:', err.message);
    res.status(500).json({ status: 'error', message: '删除好友失败' });
  }
}

export async function handleBlockUser(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { targetUserId } = req.body;

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ status: 'error', message: '目标用户ID无效' });
    }

    const targetIdNum = parseInt(targetUserId);

    if (userId === targetIdNum) {
      return res.status(400).json({ status: 'error', message: '不能拉黑自己' });
    }

    const [users] = await pool.execute('SELECT id FROM scr_users WHERE id = ?', [targetIdNum]);
    if (users.length === 0) {
      return res.status(404).json({ status: 'error', message: '用户不存在' });
    }

    const [existingBlock] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, targetIdNum]
    );

    if (existingBlock.length > 0 && existingBlock[0].status === 4) {
      return res.status(400).json({ status: 'error', message: '已经拉黑了该用户' });
    }

    await pool.query('START TRANSACTION');

    try {
      const [existingReverse] = await pool.execute(
        'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
        [targetIdNum, userId]
      );

      const isMutualBlocking = existingReverse.length > 0 && existingReverse[0].status === 4;

      if (isMutualBlocking) {
        if (existingBlock.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [userId, targetIdNum]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 10, NOW())',
            [userId, targetIdNum]
          );
        }

        await pool.execute(
          'UPDATE scr_friends SET status = 10, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
          [targetIdNum, userId]
        );
      } else {
        if (existingBlock.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 4, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [userId, targetIdNum]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 4, NOW())',
            [userId, targetIdNum]
          );
        }

        if (existingReverse.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 5, created_at = NOW() WHERE user_id = ? AND friend_id = ?',
            [targetIdNum, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 5, NOW())',
            [targetIdNum, userId]
          );
        }
      }

      await pool.query('COMMIT');

      res.json({
        status: 'success',
        message: isMutualBlocking ? '已互相拉黑' : '已拉黑该用户',
        isMutualBlocking: isMutualBlocking
      });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('拉黑用户失败:', err.message);
    res.status(500).json({ status: 'error', message: '拉黑用户失败' });
  }
}

export async function handleUnblockUser(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { targetUserId } = req.body;

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ status: 'error', message: '目标用户ID无效' });
    }

    const targetIdNum = parseInt(targetUserId);

    const [existingBlock] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, targetIdNum]
    );

    if (existingBlock.length === 0 || (existingBlock[0].status !== 4 && existingBlock[0].status !== 10)) {
      return res.status(400).json({ status: 'error', message: '未拉黑该用户' });
    }

    const [existingReverse] = await pool.execute(
      'SELECT id, status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [targetIdNum, userId]
    );

    const isMutualUnblocking = existingBlock[0].status === 10;
    let hasStatusZero = false;

    await pool.query('START TRANSACTION');

    try {
      if (isMutualUnblocking) {
        // 互相拉黑状态下自己取消对对方的拉黑：对方对自己的拉黑依然生效，
        // 自己的行降为“被拉黑(5)”，对方的行降为“拉黑(4)”，不能两边都恢复正常
        await pool.execute(
          'UPDATE scr_friends SET status = 5, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 10',
          [userId, targetIdNum]
        );

        if (existingReverse.length > 0) {
          await pool.execute(
            'UPDATE scr_friends SET status = 4, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 10',
            [targetIdNum, userId]
          );
        } else {
          await pool.execute(
            'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 4, NOW())',
            [targetIdNum, userId]
          );
        }
      } else {
        const hasStatusZero = existingBlock[0].status === 0 ||
                             (existingReverse.length > 0 && existingReverse[0].status === 0);

        if (hasStatusZero) {
          await pool.execute(
            'DELETE FROM scr_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, targetIdNum, targetIdNum, userId]
          );
        } else {
          await pool.execute(
            'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 4',
            [userId, targetIdNum]
          );

          if (existingReverse.length > 0) {
            await pool.execute(
              'UPDATE scr_friends SET status = 1, created_at = NOW() WHERE user_id = ? AND friend_id = ? AND status = 5',
              [targetIdNum, userId]
            );
          } else {
            await pool.execute(
              'INSERT INTO scr_friends (user_id, friend_id, status, created_at) VALUES (?, ?, 1, NOW())',
              [targetIdNum, userId]
            );
          }
        }
      }

      await pool.query('COMMIT');

      res.json({
        status: 'success',
        message: isMutualUnblocking ? '已取消拉黑，对方仍拉黑着你' : (hasStatusZero ? '已取消拉黑并清除记录' : '已取消拉黑，恢复好友关系'),
        isMutualUnblocking: isMutualUnblocking
      });
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('取消拉黑失败:', err.message);
    res.status(500).json({ status: 'error', message: '取消拉黑失败' });
  }
}

export async function handleCheckBlockStatus(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const targetUserId = parseInt(req.params.targetUserId);

    if (!targetUserId || isNaN(targetUserId)) {
      return res.status(400).json({ status: 'error', message: '目标用户ID无效' });
    }

    const [result] = await pool.execute(
      'SELECT status FROM scr_friends WHERE user_id = ? AND friend_id = ?',
      [userId, targetUserId]
    );

    const isBlocked = result.length > 0 && (result[0].status === 4 || result[0].status === 10);

    res.json({
      status: 'success',
      isBlocked: isBlocked,
      isMutualBlocking: result.length > 0 && result[0].status === 10
    });
  } catch (err) {
    console.error('查询拉黑状态失败:', err.message);
    res.status(500).json({ status: 'error', message: '查询拉黑状态失败' });
  }
}

export async function handleSearchUsers(req, res, io) {
  try {
    const { keyword } = req.query;
    
    if (!keyword || keyword.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: '搜索关键词不能为空' });
    }
    
    let escapedKeyword = keyword.trim();
    escapedKeyword = escapedKeyword.replace(/\\/g, '\\\\');
    escapedKeyword = escapedKeyword.replace(/%/g, '\\%');
    
    const searchKeyword = `%${escapedKeyword}%`;
    
    const [users] = await pool.execute(`
      SELECT id, nickname, username, gender, avatar_url, friend_verification 
      FROM scr_users 
      WHERE username LIKE ? OR nickname LIKE ?
      LIMIT 20
    `, [searchKeyword, searchKeyword]);

    const usersWithVerification = users.map(user => ({
      ...user,
      friend_verification: user.friend_verification === 1
    }));
    
    res.json({
      status: 'success',
      users: usersWithVerification,
      message: '搜索用户成功'
    });
  } catch (err) {
    console.error('搜索用户失败:', err.message);
    res.status(500).json({ status: 'error', message: '搜索用户失败' });
  }
}

export async function handleSetFriendRemark(req, res, io) {
  try {
    const userId = parseInt(req.userId);
    const { friendId, remark } = req.body;

    if (!friendId) {
      return res.status(400).json({ status: 'error', message: '好友ID不能为空' });
    }

    if (remark !== null && typeof remark !== 'string') {
      return res.status(400).json({ status: 'error', message: '备注格式不正确' });
    }

    if (remark && remark.length > 100) {
      return res.status(400).json({ status: 'error', message: '备注长度不能超过100个字符' });
    }

    const [existingFriend] = await pool.execute(
      `SELECT id FROM scr_friends WHERE user_id = ? AND friend_id = ? AND status = 1`,
      [userId, friendId]
    );

    if (existingFriend.length === 0) {
      return res.status(404).json({ status: 'error', message: '未找到该好友或不是正常好友关系' });
    }

    const remarkValue = (remark && remark.trim()) ? remark.trim() : null;

    await pool.execute(
      `UPDATE scr_friends SET remark = ? WHERE user_id = ? AND friend_id = ?`,
      [remarkValue, userId, friendId]
    );

    res.json({
      status: 'success',
      message: remarkValue ? '备注设置成功' : '备注已清除',
      remark: remarkValue
    });
  } catch (err) {
    console.error('设置好友备注失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置好友备注失败' });
  }
}

export async function handleSetFriendDisturb(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { friendId, isDisturb } = req.body;

    if (!friendId) {
      return res.status(400).json({ status: 'error', message: '好友ID不能为空' });
    }

    if (typeof isDisturb !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isDisturb必须是布尔值' });
    }

    const [result] = await pool.execute(
      'UPDATE scr_friends SET is_disturb = ? WHERE user_id = ? AND friend_id = ? AND status = 1',
      [isDisturb ? 1 : 0, userId, friendId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: '未找到该好友或不是正常好友关系' });
    }

    res.json({
      status: 'success',
      message: isDisturb ? '已开启免打扰' : '已关闭免打扰',
      is_disturb: isDisturb ? 1 : 0
    });
  } catch (err) {
    console.error('设置好友免打扰失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置好友免打扰失败' });
  }
}

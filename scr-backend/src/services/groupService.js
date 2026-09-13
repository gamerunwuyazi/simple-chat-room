import { pool, redisClient } from '../models/database.js';
import { filterMessageFields } from '../utils/messageFilters.js';
import { checkAvatarStorage } from '../utils/helpers.js';
import { sqlInjectionPattern, validateNickname } from '../utils/validators.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

let io = null;
let broadcastProducer = null;
let getAllOnlineUsersFn = null;

export function setSocketDependencies(socketIo, getOnlineUsersFn, producer) {
  io = socketIo;
  broadcastProducer = producer;
  getAllOnlineUsersFn = getOnlineUsersFn;
}

async function isGroupOwner(groupId, userId) {
  try {
    const [groups] = await pool.execute(
      'SELECT creator_id FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );
    if (groups.length === 0) return false;
    return parseInt(groups[0].creator_id) === parseInt(userId);
  } catch (err) {
    console.error('检查群主身份失败', err.message);
    return false;
  }
}

export async function isGroupAdmin(groupId, userId) {
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
    console.error('检查群管理员身份失败', err.message);
    return false;
  }
}

export async function getGroupById(req, res) {
  try {
    const groupId = req.params.id;

    const [groups] = await pool.execute(
        'SELECT id, name, description, creator_id, avatar_url, created_at FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
        [groupId]
    );

    if (groups.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    res.json({
      status: 'success',
      group: groups[0]
    });
  } catch (err) {
    console.error('获取群组信息失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群组信息失败' });
  }
}

export async function uploadGroupAvatar(req, res, next) {
  try {
    if (!req.file) {
      const ext = req.body.filename ? path.extname(req.body.filename).toLowerCase() : '';
      const prohibitedExts = ['.php', '.php3', '.php4', '.php5', '.phtml', '.phar'];
      if (prohibitedExts.includes(ext)) {
        return res.status(400).json({ status: 'error', message: '禁止上传PHP文件' });
      }
      return res.status(400).json({ status: 'error', message: '没有上传文件' });
    }

    const storageStatus = checkAvatarStorage();
    if (storageStatus.full) {
      return res.status(400).json({ status: 'error', message: storageStatus.message });
    }

    const userId = req.userId;
    const groupId = req.params.groupId;

    if (!userId || !groupId) {
      return res.status(400).json({ status: 'error', message: '用户ID和群组ID不能为空' });
    }

    // 检查用户是否是群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以修改群头像' });
    }

    const [groups] = await pool.execute(
        'SELECT id, name, creator_id FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
        [groupId]
    );

    if (groups.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    const group = groups[0];
    const avatarPath = `/avatars/${req.file.filename}`;
    
    // 清理该群组的旧头像文件
    const avatarDir = path.join(process.cwd(), 'public', 'avatars');
    const groupAvatarFiles = fs.readdirSync(avatarDir).filter(file => {
      return file.startsWith(`group_avatar_${groupId}.`);
    });

    // 如果头像文件数量大于1，删除除当前头像外的其他文件
    if (groupAvatarFiles.length > 1) {
      const currentAvatarFilename = req.file.filename;
      for (const file of groupAvatarFiles) {
        if (file !== currentAvatarFilename) {
          try {
            const filePath = path.join(avatarDir, file);
            fs.unlinkSync(filePath);
          } catch (deleteError) {
            console.error(`删除旧群头像文件 ${file} 失败:`, deleteError.message);
          }
        }
      }
    }
    
    // 生成带时间戳的头像URL，确保客户端获取最新资源
    const timestamp = Date.now();
    const avatarUrlWithVersion = `${avatarPath}?v=${timestamp}`;

    // 更新群组头像 URL
    await pool.execute(
        'UPDATE scr_groups SET avatar_url = ? WHERE id = ? AND deleted_at IS NULL',
        [avatarUrlWithVersion, groupId]
    );

    // 广播群头像更新事件给所有群组成员（使用群组房间）
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-avatar-updated', {
      groupId: groupId,
      avatarUrl: avatarUrlWithVersion
    });

    res.json({
      status: 'success',
      message: '群头像上传成功',
      groupId: group.id,
      groupName: group.name,
      avatarUrl: avatarUrlWithVersion
    });
  } catch (err) {
    console.error('上传群头像失败', err.message);
    res.status(500).json({ status: 'error', message: '上传群头像失败' });
  }
}

export async function createGroup(req, res) {
  try {
    const { userId, groupName, description, memberIds } = req.body;

    if (!userId || !groupName || !memberIds || !Array.isArray(memberIds)) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    const sessionUserId = req.userId;
    if (parseInt(userId) !== parseInt(sessionUserId)) {
      return res.status(403).json({ status: 'error', message: '无权操作此用户' });
    }

    // 群组名称验证
    if (!groupName || typeof groupName !== 'string' || groupName.trim().length === 0) {
      return res.status(400).json({ status: 'error', message: '群组名称不能为空' });
    }

    // 检查群组名称是否包含SQL注入
    if (sqlInjectionPattern.test(groupName)) {
      return res.status(400).json({ status: 'error', message: '群组名称非法' });
    }

    // 检查描述是否包含SQL注入（如果提供了描述）
    if (description && typeof description === 'string' && sqlInjectionPattern.test(description)) {
      return res.status(400).json({ status: 'error', message: '群组描述非法' });
    }

    // 移除3人限制，改为1人以上
    const allMemberIds = [...new Set([parseInt(userId), ...memberIds.map(id => parseInt(id))])];
    
    // 获取创建者的所有好友ID
    const [friendIds] = await pool.execute(
      'SELECT friend_id FROM scr_friends WHERE user_id = ? AND status = 1',
      [parseInt(userId)]
    );
    const friends = friendIds.map(row => row.friend_id);
    
    // 验证所有添加的成员都是创建者的好友
    const nonFriendMembers = allMemberIds.filter(memberId => memberId !== parseInt(userId) && !friends.includes(memberId));
    if (nonFriendMembers.length > 0) {
      return res.status(400).json({ status: 'error', message: '只能添加好友到群组' });
    }
    
    // 验证所有成员都存在
    const placeholders = allMemberIds.map(() => '?').join(',');
    const [members] = await pool.execute(
        `SELECT id FROM scr_users WHERE id IN (${placeholders})`,
        allMemberIds
    );
    
    if (members.length !== allMemberIds.length) {
      return res.status(400).json({ status: 'error', message: '部分成员不存在' });
    }

    const [groupResult] = await pool.execute(
        'INSERT INTO scr_groups (name, description, creator_id) VALUES (?, ?, ?)',
        [groupName, description || '', userId]
    );

    const groupId = groupResult.insertId;

    const memberValues = allMemberIds.map(memberId => [groupId, memberId]);
    await pool.query(
        'INSERT INTO scr_group_members (group_id, user_id) VALUES ?',
        [memberValues]
    );

    const [groups] = await pool.execute(`
      SELECT g.*, u.nickname as creator_name 
      FROM scr_groups g 
      JOIN scr_users u ON g.creator_id = u.id 
      WHERE g.id = ? AND g.deleted_at IS NULL
    `, [groupId]);

    const [groupMembers] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar_url 
      FROM scr_group_members gm 
      JOIN scr_users u ON gm.user_id = u.id 
      WHERE gm.group_id = ? AND gm.deleted_at IS NULL
    `, [groupId]);

    // 让所有在线成员加入群组房间
    for (const member of groupMembers) {
      const allOnlineUsers = await getAllOnlineUsersFn();
      for (const onlineUser of allOnlineUsers) {
        if (String(onlineUser.id) === String(member.id)) {
          const memberSocket = io.sockets.sockets.get(onlineUser.socketId);
          if (memberSocket) {
            memberSocket.join(`group_${groupId}`);
          }
        }
      }
    }
    
    // 获取创建者信息
    const [creatorInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    // 先广播类型100的系统消息：XXX创建了群组
    const now = new Date();
    const creatorNickname = creatorInfo[0]?.nickname || '用户';
    const createContentObj = { [String(userId)]: creatorNickname, action: 'create' };
    
    // 如果有同时加入的成员，otherNames 存储 id:昵称 键值对对象
    const otherMemberIds = allMemberIds.filter(id => id !== parseInt(userId));
    if (otherMemberIds.length > 0) {
      const [otherMembersInfo] = await pool.execute(
        `SELECT u.id, u.nickname FROM scr_users u WHERE u.id IN (${otherMemberIds.map(() => '?').join(',')})`,
        otherMemberIds
      );
      createContentObj.otherNames = {};
      otherMembersInfo.forEach(m => {
        createContentObj.otherNames[String(m.id)] = m.nickname || '用户';
      });
    }
    
    const createContent = JSON.stringify(createContentObj);
    
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, createContent, 100, groupId]
    );

    // 构建100类型消息对象
    const rawType100Message = {
      id: insertResult.insertId,
      userId: userId,
      nickname: creatorNickname,
      avatarUrl: creatorInfo[0]?.avatar_url || '',
      content: createContent,
      messageType: 100,
      groupId: groupId,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 过滤群组消息字段
    const type100Message = filterMessageFields(rawType100Message, 'group');

    // 向所有群组成员发送100类型消息（先广播）
    broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);
      
    // 向所有群组成员广播群组创建事件（使用群组房间）
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-created', {
      groupId: groupId,
      groupName: groupName,
      creatorId: userId,
      members: groupMembers,
      createMessage: type100Message
    });

    res.json({
      status: 'success',
      message: '群组创建成功',
      group: groups[0],
      members: groupMembers,
      createMessage: type100Message
    });
  } catch (err) {
    console.error('创建群组失败:', err.message);
    res.status(500).json({ status: 'error', message: '创建群组失败' });
  }
}

export async function getUserGroups(req, res) {
  try {
    // 用户ID由会话鉴权中间件推断，不再依赖 URL 参数
    const userId = parseInt(req.userId);

    const [groups] = await pool.execute(`
      SELECT g.*, gm.remark as user_remark, gm.is_disturb
      FROM scr_groups g
      JOIN scr_group_members gm ON g.id = gm.group_id
      WHERE gm.user_id = ? AND g.deleted_at IS NULL AND gm.deleted_at IS NULL
      ORDER BY g.id DESC
    `, [userId]);

    // 确保所有ID字段都是数字格式
    const normalizedGroups = groups.map(group => ({
      ...group,
      id: Number(group.id),
      creator_id: Number(group.creator_id),
      is_mute_all: Number(group.is_mute_all)
    }));

    // 批量查询每个群组的最后一条消息（含发送者当前 group_nickname）
    if (normalizedGroups.length > 0) {
      const groupIds = normalizedGroups.map(g => g.id);
      const placeholders = groupIds.map(() => '?').join(',');
      const [lastMessages] = await pool.execute(`
        SELECT m.group_id, m.content, m.message_type, gm.group_nickname
        FROM scr_messages m
        LEFT JOIN scr_group_members gm ON m.group_id = gm.group_id AND m.user_id = gm.user_id AND gm.deleted_at IS NULL
        WHERE m.group_id IN (${placeholders})
        AND m.message_type != 102
        AND m.id = (
          SELECT MAX(m2.id) FROM scr_messages m2
          WHERE m2.group_id = m.group_id AND m2.message_type != 102
        )
      `, groupIds);

      const lastMsgMap = {};
      for (const msg of lastMessages) {
        const msgGroupId = Number(msg.group_id);
        // 如果 lastMessage 的发送者有群昵称则保存
        const lastMsg = {
          content: msg.content,
          messageType: msg.message_type,
          groupNickname: msg.group_nickname || null,
        };

        // 对 100+ 的消息，解析 content 中所有用户 ID 的昵称并替换为群昵称（有则替换，无则保留）
        if (msg.message_type >= 100 && msg.content && typeof msg.content === 'string') {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed && typeof parsed === 'object') {
              // 收集数字 key：顶层 + 101 消息的 nickname 子对象
              let numericKeys = Object.keys(parsed).filter(k => /^\d+$/.test(k));
              // 101 撤回消息嵌套结构: {"id": X, "nickname": {"userId": "昵称"}}
              if (msg.message_type === 101 && parsed.nickname && typeof parsed.nickname === 'object') {
                numericKeys = numericKeys.concat(Object.keys(parsed.nickname).filter(k => /^\d+$/.test(k)));
              }
              if (numericKeys.length > 0) {
                // 批量查询这些用户在群中的 group_nickname
                const userIdPlaceholders = numericKeys.map(() => '?').join(',');
                const [groupNicknames] = await pool.execute(`
                  SELECT user_id, group_nickname
                  FROM scr_group_members
                  WHERE group_id = ? AND user_id IN (${userIdPlaceholders}) AND deleted_at IS NULL
                `, [msgGroupId, ...numericKeys.map(Number)]);

                const nicknameMap = {};
                groupNicknames.forEach(row => {
                  if (row.group_nickname) {
                    nicknameMap[String(row.user_id)] = row.group_nickname;
                  }
                });

                let updated = false;
                // 替换顶层数字 key
                for (const key of numericKeys) {
                  if (nicknameMap[key] && typeof parsed[key] === 'string' && parsed[key] !== nicknameMap[key]) {
                    parsed[key] = nicknameMap[key];
                    updated = true;
                  }
                }
                // 替换 101 消息 nickname 子对象中的数字 key
                if (msg.message_type === 101 && parsed.nickname && typeof parsed.nickname === 'object') {
                  for (const key of Object.keys(parsed.nickname).filter(k => /^\d+$/.test(k))) {
                    if (nicknameMap[key] && typeof parsed.nickname[key] === 'string' && parsed.nickname[key] !== nicknameMap[key]) {
                      parsed.nickname[key] = nicknameMap[key];
                      updated = true;
                    }
                  }
                  // 还要更新顶层数字 key（101 消息有时也直接在顶层存 key）
                  for (const key of Object.keys(parsed).filter(k => /^\d+$/.test(k))) {
                    if (nicknameMap[key] && typeof parsed[key] === 'string' && parsed[key] !== nicknameMap[key]) {
                      parsed[key] = nicknameMap[key];
                      updated = true;
                    }
                  }
                }
                if (updated) {
                  lastMsg.content = JSON.stringify(parsed);
                }
              }
            }
          } catch (e) {
            // JSON 解析失败，保持原内容
          }
        }

        lastMsgMap[msgGroupId] = lastMsg;
      }

      normalizedGroups.forEach(group => {
        if (lastMsgMap[group.id]) {
          group.lastMessage = lastMsgMap[group.id];
        }
      });
    }

    const responseData = {
      status: 'success',
      groups: normalizedGroups,
      timestamp: new Date().toISOString()
    };
    
    res.json(responseData);
  } catch (err) {
    console.error('获取群组列表失败:', err.message);
    console.error('错误详情:', err);
    res.status(500).json({ status: 'error', message: '获取群组列表失败', error: err.message });
  }
}

export async function getAvailableGroupMembers(req, res) {
  try {
    const groupId = req.params.groupId;
    const userId = req.userId;

    // 检查请求者是否为群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ success: false, message: '只有群主或管理员可以查看可添加成员' });
    }

    // 查询不在该群组中的创建者的好友
    const [availableMembers] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar_url
      FROM scr_users u
      JOIN scr_friends f ON u.id = f.friend_id
      WHERE f.user_id = ? AND f.status = 1 AND u.id NOT IN (
        SELECT user_id FROM scr_group_members WHERE group_id = ? AND deleted_at IS NULL
      ) AND u.id != ?
    `, [userId, groupId, userId]);

    res.json({
      status: 'success',
      members: availableMembers.map(member => ({
        id: member.id,
        nickname: member.nickname,
        avatarUrl: member.avatar_url
      }))
    });
  } catch (err) {
    console.error('获取可添加成员失败', err.message);
    res.status(500).json({ success: false, message: '获取可添加成员失败' });
  }
}

export async function getGroupInfo(req, res) {
  try {
    const groupId = req.params.groupId;

    const [group] = await pool.execute(
      'SELECT id, name, description, creator_id, created_at, avatar_url, deleted_at, is_mute_all FROM scr_groups WHERE id = ?',
      [groupId]
    );

    if (!group || group.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    // 确保所有ID字段都是数字格式
    const normalizedGroup = {
      ...group[0],
      id: Number(group[0].id),
      creator_id: Number(group[0].creator_id),
      is_mute_all: Number(group[0].is_mute_all)
    };

    res.json({
      status: 'success',
      group: normalizedGroup
    });
  } catch (err) {
    console.error('获取群组信息失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群组信息失败' });
  }
}

export async function getGroupMembers(req, res) {
  try {
    const groupId = req.params.groupId;

    const [members] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar_url as avatarUrl, gm.is_admin, DATE_FORMAT(gm.is_muted, '%Y-%m-%d %H:%i:%s') AS is_muted, gm.group_nickname
      FROM scr_group_members gm
      JOIN scr_users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.deleted_at IS NULL
    `, [groupId]);

    // 确保所有ID字段都是数字格式
    const normalizedMembers = members.map(member => ({
      id: Number(member.id),
      nickname: member.nickname,
      avatarUrl: member.avatarUrl,
      is_admin: Number(member.is_admin),
      is_muted: member.is_muted,
      group_nickname: member.group_nickname
    }));

    res.json({
      status: 'success',
      members: normalizedMembers
    });
  } catch (err) {
    console.error('获取群组成员失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群组成员失败' });
  }
}

export async function removeGroupMember(req, res) {
  try {
    const { groupId, memberId } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || !memberId) {
      return res.status(400).json({ success: false, message: '参数错误' });
    }

    // 检查请求者是否为群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ success: false, message: '只有群主或管理员可以踢出成员' });
    }

    // 检查成员是否在群组中
    const [member] = await pool.execute(
      'SELECT id, is_admin FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, memberId]
    );

    if (!member || member.length === 0) {
      return res.status(404).json({ success: false, message: '该成员不在群组中' });
    }

    // 不能踢出自己
    if (parseInt(memberId) === parseInt(userId)) {
      return res.status(400).json({ success: false, message: '不能踢出自己' });
    }
    
    // 管理员不能踢出群主或其他管理员（只有群主可以）
    const isOwner = await isGroupOwner(groupId, userId);
    if (!isOwner && member[0].is_admin === 1) {
      return res.status(403).json({ success: false, message: '只有群主可以踢出管理员' });
    }

    // 获取被踢出的成员信息
    const [memberInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [memberId]
    );

    // 获取群主信息
    const [creatorInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    // 先广播类型100的系统消息：XXX被踢出了群组
    const now = new Date();
    const kickedNickname = memberInfo[0]?.nickname || '用户';
    const kickerNickname = creatorInfo[0]?.nickname || '用户';
    const kickedContentObj = { [String(memberId)]: kickedNickname, [String(userId)]: kickerNickname, action: 'kick' };
    const kickedContent = JSON.stringify(kickedContentObj);
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, kickedContent, 100, groupId]
    );

    // 构建100类型消息对象
    const rawType100Message = {
      id: insertResult.insertId,
      userId: memberId,
      nickname: kickedNickname,
      avatarUrl: memberInfo[0]?.avatar_url || '',
      content: kickedContent,
      messageType: 100,
      groupId: groupId,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 过滤群组消息字段
    const type100Message = filterMessageFields(rawType100Message, 'group');

    // 向所有群组成员发送100类型消息（先广播）
    broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);
    
    // 同时也向被踢出的成员的用户房间发送，确保他们能收到
    io.to(`user_${memberId}`).emit('message-received', type100Message);

    // 执行踢出操作 - 逻辑删除，只记录deleted_at（加1秒）
    const deletedAt = new Date(Date.now() + 1000);
    await pool.execute(
      'UPDATE scr_group_members SET deleted_at = ? WHERE group_id = ? AND user_id = ?',
      [deletedAt, groupId, memberId]
    );

    // 让被踢出的用户离开群组socket.io房间
    const allOnlineUsers = await getAllOnlineUsersFn();
    for (const onlineUser of allOnlineUsers) {
      if (String(onlineUser.id) === String(memberId)) {
        const memberSocket = io.sockets.sockets.get(onlineUser.socketId);
        if (memberSocket) {
          memberSocket.leave(`group_${groupId}`);
        }
      }
    }

    // 向所有群组成员广播成员被踢出事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'member-removed', { groupId, memberId });

    // 也通知被踢出的成员
    io.to(`user_${memberId}`).emit('member-removed', { groupId, memberId });
    
    res.json({ success: true, message: '成员已成功踢出' });
  } catch (err) {
    console.error('踢出成员失败:', err.message);
    res.status(500).json({ success: false, message: '踢出成员失败' });
  }
}

export async function setGroupAdmin(req, res) {
  try {
    const { groupId, memberId, isAdmin } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || !memberId || typeof isAdmin !== 'boolean') {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查请求者是否为群主（只有群主可以设置管理员）
    const isOwner = await isGroupOwner(groupId, userId);
    if (!isOwner) {
      return res.status(403).json({ status: 'error', message: '只有群主可以设置管理员' });
    }

    // 不能设置自己为管理员（自己已经是群主了）
    if (parseInt(memberId) === parseInt(userId)) {
      return res.status(400).json({ status: 'error', message: '不能设置群主为管理员' });
    }

    // 检查目标成员是否在群组中
    const [member] = await pool.execute(
      'SELECT id, is_admin FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, memberId]
    );

    if (!member || member.length === 0) {
      return res.status(404).json({ status: 'error', message: '该成员不在群组中' });
    }

    // 更新管理员状态
    await pool.execute(
      'UPDATE scr_group_members SET is_admin = ? WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [isAdmin ? 1 : 0, groupId, memberId]
    );

    // 获取用户信息
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [memberId]
    );

    // 向所有群组成员广播管理员变更事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-admin-changed', {
      groupId: groupId,
      userId: memberId,
      isAdmin: isAdmin,
      nickname: userInfo[0]?.nickname || '',
      avatarUrl: userInfo[0]?.avatar_url || ''
    });

    res.json({ 
      status: 'success', 
      message: isAdmin ? '已设置为管理员' : '已取消管理员权限'
    });
  } catch (err) {
    console.error('设置群管理员失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置群管理员失败' });
  }
}

export async function addGroupMembers(req, res) {
  try {
    const { groupId, memberIds, userId: requestUserId } = req.body;
    const userId = req.userId;
    
    // 验证请求中的用户ID是否与会话用户ID一致
    if (requestUserId && String(requestUserId) !== String(userId)) {
      return res.status(403).json({ status: 'error', message: '无效的用户ID' });
    }

    if (!groupId || !memberIds || !Array.isArray(memberIds)) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查用户是否是群主或管理员（群主和管理员都可以拉取成员）
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以拉取成员' });
    }

    const [group] = await pool.execute(
      'SELECT name, avatar_url FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );

    if (!group || group.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    // 检查成员是否存在
    const cleanMemberIds = [...new Set(memberIds.map(id => parseInt(id)))];
    const placeholders = cleanMemberIds.map(() => '?').join(',');
    const [users] = await pool.execute(
      `SELECT id FROM scr_users WHERE id IN (${placeholders})`,
      cleanMemberIds
    );

    if (users.length !== cleanMemberIds.length) {
      return res.status(400).json({ status: 'error', message: '部分用户不存在' });
    }
    
    // 获取群主的所有好友ID
    const [friendIds] = await pool.execute(
      'SELECT friend_id FROM scr_friends WHERE user_id = ? AND status = 1',
      [parseInt(userId)]
    );
    const friends = friendIds.map(row => row.friend_id);
    
    // 验证所有要添加的成员都是群主的好友
    const nonFriendMembers = cleanMemberIds.filter(memberId => !friends.includes(memberId));
    if (nonFriendMembers.length > 0) {
      return res.status(400).json({ status: 'error', message: '只能添加好友到群组' });
    }

    // 检查用户是否已经在群组中
    const [existingMembers] = await pool.execute(
      `SELECT user_id FROM scr_group_members WHERE group_id = ? AND user_id IN (${placeholders}) AND deleted_at IS NULL`,
      [groupId].concat(cleanMemberIds)
    );

    const existingUserIds = new Set(existingMembers.map(m => m.user_id));
    const newMemberIds = cleanMemberIds.filter(id => !existingUserIds.has(id));

    if (newMemberIds.length === 0) {
      return res.status(400).json({ status: 'error', message: '所选用户已在群组中' });
    }

    // 获取新成员信息
    const [newMembersInfo] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar_url as avatarUrl 
      FROM scr_users u 
      WHERE u.id IN (${newMemberIds.map(() => '?').join(',')})`,
      newMemberIds
    );

    // 获取群主信息
    const [creatorInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    // 添加新成员，总是创建新记录
    for (const memberId of newMemberIds) {
      await pool.execute(
        'INSERT INTO scr_group_members (group_id, user_id, joined_at) VALUES (?, ?, NOW())',
        [groupId, memberId]
      );
    }

    // 获取更新后的群组成员列表（只获取未删除的成员）
    const [updatedMembers] = await pool.execute(
      `SELECT u.id, u.nickname, u.avatar_url as avatarUrl
      FROM scr_group_members gm
      JOIN scr_users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.deleted_at IS NULL`,
      [groupId]
    );

    // 让所有在线的新成员加入群组房间
    const allOnlineUsers = await getAllOnlineUsersFn();
    for (const memberId of newMemberIds) {
      for (const onlineUser of allOnlineUsers) {
        if (String(onlineUser.id) === String(memberId)) {
          const memberSocket = io.sockets.sockets.get(onlineUser.socketId);
          if (memberSocket) {
            memberSocket.join(`group_${groupId}`);
          }
        }
      }
    }

    // 插入类型100的系统消息：XXX邀请XXX加入了群组
    const now = new Date();
    const inviterName = creatorInfo[0]?.nickname || '用户';
    const addedContentObj = { [String(userId)]: inviterName, action: 'invite' };
    newMembersInfo.forEach(m => {
      addedContentObj[String(m.id)] = m.nickname || '用户';
    });
    const addedContent = JSON.stringify(addedContentObj);
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, addedContent, 100, groupId]
    );

    // 构建100类型消息对象
    const rawType100Message = {
      id: insertResult.insertId,
      userId: userId,
      nickname: inviterName,
      avatarUrl: creatorInfo[0]?.avatar_url || '',
      content: addedContent,
      messageType: 100,
      groupId: groupId,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 过滤群组消息字段
    const type100Message = filterMessageFields(rawType100Message, 'group');

    // 向所有群组成员发送100类型消息
    broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);

    // 向每个新成员单独发送被添加到群组的事件
    for (const memberId of newMemberIds) {
      io.to(`user_${memberId}`).emit('added-to-group', {
        groupId: groupId,
        groupName: group.name,
        groupAvatarUrl: group.avatar_url,
        members: updatedMembers,
        addMessage: type100Message
      });
    }

    // 向所有群组成员广播成员添加事件（不包括新成员，他们通过added-to-group接收）
    broadcastProducer?.enqueue(`group_${groupId}`, 'members-added', {
      groupId: groupId,
      newMemberIds: newMemberIds,
      members: updatedMembers
    });

    res.json({
      status: 'success',
      message: '成员添加成功',
      groupId: groupId,
      addedMemberIds: newMemberIds,
      members: updatedMembers,
      addMessage: type100Message
    });
  } catch (err) {
    console.error('添加群组成员失败:', err.message);
    res.status(500).json({ status: 'error', message: '添加群组成员失败' });
  }
}

export async function generateGroupToken(req, res) {
  try {
    const { groupId } = req.body;
    const userId = req.userId;
    
    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }
    
    // 检查用户是否为群组成员
    const [member] = await pool.execute(
      'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, userId]
    );
    
    if (!member || member.length === 0) {
      return res.status(403).json({ status: 'error', message: '只有群组成员可以生成邀请Token' });
    }
    
    // 生成唯一Token
    const token = crypto.randomBytes(16).toString('hex');
    // 设置Token有效期为7天（秒）
    const expiresInSeconds = 7 * 24 * 60 * 60;
    const expires = new Date(Date.now() + expiresInSeconds * 1000);
    
    // 存储Token到Redis
    const redisKey = `group_invite_token:${token}`;
    await redisClient.setEx(redisKey, expiresInSeconds, JSON.stringify({
      groupId: groupId,
      createdBy: userId
    }));
    
    res.json({ status: 'success', token, expires });
  } catch (err) {
    console.error('生成群组邀请Token失败:', err.message);
    res.status(500).json({ status: 'error', message: '生成邀请Token失败' });
  }
}

export async function validateGroupToken(req, res) {
  try {
    const { token } = req.params;
    
    // 从Redis读取Token
    const redisKey = `group_invite_token:${token}`;
    const tokenData = await redisClient.get(redisKey);
    
    if (!tokenData) {
      return res.status(400).json({ status: 'error', message: '无效或过期的邀请Token' });
    }
    
    const { groupId } = JSON.parse(tokenData);
    
    // 获取群组信息
    const [groups] = await pool.execute(
      'SELECT id, name, description FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );
    
    if (!groups || groups.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }
    
    res.json({ status: 'success', group: groups[0] });
  } catch (err) {
    console.error('验证群组邀请Token失败:', err.message);
    res.status(500).json({ status: 'error', message: '验证邀请Token失败' });
  }
}

export async function joinGroupWithToken(req, res) {
  try {
    const { token, isFromGroupCard } = req.body;
    const userId = req.userId;
    
    if (!token) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }
    
    // 从Redis读取Token
    const redisKey = `group_invite_token:${token}`;
    const tokenData = await redisClient.get(redisKey);
    
    if (!tokenData) {
      return res.status(400).json({ status: 'error', message: '无效或过期的邀请Token' });
    }
    
    const { groupId } = JSON.parse(tokenData);
    
    // 获取群组信息
    const [group] = await pool.execute(
      'SELECT id, name, avatar_url FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );
    
    if (!group || group.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }
    
    // 检查用户是否已经是群组成员
    const [members] = await pool.execute(
      'SELECT id, deleted_at FROM scr_group_members WHERE group_id = ? AND user_id = ?',
      [groupId, userId]
    );
    
    if (members && members.length > 0) {
      if (members[0].deleted_at === null) {
        return res.status(400).json({ status: 'error', message: '你已经是该群组成员' });
      }
    }
    
    // 获取用户信息
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );
    
    // 执行加入操作，总是创建新记录
    await pool.execute(
      'INSERT INTO scr_group_members (group_id, user_id, joined_at) VALUES (?, ?, NOW())',
      [groupId, userId]
    );
    
    // 让用户加入群组房间
    const allOnlineUsers = await getAllOnlineUsersFn();
    for (const onlineUser of allOnlineUsers) {
      if (String(onlineUser.id) === String(userId)) {
        const userSocket = io.sockets.sockets.get(onlineUser.socketId);
        if (userSocket) {
          userSocket.join(`group_${groupId}`);
        }
      }
    }
    
    // 插入类型100的系统消息
    const now = new Date();
    const joinerNickname = userInfo[0]?.nickname || '用户';
    const joinContentObj = { [String(userId)]: joinerNickname, action: isFromGroupCard ? 'joinByCard' : 'join' };
    const joinContent = JSON.stringify(joinContentObj);
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, joinContent, 100, groupId]
    );

    // 构建100类型消息对象
    const rawType100Message = {
      id: insertResult.insertId,
      userId: userId,
      nickname: joinerNickname,
      avatarUrl: userInfo[0]?.avatar_url || '',
      content: joinContent,
      messageType: 100,
      groupId: groupId,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 过滤群组消息字段
    const type100Message = filterMessageFields(rawType100Message, 'group');

    // 向所有群组成员发送100类型消息（用户已经加入房间了）
    broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);
    
    // 同时也向新成员的用户房间发送，确保他们能收到
    io.to(`user_${userId}`).emit('message-received', type100Message);
    
    // 向新成员单独发送被添加到群组的事件，包含群组信息
    const [updatedMembers] = await pool.execute(`
      SELECT u.id, u.nickname, u.avatar_url as avatarUrl, gm.is_admin
      FROM scr_group_members gm 
      JOIN scr_users u ON gm.user_id = u.id 
      WHERE gm.group_id = ? AND gm.deleted_at IS NULL
    `, [groupId]);
    
    io.to(`user_${userId}`).emit('added-to-group', {
      groupId: groupId,
      groupName: group.name,
      groupAvatarUrl: group.avatar_url,
      members: updatedMembers,
      addMessage: type100Message
    });
    
    // 向所有群组成员广播成员添加事件（不包括新成员）
    broadcastProducer?.enqueue(`group_${groupId}`, 'members-added', {
      groupId: groupId,
      newMemberIds: [parseInt(userId)],
      members: updatedMembers
    });

    res.json({
      status: 'success',
      message: '成功加入群组',
      groupId: groupId,
      groupName: group.name,
      joinMessage: type100Message
    });
  } catch (err) {
    console.error('使用Token加入群组失败:', err.message);
    res.status(500).json({ status: 'error', message: '加入群组失败' });
  }
}

export async function leaveGroup(req, res) {
  try {
    const { groupId } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId) {
      return res.status(400).json({ success: false, message: '参数错误' });
    }

    // 检查群组是否存在
    const [group] = await pool.execute(
      'SELECT id, name, creator_id FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );

    if (!group || group.length === 0) {
      return res.status(404).json({ success: false, message: '群组不存在' });
    }

    // 检查成员是否在群组中
    const [member] = await pool.execute(
      'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, userId]
    );

    if (!member || member.length === 0) {
      return res.status(404).json({ success: false, message: '你不在该群组中' });
    }

    // 不能退出自己是群主的群组
    if (parseInt(group[0].creator_id) === parseInt(userId)) {
      return res.status(400).json({ success: false, message: '群主不能退出群组，请先转让群主或解散群组' });
    }

    // 获取用户信息
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    // 先广播类型100的系统消息：XXX退出了群组
    const now = new Date();
    const leaverNickname = userInfo[0]?.nickname || '用户';
    const leaveContentObj = { [String(userId)]: leaverNickname, action: 'leave' };
    const leaveContent = JSON.stringify(leaveContentObj);
    const [insertResult] = await pool.execute(
      'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
      [userId, leaveContent, 100, groupId]
    );

    // 构建100类型消息对象
    const rawType100Message = {
      id: insertResult.insertId,
      userId: userId,
      nickname: leaverNickname,
      avatarUrl: userInfo[0]?.avatar_url || '',
      content: leaveContent,
      messageType: 100,
      groupId: groupId,
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 过滤群组消息字段
    const type100Message = filterMessageFields(rawType100Message, 'group');

    // 向所有群组成员发送100类型消息（先广播）
    broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);
    
    // 同时也向退出的成员的用户房间发送，确保他们能收到
    io.to(`user_${userId}`).emit('message-received', type100Message);

    // 执行退出操作 - 逻辑删除，只记录deleted_at（加1秒）
    const deletedAt = new Date(Date.now() + 1000);
    await pool.execute(
      'UPDATE scr_group_members SET deleted_at = ? WHERE group_id = ? AND user_id = ?',
      [deletedAt, groupId, userId]
    );

    // 让退出的用户离开群组socket.io房间
    const allOnlineUsers = await getAllOnlineUsersFn();
    for (const onlineUser of allOnlineUsers) {
      if (String(onlineUser.id) === String(userId)) {
        const userSocket = io.sockets.sockets.get(onlineUser.socketId);
        if (userSocket) {
          userSocket.leave(`group_${groupId}`);
        }
      }
    }

    // 向所有群组成员广播成员退出事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'member-removed', { groupId, memberId: userId });

    // 也通知退出的成员
    io.to(`user_${userId}`).emit('member-removed', { groupId, memberId: userId });
    
    res.json({ success: true, message: '成功退出群组' });
  } catch (err) {
    console.error('退出群组失败', err.message);
    res.status(500).json({ success: false, message: '退出群组失败' });
  }
}

export async function dissolveGroup(req, res) {
  try {
    const { groupId, userId: requestUserId } = req.body;
    const userId = req.userId;
    
    // 验证请求中的用户ID是否与会话用户ID一致
    if (requestUserId && String(requestUserId) !== String(userId)) {
      return res.status(403).json({ status: 'error', message: '无效的用户ID' });
    }
    
    // 验证请求参数
    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '缺少必要参数' });
    }
    
    // 检查用户是否是群主（只有群主可以解散群组）
    const isOwner = await isGroupOwner(groupId, userId);
    if (!isOwner) {
      return res.status(403).json({ status: 'error', message: '只有群主可以解散群组' });
    }

    const [groupResults] = await pool.execute(
      'SELECT name, avatar_url FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );

    if (groupResults.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    const group = groupResults[0];
    const groupAvatarUrl = group.avatar_url;
    
    // 获取连接并开始事务
    const connection = await pool.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // 获取群组所有成员
      const [members] = await connection.execute(
        'SELECT user_id FROM scr_group_members WHERE group_id = ?',
        [groupId]
      );
      
      // 设置群组为已删除（标记deleted_at）
      await connection.execute(
        'UPDATE scr_groups SET deleted_at = NOW() WHERE id = ?',
        [groupId]
      );
      
      // 保留成员记录，添加deleted_at 标记
      await connection.execute(
        'UPDATE scr_group_members SET deleted_at = NOW() WHERE group_id = ?',
        [groupId]
      );
      
      // 提交事务
      await connection.commit();
      
      // 删除群头像文件（如果不是默认头像）
      if (groupAvatarUrl && groupAvatarUrl !== '/avatars/default.png') {
        try {
          // 去掉 URL 中的 ?v= 参数，并构建正确的文件路径
          const avatarPathWithoutVersion = groupAvatarUrl.split('?')[0];
          const fullAvatarPath = path.join(process.cwd(), 'public', avatarPathWithoutVersion);
          if (fs.existsSync(fullAvatarPath)) {
            fs.unlinkSync(fullAvatarPath);
          }
        } catch (deleteError) {
          console.error('删除群头像文件失败', deleteError.message);
        }
      }
      
      // 获取当前时间
      const now = new Date();
      
      // 获取群主信息
      const [creatorInfo] = await pool.execute(
        'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
        [userId]
      );
      
      // 只添加一条群组解散消息，发送人是群主
      const dissolvedContent = JSON.stringify({
        [String(userId)]: creatorInfo[0]?.nickname || '',
        groupName: group.name,
        content: '群组已解散',
        action: 'dismiss'
      });
      const [insertResult] = await pool.execute(
        'INSERT INTO scr_messages (user_id, content, message_type, group_id, timestamp) VALUES (?, ?, ?, ?, NOW())',
        [userId, dissolvedContent, 100, groupId]
      );
      
      // 构建100类型消息对象
      const rawType100Message = {
        id: insertResult.insertId,
        userId: userId,
        nickname: creatorInfo[0]?.nickname || '',
        avatarUrl: creatorInfo[0]?.avatar_url || '',
        content: dissolvedContent,
        messageType: 100,
        groupId: groupId,
        timestamp: now.getTime(),
        timestampISO: now.toISOString()
      };
      
      // 过滤群组消息字段
      const type100Message = filterMessageFields(rawType100Message, 'group');
      
      // 广播群组解散消息和事件
      broadcastProducer?.enqueue(`group_${groupId}`, 'message-received', type100Message);
      broadcastProducer?.enqueue(`group_${groupId}`, 'group-dissolved', {
        groupId: groupId,
        groupName: group.name,
        dissolvedBy: userId,
        dissolvedMessage: type100Message
      });
      
      // 让所有在线成员离开群组socket.io房间
      const allOnlineUsers = await getAllOnlineUsersFn();
      for (const member of members) {
        for (const onlineUser of allOnlineUsers) {
          if (String(onlineUser.id) === String(member.user_id)) {
            const memberSocket = io.sockets.sockets.get(onlineUser.socketId);
            if (memberSocket) {
              memberSocket.leave(`group_${groupId}`);
            }
          }
        }
      }
      
      res.json({ 
        status: 'success', 
        message: '群组已成功解散',
        groupId: groupId,
        groupName: group.name
      });
    } catch (transactionErr) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('❌ 回滚事务失败:', rollbackErr.message);
      }
      throw transactionErr;
    } finally {
      // 无论成功失败都释放连接，防止连接池泄漏
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('❌ 释放连接失败:', releaseErr.message);
      }
    }
  } catch (err) {
    console.error('解散群组失败:', err.message);
    res.status(500).json({ status: 'error', message: '解散群组失败' });
  }
}

export async function updateGroupName(req, res) {
  try {
    const { groupId, newGroupName } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || !newGroupName) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    if (!validateNickname(newGroupName)) {
      return res.status(400).json({ status: 'error', message: '群组名称格式错误' });
    }

    // 检查用户是否是群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以修改群组名称' });
    }

    // 更新群组名称
    await pool.execute(
      'UPDATE scr_groups SET name = ? WHERE id = ? AND deleted_at IS NULL',
      [newGroupName, groupId]
    );

    // 向所有群组成员广播群组名称更新事件（使用群组房间）
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-name-updated', {
      groupId: groupId,
      newGroupName: newGroupName
    });

    res.json({ status: 'success', message: '群组名称已更新', newGroupName: newGroupName });
  } catch (err) {
    console.error('修改群组名称失败:', err.message);
    res.status(500).json({ status: 'error', message: '服务器错误，请重试' });
  }
}

export async function updateGroupDescription(req, res) {
  try {
    const { groupId, newDescription } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查用户是否是群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以修改群组公告' });
    }

    // 更新群组描述
    await pool.execute(
      'UPDATE scr_groups SET description = ? WHERE id = ? AND deleted_at IS NULL',
      [newDescription, groupId]
    );

    // 向所有群组成员广播群组公告更新事件（使用群组房间）
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-description-updated', {
      groupId: groupId,
      newDescription: newDescription
    });

    res.json({ status: 'success', message: '群组公告已更新', newDescription: newDescription });
  } catch (err) {
    console.error('修改群组公告失败:', err.message);
    res.status(500).json({ status: 'error', message: '服务器错误，请重试' });
  }
}

export async function muteGroupMember(req, res) {
  try {
    const { groupId, memberId, duration } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || !memberId) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查请求者是否为群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以禁言成员' });
    }

    // 检查目标成员是否在群组中
    const [member] = await pool.execute(
      'SELECT gm.id, gm.user_id, u.id as uid, g.creator_id FROM scr_group_members gm JOIN scr_users u ON gm.user_id = u.id JOIN scr_groups g ON gm.group_id = g.id WHERE gm.group_id = ? AND gm.user_id = ? AND gm.deleted_at IS NULL',
      [groupId, memberId]
    );

    if (!member || member.length === 0) {
      return res.status(404).json({ status: 'error', message: '该成员不在群组中' });
    }

    // 不能禁言群主
    if (parseInt(member[0].creator_id) === parseInt(memberId)) {
      return res.status(400).json({ status: 'error', message: '不能禁言群主' });
    }

    // 管理员不能禁言其他管理员（只有群主可以）
    const isOwner = await isGroupOwner(groupId, userId);
    if (!isOwner) {
      const [targetMember] = await pool.execute(
        'SELECT is_admin FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
        [groupId, memberId]
      );
      if (targetMember.length > 0 && targetMember[0].is_admin === 1) {
        return res.status(403).json({ status: 'error', message: '只有群主可以禁言管理员' });
      }
    }

    // 计算禁言值（优化后的单字段设计）
    // is_muted: NULL=未禁言, '9999-12-31 23:59:59'=永久禁言, 时间戳=临时禁言截止时间
    let mutedValue;
    
    if (duration !== undefined && duration !== null) {
      if (typeof duration !== 'number' || isNaN(duration)) {
        return res.status(400).json({ 
          status: 'error', 
          message: '禁言时长必须是数字',
          code: 'INVALID_DURATION_TYPE'
        });
      }
      
      if (duration < 0) {
        return res.status(400).json({ 
          status: 'error', 
          message: '禁言时长不能为负数',
          code: 'NEGATIVE_DURATION'
        });
      }
      
      if (duration === 0) {
        // duration 为 0 表示永久禁言
        mutedValue = '9999-12-31 23:59:59';
      } else {
        // 临时禁言：存储截止时间戳（统一使用 UTC，与运行环境时区无关）
        const now = new Date();
        const mutedUntilDate = new Date(now.getTime() + duration * 60 * 1000);
        
        // 验证：确保计算的禁言时间比当前时间晚
        if (mutedUntilDate.getTime() <= now.getTime()) {
          return res.status(400).json({ 
            status: 'error', 
            message: '禁言截止时间必须晚于当前时间，请设置有效的禁言时长',
            code: 'INVALID_MUTE_TIME'
          });
        }
        
        // 验证：防止极端情况（如 duration 过大导致的时间溢出）
        const maxMuteYears = 100;
        const maxMuteTime = new Date(now.getTime() + maxMuteYears * 365.25 * 24 * 60 * 60 * 1000);
        if (mutedUntilDate.getTime() > maxMuteTime.getTime()) {
          // 超过100年，自动转为永久禁言
          mutedValue = '9999-12-31 23:59:59';
        } else {
          // 转换为 UTC 格式：YYYY-MM-DD HH:mm:ss（toISOString 恒为 UTC）
          mutedValue = mutedUntilDate.toISOString().slice(0, 19).replace('T', ' ');

          // 最终验证：按 UTC 解析确保仍然有效
          const parsedMutedTime = new Date(mutedValue.replace(' ', 'T') + 'Z');
          if (isNaN(parsedMutedTime.getTime()) || parsedMutedTime.getTime() <= now.getTime()) {
            return res.status(500).json({ 
              status: 'error', 
              message: '禁言时间计算错误，请重试',
              code: 'MUTE_TIME_CALCULATION_ERROR'
            });
          }
        }
      }
    } else {
      // 未提供 duration 参数，默认为永久禁言
      mutedValue = '9999-12-31 23:59:59';
    }

    // 执行禁言操作（使用单一字段 is_muted）
    const [updateResult] = await pool.execute(
      'UPDATE scr_group_members SET is_muted = ? WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [mutedValue, groupId, memberId]
    );

    // 获取被禁言用户信息
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [memberId]
    );

    // 向所有群组成员广播禁言事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'member-muted', {
      groupId: groupId,
      userId: memberId,
      nickname: userInfo[0]?.nickname || '',
      mutedUntil: mutedValue,
      serverNow: Date.now(),
      isPermanent: !duration || duration <= 0,
      duration: duration
    });

    // 也通知被禁言的用户
    io.to(`user_${memberId}`).emit('member-muted', {
      groupId: groupId,
      mutedUntil: mutedValue,
      serverNow: Date.now(),
      isPermanent: !duration || duration <= 0,
      duration: duration
    });

    res.json({
      status: 'success',
      message: duration > 0 ? `已禁言${duration}分钟` : '已永久禁言',
      mutedUntil: mutedValue,
      serverNow: Date.now(),
      isPermanent: !duration || duration <= 0
    });
  } catch (err) {
    console.error('禁言成员失败:', err.message);
    res.status(500).json({ status: 'error', message: '禁言成员失败' });
  }
}

export async function unmuteGroupMember(req, res) {
  try {
    const { groupId, memberId } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || !memberId) {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查请求者是否为群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以解除禁言' });
    }

    // 检查目标成员是否在群组中
    const [member] = await pool.execute(
      'SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, memberId]
    );

    if (!member || member.length === 0) {
      return res.status(404).json({ status: 'error', message: '该成员不在群组中' });
    }

    // 执行解除禁言操作（设置为NULL表示未禁言）
    await pool.execute(
      'UPDATE scr_group_members SET is_muted = NULL WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [groupId, memberId]
    );

    // 获取用户信息
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [memberId]
    );

    // 向所有群组成员广播解除禁言事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'member-unmuted', {
      groupId: groupId,
      userId: memberId,
      nickname: userInfo[0]?.nickname || ''
    });

    // 也通知被解除禁言的用户
    io.to(`user_${memberId}`).emit('member-unmuted', {
      groupId: groupId
    });

    res.json({ status: 'success', message: '已解除禁言' });
  } catch (err) {
    console.error('解除禁言失败:', err.message);
    res.status(500).json({ status: 'error', message: '解除禁言失败' });
  }
}

export async function setMuteAll(req, res) {
  try {
    const { groupId, isMuteAll } = req.body;
    const userId = req.userId;

    // 验证参数
    if (!groupId || typeof isMuteAll !== 'boolean') {
      return res.status(400).json({ status: 'error', message: '参数错误' });
    }

    // 检查请求者是否为群主或管理员
    const hasPermission = await isGroupAdmin(groupId, userId);
    if (!hasPermission) {
      return res.status(403).json({ status: 'error', message: '只有群主或管理员可以设置全员禁言' });
    }

    // 执行全员禁言/解禁操作
    await pool.execute(
      'UPDATE scr_groups SET is_mute_all = ? WHERE id = ? AND deleted_at IS NULL',
      [isMuteAll ? 1 : 0, groupId]
    );

    // 向所有群组成员广播全员禁言状态变更事件
    broadcastProducer?.enqueue(`group_${groupId}`, 'mute-all-changed', {
      groupId: groupId,
      isMuteAll: isMuteAll,
      operatedBy: userId
    });

    res.json({
      status: 'success',
      message: isMuteAll ? '已开启全员禁言' : '已关闭全员禁言',
      isMuteAll: isMuteAll
    });
  } catch (err) {
    console.error('设置全员禁言失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置全员禁言失败' });
  }
}

export async function getMuteStatus(req, res) {
  try {
    const groupId = req.params.groupId;

    // 获取群组的全员禁言状态
    const [groupInfo] = await pool.execute(
      'SELECT is_mute_all FROM scr_groups WHERE id = ? AND deleted_at IS NULL',
      [groupId]
    );

    if (!groupInfo || groupInfo.length === 0) {
      return res.status(404).json({ status: 'error', message: '群组不存在' });
    }

    // 获取所有成员的禁言状态（优化后的单字段设计）
    const [members] = await pool.execute(`
      SELECT u.id, u.nickname, DATE_FORMAT(gm.is_muted, '%Y-%m-%d %H:%i:%s') AS is_muted
      FROM scr_group_members gm
      JOIN scr_users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.deleted_at IS NULL
    `, [groupId]);

    // 处理成员禁言状态
    const processedMembers = members.map(m => {
      let isMuted = false;
      let mutedUntil = null;
      let isPermanent = false;

      if (m.is_muted !== null) {
        const mutedValue = String(m.is_muted);
        
        // 判断是否为永久禁言（存储为'9999-12-31 23:59:59'）
        if (mutedValue.includes('9999')) {
          isMuted = true;
          isPermanent = true;
        } else {
          // 临时禁言，检查是否已过期（存储为 UTC 时间，显式按 UTC 解析）
          const mutedTime = new Date(mutedValue.replace(' ', 'T') + 'Z');
          if (!isNaN(mutedTime.getTime())) {
            const now = new Date();
            const diffMs = mutedTime.getTime() - now.getTime();
            
            if (diffMs > 0) {
              // 未过期，返回禁言状态和截止时间
              isMuted = true;
              mutedUntil = m.is_muted;
            }
            // 已过期的不设置 isMuted，相当于自动解除禁言
          }
        }
      }

      return {
        id: Number(m.id),
        nickname: m.nickname,
        isMuted: isMuted,
        mutedUntil: mutedUntil,
        isPermanent: isPermanent
      };
    });

    res.json({
      status: 'success',
      isMuteAll: groupInfo[0].is_mute_all === 1,
      serverNow: Date.now(),
      members: processedMembers
    });
  } catch (err) {
    console.error('获取禁言状态失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取禁言状态失败' });
  }
}

export async function setGroupRemark(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { groupId, remark } = req.body;

    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '群组ID不能为空' });
    }

    if (remark !== null && typeof remark !== 'string') {
      return res.status(400).json({ status: 'error', message: '备注格式不正确' });
    }

    if (remark && remark.length > 100) {
      return res.status(400).json({ status: 'error', message: '备注长度不能超过100个字符' });
    }

    // 验证用户是否是该群组的成员
    const [memberCheck] = await pool.execute(
      `SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL`,
      [groupId, userId]
    );

    if (memberCheck.length === 0) {
      return res.status(403).json({ status: 'error', message: '您不是该群组成员，无法设置备注' });
    }

    const remarkValue = (remark && remark.trim()) ? remark.trim() : null;

    // 直接更新成员表的备注字段
    await pool.execute(
      `UPDATE scr_group_members SET remark = ? WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL`,
      [remarkValue, groupId, userId]
    );

    res.json({
      status: 'success',
      message: remarkValue ? '备注设置成功' : '备注已清除',
      remark: remarkValue
    });
  } catch (err) {
    console.error('设置群组备注失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置群组备注失败' });
  }
}

export async function getGroupRemark(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '群组ID不能为空' });
    }

    const [remarkData] = await pool.execute(
      `SELECT remark FROM scr_group_members WHERE user_id = ? AND group_id = ? AND deleted_at IS NULL`,
      [userId, parseInt(groupId)]
    );

    const remark = remarkData.length > 0 ? remarkData[0].remark : null;

    res.json({
      status: 'success',
      remark: remark
    });
  } catch (err) {
    console.error('获取群组备注失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群组备注失败' });
  }
}

export async function setGroupNickname(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { groupId, groupNickname } = req.body;

    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '群组ID不能为空' });
    }

    if (groupNickname !== null && typeof groupNickname !== 'string') {
      return res.status(400).json({ status: 'error', message: '群昵称格式不正确' });
    }

    if (groupNickname && groupNickname.length > 50) {
      return res.status(400).json({ status: 'error', message: '群昵称长度不能超过50个字符' });
    }

    const nicknameValue = (groupNickname && groupNickname.trim()) ? groupNickname.trim() : null;

    const [memberCheck] = await pool.execute(
      `SELECT id FROM scr_group_members WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL`,
      [groupId, userId]
    );

    if (memberCheck.length === 0) {
      return res.status(403).json({ status: 'error', message: '您不是该群组成员，无法设置群昵称' });
    }

    await pool.execute(
      `UPDATE scr_group_members SET group_nickname = ? WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL`,
      [nicknameValue, groupId, userId]
    );

    // 获取用户信息用于通知
    const [userInfo] = await pool.execute(
      'SELECT id, nickname, avatar_url FROM scr_users WHERE id = ?',
      [userId]
    );

    // ✨ 优化：使用专门的Socket事件通知群昵称更新（不保存到数据库）
    const now = new Date();
    const nicknameEvent = {
      action: nicknameValue ? 'update_group_nickname' : 'clear_group_nickname',
      userId: userId,
      groupId: groupId,
      nickname: userInfo[0]?.nickname || '',
      newNickname: nicknameValue || null,
      avatarUrl: userInfo[0]?.avatar_url || '',
      timestamp: now.getTime(),
      timestampISO: now.toISOString()
    };

    // 向当前群组发送专用事件（不经过message-received通道）
    broadcastProducer?.enqueue(`group_${groupId}`, 'group-nickname-updated', nicknameEvent);

    res.json({
      status: 'success',
      message: nicknameValue ? '群昵称设置成功' : '群昵称已清除',
      group_nickname: nicknameValue
    });
  } catch (err) {
    console.error('设置群昵称失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置群昵称失败' });
  }
}

export async function getGroupNickname(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '群组ID不能为空' });
    }

    const [nicknameData] = await pool.execute(
      `SELECT group_nickname FROM scr_group_members WHERE user_id = ? AND group_id = ? AND deleted_at IS NULL`,
      [userId, parseInt(groupId)]
    );

    const groupNickname = nicknameData.length > 0 ? nicknameData[0].group_nickname : null;

    res.json({
      status: 'success',
      group_nickname: groupNickname
    });
  } catch (err) {
    console.error('获取群昵称失败:', err.message);
    res.status(500).json({ status: 'error', message: '获取群昵称失败' });
  }
}

export async function handleSetGroupDisturb(req, res) {
  try {
    const userId = parseInt(req.userId);
    const { groupId, isDisturb } = req.body;

    if (!groupId) {
      return res.status(400).json({ status: 'error', message: '群组ID不能为空' });
    }

    if (typeof isDisturb !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'isDisturb必须是布尔值' });
    }

    const [result] = await pool.execute(
      'UPDATE scr_group_members SET is_disturb = ? WHERE group_id = ? AND user_id = ? AND deleted_at IS NULL',
      [isDisturb ? 1 : 0, groupId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ status: 'error', message: '未找到该群组成员记录' });
    }

    // 取消免打扰时，设置用户的该群组最后已读消息id为当前群组最大消息id
    if (!isDisturb) {
      try {
        // 最新消息ID走 Redis 缓存（发消息/撤回路径写入），缓存未命中才回源 DB 一次
        const cacheKey = `scr:max_msg_id:group:${groupId}`;
        let maxMessageId = parseInt(await redisClient.get(cacheKey)) || 0;
        if (maxMessageId <= 0) {
          const [maxRows] = await pool.execute(
            'SELECT MAX(id) as maxId FROM scr_messages WHERE group_id = ?',
            [groupId]
          );
          maxMessageId = maxRows[0]?.maxId || 0;
          if (maxMessageId > 0) {
            redisClient.set(cacheKey, String(maxMessageId)).catch(() => {});
          }
        }
        if (maxMessageId > 0) {
          await redisClient.set(`scr:read:group:${groupId}:${userId}`, String(maxMessageId));
        }
      } catch (e) {
        console.error('设置群组最后已读消息id失败:', e.message);
      }
    }

    res.json({
      status: 'success',
      message: isDisturb ? '已开启免打扰' : '已关闭免打扰',
      is_disturb: isDisturb ? 1 : 0
    });
  } catch (err) {
    console.error('设置群组免打扰失败:', err.message);
    res.status(500).json({ status: 'error', message: '设置群组免打扰失败' });
  }
}

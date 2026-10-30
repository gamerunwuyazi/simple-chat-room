// 收藏服务（服务端）
//
// 设计约束（产品需求）：
//   1. 每用户最多 300 条收藏
//   2. 每用户最多 100 条「文件类」收藏（图片/视频/音频/文件都算）
//   3. 文件类收藏总大小不超过 512MB，任一限制超出都直接拒绝
//   4. 收藏不复制文件：只记录原文件 URL，可用性完全跟随原文件
//      （uploads 目录保留 FILE_RETENTION_DAYS=7 天，由每日定时任务清理）
//   5. 换设备靠"手动备份"：旧设备上传到 scr_favorite_backups（24 小时），
//      新设备取回，每月 3 次（见 favoriteBackupService.js）
import fs from 'fs';
import path from 'path';
import { pool } from '../models/database.js';
import { uploadConfig, cronConfig } from '../config/index.js';

// ============================================
// 限额常量
// ============================================
const MAX_FAVORITES = 300;                 // 收藏总数上限
const MAX_FILE_FAVORITES = 100;            // 文件类收藏数量上限
const MAX_FILE_TOTAL_BYTES = 512 * 1024 * 1024; // 文件类总大小上限（512MB）

// 文件类分类（非文字）
const FILE_CATEGORIES = ['image', 'video', 'audio', 'file'];
// 合法分类
const VALID_CATEGORIES = ['text', ...FILE_CATEGORIES];
// 合法来源
const VALID_SOURCES = ['global', 'group', 'private'];

function isFileCategory(category) {
  return FILE_CATEGORIES.includes(category);
}

/**
 * 把消息里的文件 URL 解析成服务器本地绝对路径。
 * 仅接受站内相对路径（/uploads/xxx.png）；外链返回 null（无本地文件）。
 */
export function resolveLocalFilePath(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return null;
  // 去掉可能的 query/hash
  const clean = fileUrl.split('?')[0].split('#')[0];
  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('//')) {
    return null;
  }
  // uploads 静态目录：/uploads/xxx → <cwd>/public/uploads/xxx
  const uploadDir = path.join(process.cwd(), uploadConfig.uploadDir);
  let rel = clean;
  if (clean.startsWith('/uploads/')) {
    rel = clean.slice('/uploads/'.length);
  } else if (clean.startsWith('uploads/')) {
    rel = clean.slice('uploads/'.length);
  } else if (clean.startsWith('/')) {
    rel = clean.slice(1);
  }
  // 防目录穿越
  const abs = path.normalize(path.join(uploadDir, rel));
  if (!abs.startsWith(path.normalize(uploadDir))) return null;
  return abs;
}

/**
 * 原文件是否仍可用：存在且 mtime 在规定保留期内。
 * 与每日清理任务（cleanExpiredFiles 用 mtime 判断）保持完全一致的判定口径，
 * 避免"前端显示可用、清理任务已删"或反过来的不一致。
 */
function isOriginalFileAvailable(fileUrl) {
  const abs = resolveLocalFilePath(fileUrl);
  if (!abs) return false;
  try {
    const stat = fs.statSync(abs);
    const retentionMs = (Number(cronConfig.fileRetentionDays) || 7) * 24 * 60 * 60 * 1000;
    return stat.mtime.getTime() >= Date.now() - retentionMs;
  } catch {
    return false;
  }
}

function safeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 120) || 'file';
}

/** 给数据库行补上 fileAvailable（原文件是否仍可访问） */
function withAvailability(row) {
  return {
    ...row,
    fileAvailable: isFileCategory(row.category) ? isOriginalFileAvailable(row.fileUrl) : false
  };
}

// ============================================
// 查询
// ============================================

/** 获取某用户全部收藏（按收藏时间倒序） */
export async function getFavorites(userId) {
  const [rows] = await pool.execute(
    `SELECT id, message_id AS messageId, source, category, message_type AS messageType,
            content, nickname, avatar_url AS avatarUrl, filename, file_size AS fileSize,
            file_url AS fileUrl, msg_timestamp AS msgTimestamp, favorited_at AS favoritedAt
       FROM scr_favorites
      WHERE user_id = ?
      ORDER BY favorited_at DESC, id DESC`,
    [userId]
  );
  return rows.map(withAvailability);
}

/** 查询单条收藏（校验归属） */
export async function getFavoriteById(userId, favId) {
  const [rows] = await pool.execute(
    `SELECT id, user_id AS userId, message_id AS messageId, source, category,
            message_type AS messageType, content, nickname, avatar_url AS avatarUrl,
            filename, file_size AS fileSize, file_url AS fileUrl,
            msg_timestamp AS msgTimestamp, favorited_at AS favoritedAt
       FROM scr_favorites
      WHERE id = ? AND user_id = ?`,
    [favId, userId]
  );
  return rows[0] ? withAvailability(rows[0]) : null;
}

// ============================================
// 新增（含限额校验）
// ============================================

/**
 * 添加收藏。
 * @returns {{ ok: true, favorite } | { ok: false, error: string }}
 */
export async function addFavorite(userId, payload) {
  const {
    messageId, source, category, messageType,
    content, nickname, avatarUrl, filename, fileSize, fileUrl, msgTimestamp: rawMsgTimestamp
  } = payload || {};

  // msg_timestamp 是 BIGINT（毫秒）。客户端的 message.timestamp 可能是
  // MySQL 时间戳字符串（"2026-07-26 20:37:21"）、ISO 字符串或数字，统一归一化；
  // 无法解析就存 null，绝不让非法值进 BIGINT 列（MySQL 1265 Data truncated）。
  let msgTimestamp = null;
  if (rawMsgTimestamp !== undefined && rawMsgTimestamp !== null && rawMsgTimestamp !== '') {
    const n = Number(rawMsgTimestamp);
    if (Number.isFinite(n) && n > 0) {
      msgTimestamp = Math.floor(n);
    } else {
      const d = new Date(rawMsgTimestamp);
      if (!Number.isNaN(d.getTime())) msgTimestamp = d.getTime();
    }
  }

  // ---- 基础校验 ----
  if (messageId === undefined || messageId === null) {
    return { ok: false, error: '缺少 messageId' };
  }
  if (!VALID_SOURCES.includes(source)) {
    return { ok: false, error: `非法来源: ${source}` };
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return { ok: false, error: `非法分类: ${category}` };
  }

  // ---- 限额1：收藏总数 ≤ 300 ----
  const [[countRow]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM scr_favorites WHERE user_id = ?',
    [userId]
  );
  if (countRow.cnt >= MAX_FAVORITES) {
    return { ok: false, error: `收藏数量已达上限 ${MAX_FAVORITES} 条` };
  }

  const wantFile = isFileCategory(category);
  const declaredSize = Number.isFinite(Number(fileSize)) ? Math.max(0, parseInt(fileSize, 10) || 0) : 0;

  // 文件类：以原文件实际大小为准（不信客户端申报值），原文件不存在则按申报值
  // 记入元数据（不至于因原文件已被清理而无法收藏），但绝不因此放行超额
  let actualSize = declaredSize;
  const localPath = wantFile ? resolveLocalFilePath(fileUrl) : null;
  if (localPath) {
    try {
      actualSize = fs.statSync(localPath).size;
    } catch { /* 原文件已不存在，沿用申报值 */ }
  }

  if (wantFile) {
    // ---- 限额2：文件类数量 ≤ 100 ----
    const [[fileCountRow]] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM scr_favorites WHERE user_id = ? AND category IN (?,?,?,?)',
      [userId, ...FILE_CATEGORIES]
    );
    if (fileCountRow.cnt >= MAX_FILE_FAVORITES) {
      return { ok: false, error: `文件类收藏数量已达上限 ${MAX_FILE_FAVORITES} 条` };
    }

    // ---- 限额3：文件类总大小 ≤ 512MB ----
    const [[sizeRow]] = await pool.execute(
      'SELECT COALESCE(SUM(file_size), 0) AS total FROM scr_favorites WHERE user_id = ? AND category IN (?,?,?,?)',
      [userId, ...FILE_CATEGORIES]
    );
    const used = Number(sizeRow.total) || 0;
    if (used + actualSize > MAX_FILE_TOTAL_BYTES) {
      const remainMB = Math.max(0, Math.floor((MAX_FILE_TOTAL_BYTES - used) / 1024 / 1024));
      return { ok: false, error: `文件类收藏总大小将超出 512MB 上限（当前剩余约 ${remainMB}MB）` };
    }
  }

  // ---- 插入记录 ----
  let insertId;
  try {
    const [result] = await pool.execute(
      `INSERT INTO scr_favorites
        (user_id, message_id, source, category, message_type, content, nickname, avatar_url,
         filename, file_size, file_url, msg_timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, messageId, source, category, messageType || 0,
        content ?? '', nickname ?? '', avatarUrl ?? '',
        filename ?? '', wantFile ? actualSize : 0,
        wantFile ? (fileUrl || null) : null,
        msgTimestamp ?? null
      ]
    );
    insertId = result.insertId;
  } catch (err) {
    // 唯一键冲突 = 已收藏过
    if (err.code === 'ER_DUP_ENTRY') {
      return { ok: false, error: '该消息已收藏' };
    }
    throw err;
  }

  const favorite = await getFavoriteById(userId, insertId);
  return { ok: true, favorite };
}

// ============================================
// 删除
// ============================================

export async function removeFavorite(userId, favId) {
  const favorite = await getFavoriteById(userId, favId);
  if (!favorite) return { ok: false, error: '收藏不存在' };

  // 原文件不归收藏管理，不删；只清理该收藏可能存在的备份文件（磁盘 + 记录）
  const [backups] = await pool.execute(
    'SELECT file_path AS filePath FROM scr_favorite_backups WHERE user_id = ? AND favorite_id = ?',
    [userId, favId]
  );
  for (const b of backups) {
    try { if (b.filePath && fs.existsSync(b.filePath)) fs.unlinkSync(b.filePath); } catch { /* ignore */ }
  }
  if (backups.length > 0) {
    await pool.execute(
      'DELETE FROM scr_favorite_backups WHERE user_id = ? AND favorite_id = ?',
      [userId, favId]
    );
    // 顺手清空批次目录
    const batchDirs = new Set(backups.map(b => path.dirname(b.filePath)));
    for (const dir of batchDirs) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* ignore */ }
    }
  }

  await pool.execute('DELETE FROM scr_favorites WHERE id = ? AND user_id = ?', [favId, userId]);
  return { ok: true };
}

export const FAVORITE_LIMITS = {
  MAX_FAVORITES,
  MAX_FILE_FAVORITES,
  MAX_FILE_TOTAL_BYTES
};

export { FILE_CATEGORIES, safeFilename, isOriginalFileAvailable };

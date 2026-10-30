// 收藏文件备份服务
//
// 用途：用户换设备时的"手动搬家"通道。
//   旧设备：把所有收藏文件（本地 IndexedDB 里的 blob）上传到服务端
//   新设备：取回这些文件并写回本地 IndexedDB
//
// 约束：
//   1. 备份文件只保留 24 小时（按小时精度清理，整点跑）
//   2. 每个用户每个自然月最多上传 3 次（batch 维度）
//   3. 单次上传总大小 ≤ 512MB（防止变成免费网盘）
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool, redisClient } from '../models/database.js';

const BACKUP_ROOT = path.join(process.cwd(), 'storage', 'favorites-backup');
const MAX_UPLOADS_PER_MONTH = 3;
const RETENTION_HOURS = 24;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  return base.slice(0, 120) || 'file';
}

// ============================================
// 每月上传次数（Redis 计数）
// ============================================
// 不能从 backups 表 count：备份 24 小时后会被清理，次数会跟着"重置"。
// 用 Redis 独立计数，key 带月份，TTL 到"下个月 1 号 0 点"，
// 过期即自动清零，无需任何清理任务。
function usageKey(userId) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `scr:fav_backup_usage:${userId}:${month}`;
}

/** 距离下个月 1 号 0 点的秒数（至少 60 秒，避免跨月瞬间 TTL 过小） */
function secondsUntilNextMonth() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(60, Math.floor((next.getTime() - now.getTime()) / 1000));
}

/** 本月已用上传次数 */
export async function getMonthlyUploadCount(userId) {
  const value = await redisClient.get(usageKey(userId));
  return Number(value) || 0;
}

/**
 * 累加本月次数并保证 key 在下个月 1 号过期。
 * 用 Lua 保证 INCR 与 EXPIRE 的原子性，避免进程在两条命令之间崩溃
 * 导致 key 永久驻留（配额永远不清零）。
 */
async function incrementMonthlyUploadCount(userId) {
  const key = usageKey(userId);
  const ttl = secondsUntilNextMonth();
  const count = await redisClient.eval(
    `local c = redis.call('INCR', KEYS[1])
     if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return c`,
    { keys: [key], arguments: [String(ttl)] }
  );
  return Number(count) || 1;
}

/** 本用户当前可用的备份列表 + 配额信息 */
export async function listBackups(userId) {
  const [rows] = await pool.execute(
    `SELECT b.id, b.favorite_id AS favoriteId, b.batch_id AS batchId,
            b.filename, b.file_size AS fileSize, b.created_at AS createdAt,
            b.expires_at AS expiresAt,
            f.message_id AS messageId, f.source, f.category
       FROM scr_favorite_backups b
       JOIN scr_favorites f ON f.id = b.favorite_id
      WHERE b.user_id = ? AND b.expires_at > NOW()
      ORDER BY b.created_at DESC, b.id DESC`,
    [userId]
  );
  const used = await getMonthlyUploadCount(userId);
  return {
    backups: rows,
    uploadsUsed: used,
    uploadsLeft: Math.max(0, MAX_UPLOADS_PER_MONTH - used),
    uploadsPerMonth: MAX_UPLOADS_PER_MONTH,
    retentionHours: RETENTION_HOURS
  };
}

/**
 * 创建一次备份上传。
 * @param {number} userId
 * @param {Array<{favoriteId:number, filename:string, tempPath:string, size:number}>} files
 *        multer 已落盘到临时目录的文件
 * @returns {{ok:true, batchId:string, count:number, uploadsLeft:number, expiresAt:Date}
 *          | {ok:false, error:string, status?:number}}
 */
export async function createBackupBatch(userId, files) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: '没有可上传的文件' };
  }

  const used = await getMonthlyUploadCount(userId);
  if (used >= MAX_UPLOADS_PER_MONTH) {
    return { ok: false, error: `本月上传次数已用完（每月 ${MAX_UPLOADS_PER_MONTH} 次）`, status: 429 };
  }

  // 校验归属：只能备份自己的、文件类收藏
  const ids = [...new Set(files.map(f => parseInt(f.favoriteId, 10)).filter(Number.isInteger))];
  if (ids.length === 0) return { ok: false, error: '缺少 favoriteId' };

  const [owned] = await pool.execute(
    `SELECT id, category FROM scr_favorites
      WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [userId, ...ids]
  );
  const ownedMap = new Map(owned.map(r => [r.id, r.category]));
  for (const id of ids) {
    const cat = ownedMap.get(id);
    if (!cat) return { ok: false, error: `收藏 ${id} 不存在` };
    if (cat === 'text') return { ok: false, error: '文字类收藏无需上传文件' };
  }

  const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  if (total > MAX_BATCH_BYTES) {
    return { ok: false, error: '单次上传总大小超过 512MB 上限' };
  }

  const batchId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const batchDir = path.join(BACKUP_ROOT, String(userId), batchId);
  ensureDir(batchDir);

  const expiresAt = new Date(Date.now() + RETENTION_HOURS * 60 * 60 * 1000);
  let saved = 0;
  try {
    for (const f of files) {
      const dest = path.join(batchDir, `${f.favoriteId}_${safeFilename(f.filename)}`);
      fs.renameSync(f.tempPath, dest);
      const size = fs.statSync(dest).size;
      await pool.execute(
        `INSERT INTO scr_favorite_backups
          (user_id, favorite_id, batch_id, filename, file_path, file_size, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, f.favoriteId, batchId, f.filename || path.basename(dest), dest, size, expiresAt]
      );
      saved++;
    }
  } catch (err) {
    console.error('保存收藏备份失败:', err.message);
    // 回滚本批：删已落盘文件与记录
    try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    await pool.execute('DELETE FROM scr_favorite_backups WHERE user_id = ? AND batch_id = ?', [userId, batchId]);
    return { ok: false, error: '保存备份失败' };
  }

  // 成功后累加本月次数（Redis，TTL 到下个月 1 号）
  const usedAfter = await incrementMonthlyUploadCount(userId);
  return {
    ok: true,
    batchId,
    count: saved,
    uploadsLeft: Math.max(0, MAX_UPLOADS_PER_MONTH - usedAfter),
    expiresAt
  };
}

/** 取一条备份（校验归属与有效期） */
export async function getBackupById(userId, backupId) {
  const [rows] = await pool.execute(
    `SELECT id, user_id AS userId, favorite_id AS favoriteId, filename,
            file_path AS filePath, file_size AS fileSize, expires_at AS expiresAt
       FROM scr_favorite_backups
      WHERE id = ? AND user_id = ?`,
    [backupId, userId]
  );
  return rows[0] || null;
}

/**
 * 清理过期备份：删磁盘文件 + 删记录 + 清空目录。
 * 设计为每小时整点执行（按小时精度）。
 */
export async function cleanupExpiredBackups() {
  const [expired] = await pool.execute(
    'SELECT id, file_path AS filePath FROM scr_favorite_backups WHERE expires_at <= NOW()'
  );
  if (expired.length === 0) return { removed: 0 };

  const dirs = new Set();
  for (const row of expired) {
    try {
      if (row.filePath && fs.existsSync(row.filePath)) fs.unlinkSync(row.filePath);
      if (row.filePath) dirs.add(path.dirname(row.filePath));
    } catch (err) {
      console.error('清理备份文件失败:', err.message);
    }
  }
  await pool.execute('DELETE FROM scr_favorite_backups WHERE expires_at <= NOW()');

  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }
  // 顺手清理空用户目录
  try {
    if (fs.existsSync(BACKUP_ROOT)) {
      for (const uid of fs.readdirSync(BACKUP_ROOT)) {
        const dir = path.join(BACKUP_ROOT, uid);
        if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
    }
  } catch { /* ignore */ }

  console.log(`🧹 已清理 ${expired.length} 个过期收藏备份文件`);
  return { removed: expired.length };
}

export const BACKUP_LIMITS = {
  MAX_UPLOADS_PER_MONTH,
  RETENTION_HOURS,
  MAX_BATCH_BYTES
};

export { BACKUP_ROOT };

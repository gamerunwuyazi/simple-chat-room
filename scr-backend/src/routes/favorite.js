import fs from 'fs';
import path from 'path';
import multer from 'multer';
import {
  getFavorites,
  addFavorite,
  removeFavorite
} from '../services/favoriteService.js';
import {
  listBackups,
  createBackupBatch,
  getBackupById
} from '../services/favoriteBackupService.js';
import { BACKUP_ROOT, BACKUP_LIMITS } from '../services/favoriteBackupService.js';

// 备份上传：先落到临时目录，校验通过后再挪到批次目录
const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(BACKUP_ROOT, 'tmp', String(req.userId || 'unknown'));
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, unique);
    }
  }),
  limits: {
    files: 100,
    fileSize: BACKUP_LIMITS.MAX_BATCH_BYTES
  }
});

export function setupRoutes(app, io) {
  // ============================================
  // 收藏文件备份（换设备手动搬运）
  // ============================================

  // 上传：multipart，字段名 files（可多个）+ meta（JSON 数组，按顺序对应 favoriteId/filename）
  app.post('/api/favorites/backup', (req, res) => {
    backupUpload.array('files', 100)(req, res, async (uploadErr) => {
      if (uploadErr) {
        const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
          ? '单个文件超过 512MB 上限'
          : uploadErr.code === 'LIMIT_FILE_COUNT'
            ? '一次最多上传 100 个文件'
            : '文件上传失败';
        return res.status(400).json({ status: 'error', message: msg });
      }
      try {
        const userId = parseInt(req.userId, 10);
        if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });

        let meta = [];
        try { meta = JSON.parse(req.body?.meta || '[]'); } catch { meta = []; }
        if (!Array.isArray(meta)) meta = [];

        const uploaded = (req.files || []).map((f, i) => ({
          favoriteId: meta[i]?.favoriteId,
          filename: meta[i]?.filename || f.originalname,
          tempPath: f.path,
          size: f.size
        }));

        const result = await createBackupBatch(userId, uploaded);
        // 无论成功失败，清掉临时目录中未被挪走的残留
        cleanupTemp(req.userId);

        if (!result.ok) {
          return res.status(result.status || 400).json({ status: 'error', message: result.error });
        }
        res.json({
          status: 'success',
          batchId: result.batchId,
          count: result.count,
          uploadsLeft: result.uploadsLeft,
          expiresAt: result.expiresAt
        });
      } catch (err) {
        console.error('收藏备份上传失败:', err);
        cleanupTemp(req.userId);
        res.status(500).json({ status: 'error', message: '备份上传失败' });
      }
    });
  });

  // 备份列表 + 本月剩余上传次数
  app.get('/api/favorites/backup', async (req, res) => {
    try {
      const userId = parseInt(req.userId, 10);
      if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });
      const data = await listBackups(userId);
      res.json({ status: 'success', ...data });
    } catch (err) {
      console.error('获取收藏备份列表失败:', err);
      res.status(500).json({ status: 'error', message: '获取备份列表失败' });
    }
  });

  // 下载某条备份文件
  app.get('/api/favorites/backup/:id/file', async (req, res) => {
    try {
      const userId = parseInt(req.userId, 10);
      if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });

      const backupId = parseInt(req.params.id, 10);
      const backup = await getBackupById(userId, backupId);
      if (!backup) return res.status(404).json({ status: 'error', message: '备份不存在' });
      if (new Date(backup.expiresAt).getTime() <= Date.now()) {
        return res.status(410).json({ status: 'error', message: '备份已过期' });
      }
      if (!fs.existsSync(backup.filePath)) {
        return res.status(410).json({ status: 'error', message: '备份文件已清理' });
      }

      const downloadName = backup.filename || path.basename(backup.filePath);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
      fs.createReadStream(backup.filePath).pipe(res);
    } catch (err) {
      console.error('下载收藏备份失败:', err);
      res.status(500).json({ status: 'error', message: '下载备份失败' });
    }
  });

  // ============================================
  // 收藏
  // ============================================

  // 收藏列表（每条带 fileAvailable：原文件是否仍在 7 天保留期内）
  app.get('/api/favorites', async (req, res) => {
    try {
      const userId = parseInt(req.userId, 10);
      if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });

      const favorites = await getFavorites(userId);
      res.json({ status: 'success', favorites });
    } catch (err) {
      console.error('获取收藏失败:', err);
      res.status(500).json({ status: 'error', message: '获取收藏失败' });
    }
  });

  // 添加收藏（含 300/100/512MB 限额校验）
  app.post('/api/favorites', async (req, res) => {
    try {
      const userId = parseInt(req.userId, 10);
      if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });

      const result = await addFavorite(userId, req.body || {});
      if (!result.ok) {
        // 限额/重复等原因：400 + 明确原因，前端直接 toast 给用户
        return res.status(400).json({ status: 'error', message: result.error });
      }
      res.json({ status: 'success', favorite: result.favorite });
    } catch (err) {
      console.error('添加收藏失败:', err);
      res.status(500).json({ status: 'error', message: '添加收藏失败' });
    }
  });

  // 取消收藏
  app.delete('/api/favorites/:id', async (req, res) => {
    try {
      const userId = parseInt(req.userId, 10);
      if (!userId) return res.status(401).json({ status: 'error', message: '未认证' });

      const favId = parseInt(req.params.id, 10);
      if (!favId) return res.status(400).json({ status: 'error', message: '非法收藏ID' });

      const result = await removeFavorite(userId, favId);
      if (!result.ok) {
        return res.status(404).json({ status: 'error', message: result.error });
      }
      res.json({ status: 'success' });
    } catch (err) {
      console.error('取消收藏失败:', err);
      res.status(500).json({ status: 'error', message: '取消收藏失败' });
    }
  });
}

/** 清理临时上传目录残留 */
function cleanupTemp(userId) {
  try {
    const dir = path.join(BACKUP_ROOT, 'tmp', String(userId || 'unknown'));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}


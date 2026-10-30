import request from '@/utils/request.js';
import { SERVER_URL } from '@/utils/chat/config.js';

function authHeaders() {
  // eslint-disable-next-line global-require
  return import('@/stores/index.js').then(({ useBaseStore }) => {
    const baseStore = useBaseStore();
    return {
      'user-id': String(baseStore.currentUser?.id || ''),
      'session-token': baseStore.currentSessionToken || ''
    };
  });
}

/**
 * 获取当前用户收藏列表
 * @returns {Promise<Array>} favorites，每项含 fileAvailable（原文件是否仍在 7 天保留期内）
 */
export function getFavorites() {
  return request.get('/api/favorites');
}

/**
 * 添加收藏
 * @param {Object} payload 收藏快照
 * @param {number} payload.messageId      源消息ID
 * @param {string} payload.source         来源: global / group / private
 * @param {string} payload.category       分类: text / image / video / audio / file
 * @param {number} payload.messageType    源消息类型
 * @param {string} payload.content        文字内容快照（引用消息只传引用者自身文字）
 * @param {string} payload.nickname       发送者昵称
 * @param {string} payload.avatarUrl      发送者头像
 * @param {string} payload.filename       文件类原始文件名
 * @param {number} payload.fileSize       文件字节数
 * @param {string} payload.fileUrl        原文件URL（只记录，不复制文件）
 * @param {number} payload.msgTimestamp   源消息时间戳
 */
export function addFavorite(payload) {
  return request.post('/api/favorites', payload);
}

/** 取消收藏 */
export function removeFavorite(id) {
  return request.delete(`/api/favorites/${id}`);
}

// ============================================
// 收藏文件备份（换设备手动搬运）
// ============================================

/**
 * 上传收藏文件备份（每月最多 3 次，24 小时有效）
 * 用 XHR 而非 fetch：fetch 不支持上传进度事件，看不到进度条
 * @param {Array<{favoriteId:number, filename:string, blob:Blob}>} items
 * @param {(percent:number)=>void} [onProgress] 0-100
 */
export function uploadFavoriteBackups(items, onProgress) {
  const form = new FormData();
  const meta = items.map(it => ({ favoriteId: it.favoriteId, filename: it.filename }));
  items.forEach((it) => {
    form.append('files', it.blob, it.filename || 'file');
  });
  form.append('meta', JSON.stringify(meta));

  return authHeaders().then((headers) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SERVER_URL}/api/favorites/backup`);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100);
        resolve(data);
      } else {
        const err = new Error(data.message || '上传失败');
        err.status = xhr.status;
        reject(err);
      }
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(form);
  }));
}

/** 获取当前可用的备份列表 + 本月剩余上传次数 */
export function getFavoriteBackups() {
  return request.get('/api/favorites/backup');
}

/**
 * 下载一条备份文件
 * @returns {Promise<Blob>}
 */
export async function downloadBackupFile(backupId) {
  const headers = await authHeaders();
  const resp = await fetch(`${SERVER_URL}/api/favorites/backup/${backupId}/file`, { headers });
  if (!resp.ok) {
    const err = new Error(resp.status === 410 ? '备份已过期' : '下载失败');
    err.status = resp.status;
    throw err;
  }
  return resp.blob();
}

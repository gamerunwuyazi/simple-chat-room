import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import localForage from 'localforage';
import { useBaseStore } from './baseStore';
import {
  getFavorites as apiGetFavorites,
  addFavorite as apiAddFavorite,
  removeFavorite as apiRemoveFavorite,
  uploadFavoriteBackups,
  getFavoriteBackups,
  downloadBackupFile
} from '@/api/favorite.js';

// ============================================
// 收藏分类体系
// ============================================
// 二级侧边栏的分类导航顺序（"全部"固定在最前）
export const FAVORITE_CATEGORIES = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文字' },
  { key: 'file', label: '文件' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' }
];

// 不可收藏的消息类型：
//   3   群名片
//   100 系统消息（建群/踢人等）
//   101 撤回消息
//   102 用户信息更新
//   103 已读回执
const UNFAVORABLE_TYPES = [3, 100, 101, 102, 103];

// type 2（文件）按扩展名细分，与聊天内 getFileTypePlaceholder / isAudioFile / isVideoFile 保持一致
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'm4v'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];

function fileExt(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/**
 * 判断一条消息能否被收藏。
 * 排除：群名片(3)、系统消息(100)、撤回(101)、用户信息更新(102)、已读回执(103)，
 * 以及带 isRecalled / isSystemMessage 标记的和 groupCard 字段的。
 */
export function isFavoritable(message) {
  if (!message) return false;
  // 撤回消息 / 系统消息标记
  if (message.isRecalled || message.isSystemMessage) return false;
  // 群名片（可能以 messageType=3 或 groupCard/group_card 字段存在）
  if (message.groupCard || message.group_card) return false;

  const type = message.messageType;
  if (type === undefined || type === null) return true; // 无类型信息按普通文字处理
  if (UNFAVORABLE_TYPES.includes(type)) return false;
  return true;
}

/**
 * 由消息推导收藏分类。
 *   0 文字 / 4 引用 / 5 Markdown → text
 *   1 图片                      → image
 *   2 文件                      → 按扩展名 image/video/audio/file
 */
export function deriveCategory(message) {
  const type = message.messageType;
  if (type === 1) return 'image';
  if (type === 2) {
    const ext = fileExt(message.filename);
    if (IMAGE_EXTS.includes(ext)) return 'image';
    if (VIDEO_EXTS.includes(ext)) return 'video';
    if (AUDIO_EXTS.includes(ext)) return 'audio';
    return 'file';
  }
  return 'text';
}

// ============================================
// 本地文件 blob 存储（浏览器 IndexedDB）
// ============================================
// 服务端只保留文件 14 天；浏览器本地这份才是长期权威副本。
function blobKey(userId, favId) {
  return `favfile-${userId}-${favId}`;
}

export const useFavoriteStore = defineStore('favorite', () => {
  // ===== 状态 =====
  // 元数据：服务端为权威来源（换设备可同步）
  const favorites = ref([]);
  const loaded = ref(false);
  // 当前选中的分类（侧边栏与页面共享）；'all' 表示不筛选
  const activeCategory = ref('all');
  // favId → objectURL 缓存，避免重复创建/泄漏
  const objectUrlCache = new Map();

  function currentUserId() {
    const baseStore = useBaseStore();
    return baseStore.currentUser?.id || 'guest';
  }

  // ===== 计算属性 =====
  const filteredFavorites = computed(() => {
    if (activeCategory.value === 'all') return favorites.value;
    return favorites.value.filter(f => f.category === activeCategory.value);
  });

  const categoryCounts = computed(() => {
    const counts = { all: favorites.value.length, text: 0, file: 0, image: 0, video: 0, audio: 0 };
    for (const fav of favorites.value) {
      if (counts[fav.category] !== undefined) counts[fav.category]++;
    }
    return counts;
  });

  function setActiveCategory(category) {
    activeCategory.value = category;
  }

  // ===== 加载（服务端） =====
  async function loadFavorites() {
    try {
      const resp = await apiGetFavorites();
      const list = resp?.data?.favorites;
      favorites.value = Array.isArray(list) ? list : [];
    } catch (err) {
      console.error('加载收藏失败:', err);
      favorites.value = [];
    }
    loaded.value = true;
    return favorites.value;
  }

  function findByMessage(messageId, source = 'global') {
    return favorites.value.find(
      f => String(f.messageId) === String(messageId) && f.source === source
    ) || null;
  }

  function isFavorited(messageId, source = 'global') {
    return !!findByMessage(messageId, source);
  }

  // ===== 本地 blob 存取 =====
  async function saveLocalBlob(favId, blob) {
    if (!favId || !blob) return;
    try {
      await localForage.setItem(blobKey(currentUserId(), favId), blob);
    } catch (err) {
      console.error('保存收藏文件到本地失败:', err);
    }
  }

  async function getLocalBlob(favId) {
    if (!favId) return null;
    try {
      const blob = await localForage.getItem(blobKey(currentUserId(), favId));
      return blob || null;
    } catch {
      return null;
    }
  }

  async function removeLocalBlob(favId) {
    try {
      await localForage.removeItem(blobKey(currentUserId(), favId));
    } catch { /* ignore */ }
    const url = objectUrlCache.get(favId);
    if (url) {
      URL.revokeObjectURL(url);
      objectUrlCache.delete(favId);
    }
  }

  /**
   * 从消息的文件URL拉取二进制并存到本地 IndexedDB。
   * 仅在收藏成功（已拿到服务端 favId）后调用。
   */
  async function cacheFileFromMessageUrl(favId, fileUrl) {
    if (!favId || !fileUrl) return false;
    try {
      const baseStore = useBaseStore();
      const full = fileUrl.startsWith('http') ? fileUrl : `${baseStore.SERVER_URL}${fileUrl}`;
      const resp = await fetch(full);
      if (!resp.ok) return false;
      await saveLocalBlob(favId, await resp.blob());
      return true;
    } catch (err) {
      console.error('拉取收藏文件失败:', err.message);
      return false;
    }
  }

  /**
   * 取得某条收藏的可渲染文件 URL。
   * 优先级：本地 IndexedDB blob（永久） → 原文件 URL（保留期内，直接引用） → null
   *
   * 不再下载/复制服务端副本：收藏只记录原文件 URL（7 天保留期），
   * 换设备后若原文件仍在保留期内可直接用 URL 渲染；原文件已被清理时，
   * 则需要走"旧设备上传备份 → 新设备获取备份"的手动通道。
   * 返回 null 时调用方应降级为"文件已过期/不可用"占位。
   */
  async function resolveFileUrl(favorite) {
    if (!favorite) return null;

    // 1) 已创建过的 objectURL
    const cached = objectUrlCache.get(favorite.id);
    if (cached) return cached;

    // 2) 本地 IndexedDB（永久副本）
    const localBlob = await getLocalBlob(favorite.id);
    if (localBlob) {
      const url = URL.createObjectURL(localBlob);
      objectUrlCache.set(favorite.id, url);
      return url;
    }

    // 3) 原文件 URL（服务端按 7 天保留期判定是否可用），直接引用，不复制
    if (favorite.fileAvailable && favorite.fileUrl) {
      const baseStore = useBaseStore();
      return favorite.fileUrl.startsWith('http')
        ? favorite.fileUrl
        : `${baseStore.SERVER_URL}${favorite.fileUrl}`;
    }

    // 4) 本地没有、原文件也已过保留期
    return null;
  }

  /** 文件是否可能可渲染（本地已有 或 服务端仍有效） */
  function isFileResolvable(favorite) {
    if (!favorite) return false;
    if (objectUrlCache.has(favorite.id)) return true;
    return !!favorite.fileAvailable;
  }

  // ===== 新增 =====
  /**
   * 收藏一条消息。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function addFavorite(message, source = 'global') {
    if (!message || message.id === undefined || message.id === null) {
      return { ok: false, error: '无效消息' };
    }
    if (!isFavoritable(message)) {
      return { ok: false, error: '该类型消息不支持收藏' };
    }

    // type 4（引用消息）只保留引用者自己输入的文字，不保留被引用消息的任何信息
    let content = message.content ?? '';
    if (message.messageType === 4 && typeof content === 'string' && content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        content = parsed.text || parsed.content || '';
      } catch { /* 解析失败则保留原 content */ }
    }

    const category = deriveCategory(message);
    const payload = {
      messageId: message.id,
      source,
      category,
      messageType: message.messageType ?? 0,
      content,
      nickname: message.nickname || '',
      avatarUrl: message.avatarUrl || '',
      filename: message.filename || '',
      fileSize: message.fileSize || 0,
      // 服务端据此把已存在的文件复制到收藏目录（不重新走网络上传）
      fileUrl: message.imageUrl || message.fileUrl || '',
      msgTimestamp: message.timestamp || null
    };

    try {
      const resp = await apiAddFavorite(payload);
      const favorite = resp?.data?.favorite;
      if (!favorite) return { ok: false, error: '收藏失败' };

      favorites.value.unshift(favorite);

      // 文件类：立刻把二进制拉到本地 IndexedDB（本地才是永久副本）
      if (category !== 'text' && payload.fileUrl) {
        await cacheFileFromMessageUrl(favorite.id, payload.fileUrl);
      }
      return { ok: true };
    } catch (err) {
      const msg = err?.response?.data?.message || err.message || '收藏失败';
      return { ok: false, error: msg };
    }
  }

  // ===== 删除 =====
  async function removeFavorite(favoriteId) {
    try {
      await apiRemoveFavorite(favoriteId);
    } catch (err) {
      console.error('取消收藏失败:', err);
      return false;
    }
    const index = favorites.value.findIndex(f => String(f.id) === String(favoriteId));
    if (index !== -1) favorites.value.splice(index, 1);
    await removeLocalBlob(favoriteId);
    return true;
  }

  /** 按 消息ID+来源 取消收藏（右键菜单用） */
  async function removeFavoriteByMessage(messageId, source = 'global') {
    const fav = findByMessage(messageId, source);
    if (!fav) return false;
    return removeFavorite(fav.id);
  }

  /** 切换收藏状态，返回操作后的状态（true=已收藏） */
  async function toggleFavorite(message, source = 'global') {
    const existing = findByMessage(message.id, source);
    if (existing) {
      await removeFavorite(existing.id);
      return false;
    }
    const result = await addFavorite(message, source);
    if (!result.ok) throw new Error(result.error);
    return true;
  }

  // ============================================
  // 换设备手动搬运：上传 / 获取备份
  // ============================================

  /**
   * 把本设备所有文件类收藏的本地 blob 上传为服务端备份（24 小时有效）。
   * @returns {Promise<{ count:number, uploadsLeft:number }>}
   */
  async function uploadBackups(onProgress) {
    const fileFavs = favorites.value.filter(f => f.category !== 'text');
    const items = [];
    for (const fav of fileFavs) {
      const blob = await getLocalBlob(fav.id);
      if (blob) {
        items.push({ favoriteId: fav.id, filename: fav.filename || `favorite-${fav.id}`, blob });
      }
    }
    if (items.length === 0) {
      throw new Error('本设备没有可上传的收藏文件');
    }
    const resp = await uploadFavoriteBackups(items, onProgress);
    return { count: resp.count ?? items.length, uploadsLeft: resp.uploadsLeft ?? 0 };
  }

  /** 查询服务端备份列表与本月剩余次数（不下载） */
  async function listBackups() {
    const resp = await getFavoriteBackups();
    return resp?.data || {};
  }

  /**
   * 获取服务端备份：逐个下载并写回本地 IndexedDB（按 favoriteId 对齐）。
   * @returns {Promise<{ total:number, ok:number, fail:number }>}
   */
  async function fetchBackups() {
    const data = await listBackups();
    const backups = Array.isArray(data.backups) ? data.backups : [];
    let ok = 0;
    let fail = 0;
    for (const b of backups) {
      try {
        const blob = await downloadBackupFile(b.id);
        await saveLocalBlob(b.favoriteId, blob);
        // 清掉旧的 objectURL 缓存，让页面重新解析
        const old = objectUrlCache.get(b.favoriteId);
        if (old) {
          URL.revokeObjectURL(old);
          objectUrlCache.delete(b.favoriteId);
        }
        ok++;
      } catch {
        fail++;
      }
    }
    return { total: backups.length, ok, fail };
  }

  async function clearAll() {
    for (const fav of [...favorites.value]) {
      await removeFavorite(fav.id);
    }
    favorites.value = [];
    activeCategory.value = 'all';
  }

  return {
    favorites,
    loaded,
    activeCategory,
    loadFavorites,
    isFavorited,
    findByMessage,
    isFavoritable,
    addFavorite,
    removeFavorite,
    removeFavoriteByMessage,
    toggleFavorite,
    setActiveCategory,
    filteredFavorites,
    categoryCounts,
    resolveFileUrl,
    isFileResolvable,
    cacheFileFromMessageUrl,
    uploadBackups,
    listBackups,
    fetchBackups,
    clearAll
  };
});

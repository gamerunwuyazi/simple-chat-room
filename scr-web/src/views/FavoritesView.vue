<script setup>
/* eslint-disable vue/multi-word-component-names */
import { computed, onMounted, reactive, watch } from 'vue';
import DOMPurify from 'dompurify';
import { Marked, Renderer } from 'marked';

import { useBaseStore } from '@/stores/baseStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import modal from '@/utils/modal';
import toast from '@/utils/toast';

const baseStore = useBaseStore();
const favoriteStore = useFavoriteStore();
const SERVER_URL = baseStore.SERVER_URL || import.meta.env.VITE_SERVER_URL || '';

onMounted(() => {
  if (!favoriteStore.loaded) favoriteStore.loadFavorites();
  refreshQuota();
});

// 只展示当前选中的分类
const favorites = computed(() => favoriteStore.filteredFavorites || []);

const activeCategory = computed(() => favoriteStore.activeCategory);

const CATEGORY_LABELS = {
  text: '文字',
  file: '文件',
  image: '图片',
  video: '视频',
  audio: '音频'
};

// ===== Markdown 渲染 =====
// 用【私有 Marked 实例】，不碰全局 marked。
// 原因：marked 的配置是全局单例，项目里其他组件（UnifiedMessageItem /
// GroupMessageItem / PrivateMessageItem / QuotedMessage / QuotedMessagePreview）
// 都是「setOptions 紧接 parse」在 computed 里临时抢占配置。
// 若在模块作用域对全局 marked setOptions，会永久改写配置，
// 变成"谁后加载谁说了话"的地雷（本文件曾犯此错，已修）。
// 私有实例的配置只作用于自身，从根上消除这类相互干扰。
const md = new Marked();
const mdRenderer = new Renderer();
mdRenderer.link = ({ href, title, tokens }) => {
  const text = tokens?.length ? md.Parser.parseInline(tokens) : String(href || '');
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
mdRenderer.code = ({ text, lang }) => {
  const language = (lang || '').split(/\s+/)[0] || 'plaintext';
  // 项目未接入语法高亮库，原样输出代码文本
  return `<pre><code class="hljs language-${language}">${text}</code></pre>`;
};
// 一次性配置，只影响这个私有实例
md.use({
  renderer: mdRenderer,
  gfm: true,
  breaks: true,
  smartLists: true,
  smartypants: false
});

function renderMarkdown(content) {
  try {
    return DOMPurify.sanitize(md.parse(String(content ?? '')).trim());
  } catch {
    return '';
  }
}

function getAvatarUrl(user) {
  const url = user?.avatarUrl || user?.avatar_url || user?.avatar || '';
  return typeof url === 'string' ? url.trim() : '';
}

function fullAvatarUrl(fav) {
  const url = getAvatarUrl(fav);
  if (!url) return '';
  return url.startsWith('http') ? url : `${SERVER_URL}${url}`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 服务端返回的时间字段：msgTimestamp（源消息时间）优先，favoritedAt 兜底
function favTime(fav) {
  return fav.msgTimestamp || fav.favoritedAt || null;
}

function isMarkdown(fav) {
  return fav.markdone === true || fav.messageType === 5;
}

function isFileCategory(fav) {
  return fav.category && fav.category !== 'text';
}

// 纯文本预览（非 md 的文字类收藏）
function textPreview(fav) {
  const text = String(fav.content ?? '');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ============================================
// 文件类收藏的媒体解析
// 渲染优先级（在 store.resolveFileUrl 内实现）：
//   本地 IndexedDB blob → 服务端 14 天副本（顺手缓存本地）→ 过期占位
// ============================================
// favId → { url: string|null, loading: boolean, expired: boolean }
const mediaState = reactive({});

const fileFavorites = computed(() => (favorites.value || []).filter(isFileCategory));

async function resolveOne(fav) {
  mediaState[fav.id] = { url: null, loading: true, expired: false };
  const url = await favoriteStore.resolveFileUrl(fav);
  const state = mediaState[fav.id];
  if (!state) return; // 已被清理（取消收藏等）
  state.loading = false;
  if (url) state.url = url;
  else state.expired = true;
}

watch(fileFavorites, (list) => {
  const seen = new Set();
  for (const fav of list) {
    seen.add(fav.id);
    if (!mediaState[fav.id]) resolveOne(fav);
  }
  // 清理已取消收藏的条目，防止无限增长
  for (const id of Object.keys(mediaState)) {
    if (!seen.has(Number(id)) && !seen.has(id)) delete mediaState[id];
  }
}, { immediate: true });

// 模板里取某条收藏的媒体状态
function ms(fav) {
  return mediaState[fav.id] || { url: null, loading: false, expired: false };
}

// ============================================
// 换设备手动搬运：上传 / 获取备份
// ============================================
// 本月剩余上传次数（服务端按自然月统计，每月 3 次）
const quota = reactive({ used: 0, left: 3, perMonth: 3, loaded: false });
const uploading = reactive({ active: false, progress: 0 });
const fetching = reactive({ active: false });

async function refreshQuota() {
  try {
    const data = await favoriteStore.listBackups();
    quota.used = data.uploadsUsed ?? 0;
    quota.left = data.uploadsLeft ?? 3;
    quota.perMonth = data.uploadsPerMonth ?? 3;
    quota.loaded = true;
  } catch { /* 配额查询失败不阻塞页面 */ }
}

async function handleUploadBackups() {
  if (uploading.active) return;
  const confirmed = await modal.confirm(
    `将把本设备已保存的收藏文件上传到服务器，24 小时后自动清理。每月最多 ${quota.perMonth} 次，本月剩余 ${quota.left} 次。继续？`,
    '上传收藏文件'
  );
  if (!confirmed) return;
  uploading.active = true;
  uploading.progress = 0;
  try {
    const res = await favoriteStore.uploadBackups((p) => { uploading.progress = p; });
    await refreshQuota();
    toast.success(`已上传 ${res.count} 个文件，24 小时内可在新设备获取（本月剩余 ${res.uploadsLeft} 次）`, 3000);
  } catch (err) {
    toast.error(err?.response?.data?.message || err.message || '上传失败', 3000);
    await refreshQuota();
  } finally {
    uploading.active = false;
    uploading.progress = 0;
  }
}

async function handleFetchBackups() {
  if (fetching.active) return;
  fetching.active = true;
  try {
    const res = await favoriteStore.fetchBackups();
    if (res.total === 0) {
      toast.info('服务器上没有可获取的备份（可能未上传，或已超过 24 小时）', 3000);
      return;
    }
    // 清空媒体状态并重新解析，让刚取回的文件立即渲染
    for (const fav of fileFavorites.value) {
      delete mediaState[fav.id];
      resolveOne(fav);
    }
    if (res.fail > 0) {
      toast.error(`获取完成：成功 ${res.ok} 个，失败 ${res.fail} 个`, 3000);
    } else {
      toast.success(`已获取 ${res.ok} 个收藏文件并保存到本设备`, 3000);
    }
  } catch (err) {
    toast.error(err?.response?.data?.message || err.message || '获取失败', 3000);
  } finally {
    fetching.active = false;
  }
}

async function handleRemove(fav) {
  const confirmed = await modal.confirm('确定要取消收藏这条消息吗？', '取消收藏');
  if (!confirmed) return;
  await favoriteStore.removeFavorite(fav.id);
  delete mediaState[fav.id];
}

async function copyContent(fav) {
  const text = String(fav.content ?? '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch { /* ignore */ }
}
</script>

<template>
  <div id="favorites-view" class="favorites-view">
    <!-- 换设备搬运：手动上传/获取收藏文件 -->
    <div class="favorites-transfer">
      <div class="favorites-transfer-actions">
        <button class="transfer-btn" :disabled="uploading.active" @click="handleUploadBackups">
          <i :class="['fas', uploading.active ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up']"></i>
          {{ uploading.active ? '上传中…' : '上传文件' }}
        </button>
        <button class="transfer-btn" :disabled="fetching.active" @click="handleFetchBackups">
          <i :class="['fas', fetching.active ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down']"></i>
          {{ fetching.active ? '获取中…' : '获取文件' }}
        </button>
        <span class="transfer-quota">本月剩余 {{ quota.left }}/{{ quota.perMonth }} 次</span>
      </div>
      <div v-if="uploading.active" class="transfer-progress">
        <div class="transfer-progress-track">
          <div class="transfer-progress-bar" :style="{ width: uploading.progress + '%' }"></div>
        </div>
        <span class="transfer-progress-text">上传中 {{ uploading.progress }}%</span>
      </div>
      <p class="favorites-transfer-hint">
        <i class="fas fa-circle-info"></i>
        若 24 小时内准备换设备，请先在旧设备点击「上传文件」，再到新设备点击「获取文件」。上传的备份 24 小时后自动清理。
      </p>
    </div>

    <div v-if="favorites.length === 0" class="favorites-empty">
      <i class="fas fa-box-open"></i>
      <p>{{ activeCategory === 'all' ? '还没有收藏' : '该分类下暂无收藏' }}</p>
      <span v-if="activeCategory === 'all'">在消息上点击右键，选择"收藏"即可</span>
    </div>

    <div v-else class="favorites-body">
      <div v-for="fav in favorites" :key="fav.key" class="favorite-item">
        <div class="favorite-avatar">
          <img v-if="fullAvatarUrl(fav)" :src="fullAvatarUrl(fav)" :alt="fav.nickname" @error="$event.target.style.display='none'">
          <span v-else class="favorite-avatar-text">{{ (fav.nickname || 'U').charAt(0).toUpperCase() }}</span>
        </div>
        <div class="favorite-main">
          <div class="favorite-meta">
            <span class="favorite-nickname">{{ fav.nickname || '未知用户' }}</span>
            <span class="favorite-type-tag">{{ CATEGORY_LABELS[fav.category] || '文字' }}</span>
            <span class="favorite-time">{{ formatTime(favTime(fav)) }}</span>
          </div>
          <div class="favorite-content">
            <!-- Markdown：按聊天内同一套管线渲染 -->
            <div v-if="isMarkdown(fav)" class="favorite-markdown" v-html="renderMarkdown(fav.content)"></div>
            <!-- 文字 -->
            <span v-else-if="fav.category === 'text'">{{ textPreview(fav) }}</span>
            <!-- 文件类：本地 blob → 服务端副本 → 过期占位 -->
            <template v-else>
              <!-- 图片 -->
              <img v-if="fav.category === 'image' && ms(fav).url" :src="ms(fav).url" class="favorite-image" alt="收藏图片">
              <!-- 视频 -->
              <video v-else-if="fav.category === 'video' && ms(fav).url" :src="ms(fav).url" class="favorite-video" controls preload="metadata"></video>
              <!-- 音频 -->
              <audio v-else-if="fav.category === 'audio' && ms(fav).url" :src="ms(fav).url" class="favorite-audio" controls preload="metadata"></audio>
              <!-- 文件（blob URL + download 属性，保存时用原始文件名） -->
              <a v-else-if="fav.category === 'file' && ms(fav).url" :href="ms(fav).url" :download="fav.filename || '文件'" class="favorite-file">
                <i class="fas fa-file"></i>
                <span>{{ fav.filename || '下载文件' }}</span>
                <small v-if="fav.fileSize">（{{ formatSize(fav.fileSize) }}）</small>
              </a>
              <!-- 加载中 -->
              <div v-else-if="ms(fav).loading" class="favorite-file-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <span>正在加载文件…</span>
              </div>
              <!-- 过期占位：本地无副本 且 服务端 14 天已过 -->
              <div v-else class="favorite-file-expired">
                <i class="fas fa-box-archive"></i>
                <div class="favorite-file-expired-main">
                  <span class="favorite-file-expired-name">{{ fav.filename || '文件' }}</span>
                  <small>文件已不可用（原文件仅保留 7 天）。若需在新设备查看，请到旧设备点击「上传文件」，再在本设备点击「获取文件」</small>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="favorite-actions">
          <button class="favorite-action-btn" title="复制" @click="copyContent(fav)">
            <i class="fas fa-copy"></i>
          </button>
          <button class="favorite-action-btn danger" title="取消收藏" @click="handleRemove(fav)">
            <i class="fas fa-trash-can"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.favorites-view {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 20px;
  overflow-y: auto;
  background-color: #fff;
}

.favorites-transfer {
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background-color: #f8fafc;
}

.favorites-transfer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.transfer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background-color: #fff;
  color: #334155;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.transfer-btn:hover:not(:disabled) {
  border-color: #3b82f6;
  color: #2563eb;
  background-color: #eff6ff;
}

.transfer-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.transfer-quota {
  margin-left: auto;
  font-size: 12px;
  color: #94a3b8;
}

.transfer-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.transfer-progress-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background-color: #e2e8f0;
  overflow: hidden;
}

.transfer-progress-bar {
  height: 100%;
  border-radius: 3px;
  background-color: #3b82f6;
  transition: width 0.2s ease;
}

.transfer-progress-text {
  font-size: 12px;
  color: #64748b;
  min-width: 76px;
  text-align: right;
}

.favorites-transfer-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #94a3b8;
}

.favorites-transfer-hint i {
  margin-right: 4px;
}

.favorites-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #94a3b8;
}

.favorites-empty i {
  font-size: 48px;
  color: #cbd5e1;
}

.favorites-empty p {
  margin: 0;
  font-size: 16px;
  color: #64748b;
}

.favorites-empty span {
  font-size: 13px;
}

.favorite-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin-bottom: 10px;
  transition: background-color 0.2s ease;
}

.favorite-item:hover {
  background-color: #f8fafc;
}

.favorite-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #e2e8f0;
}

.favorite-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.favorite-avatar-text {
  font-size: 15px;
  font-weight: 600;
  color: #475569;
}

.favorite-main {
  flex: 1;
  min-width: 0;
}

.favorite-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.favorite-nickname {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}

.favorite-type-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background-color: #e0e7ff;
  color: #4338ca;
  flex-shrink: 0;
}

.favorite-time {
  font-size: 12px;
  color: #94a3b8;
}

.favorite-content {
  font-size: 14px;
  color: #475569;
  line-height: 1.6;
  word-break: break-word;
}

.favorite-image {
  max-width: 260px;
  max-height: 260px;
  border-radius: 6px;
  display: block;
}

.favorite-video {
  max-width: 320px;
  border-radius: 6px;
  display: block;
}

.favorite-audio {
  width: 260px;
  height: 36px;
}

.favorite-file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
  background-color: #f8fafc;
  color: #334155;
  text-decoration: none;
  font-size: 13px;
}

.favorite-file:hover {
  background-color: #f1f5f9;
}

.favorite-file-loading,
.favorite-file-expired {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px dashed #e2e8f0;
  background-color: #f8fafc;
  color: #94a3b8;
  font-size: 13px;
}

.favorite-file-loading i {
  font-size: 15px;
}

.favorite-file-expired i {
  font-size: 18px;
  color: #cbd5e1;
}

.favorite-file-expired-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.favorite-file-expired-name {
  color: #64748b;
  font-weight: 600;
}

.favorite-file-expired small {
  color: #94a3b8;
  font-size: 12px;
}

/* Markdown 渲染：与聊天内 message-text 观感对齐 */
.favorite-markdown {
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.favorite-markdown :deep(pre) {
  background-color: #f6f8fa;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
}

.favorite-markdown :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
}

.favorite-markdown :deep(p) {
  margin: 0 0 8px 0;
}

.favorite-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.favorite-markdown :deep(ul),
.favorite-markdown :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}

.favorite-markdown :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid #cbd5e1;
  color: #64748b;
  background-color: #f8fafc;
  border-radius: 0 4px 4px 0;
}

.favorite-markdown :deep(a) {
  color: #3b82f6;
  text-decoration: none;
}

.favorite-markdown :deep(a:hover) {
  text-decoration: underline;
}

.favorite-markdown :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

.favorite-markdown :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
}

.favorite-markdown :deep(th),
.favorite-markdown :deep(td) {
  border: 1px solid #e2e8f0;
  padding: 6px 10px;
  font-size: 13px;
}

.favorite-markdown :deep(h1),
.favorite-markdown :deep(h2),
.favorite-markdown :deep(h3),
.favorite-markdown :deep(h4) {
  margin: 12px 0 6px 0;
  line-height: 1.3;
  color: #1e293b;
}

.favorite-actions {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.favorite-item:hover .favorite-actions {
  opacity: 1;
}

.favorite-action-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  color: #64748b;
  font-size: 13px;
}

.favorite-action-btn:hover {
  background-color: #e2e8f0;
  color: #334155;
}

.favorite-action-btn.danger:hover {
  background-color: #fee2e2;
  color: #dc2626;
}

/* === 深色模式 === */
body.dark-mode .favorites-view {
  background-color: #0d1117;
}

body.dark-mode .favorites-transfer {
  border-color: #30363d;
  background-color: #161b22;
}

body.dark-mode .transfer-btn {
  border-color: #30363d;
  background-color: #0d1117;
  color: #c9d1d9;
}

body.dark-mode .transfer-btn:hover:not(:disabled) {
  border-color: #1f6feb;
  color: #58a6ff;
  background-color: #161b22;
}

body.dark-mode .transfer-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.transfer-progress-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background-color: #e2e8f0;
  overflow: hidden;
}

.transfer-progress-bar {
  height: 100%;
  border-radius: 3px;
  background-color: #3b82f6;
  transition: width 0.2s ease;
}

.transfer-progress-text {
  font-size: 12px;
  color: #64748b;
  min-width: 76px;
  text-align: right;
}

.favorites-transfer-hint {
  color: #6e7681;
}

body.dark-mode .favorites-empty p {
  color: #8b949e;
}

body.dark-mode .favorites-empty i {
  color: #30363d;
}

body.dark-mode .favorite-item {
  border-color: #30363d;
  background-color: #161b22;
}

body.dark-mode .favorite-item:hover {
  background-color: #21262d;
}

body.dark-mode .favorite-avatar {
  background-color: #30363d;
}

body.dark-mode .favorite-avatar-text {
  color: #c9d1d9;
}

body.dark-mode .favorite-nickname {
  color: #c9d1d9;
}

body.dark-mode .favorite-type-tag {
  background-color: rgba(56, 139, 253, 0.15);
  color: #79c0ff;
}

body.dark-mode .favorite-content {
  color: #8b949e;
}

body.dark-mode .favorite-file {
  border-color: #30363d;
  background-color: #0d1117;
  color: #c9d1d9;
}

body.dark-mode .favorite-file:hover {
  background-color: #21262d;
}

body.dark-mode .favorite-file-loading,
body.dark-mode .favorite-file-expired {
  border-color: #30363d;
  background-color: #0d1117;
  color: #6e7681;
}

body.dark-mode .favorite-file-expired-name {
  color: #8b949e;
}

body.dark-mode .favorite-markdown :deep(pre) {
  background-color: #161b22;
  border-color: #30363d;
}

body.dark-mode .favorite-markdown :deep(blockquote) {
  border-left-color: #30363d;
  color: #8b949e;
  background-color: #161b22;
}

body.dark-mode .favorite-markdown :deep(a) {
  color: #58a6ff;
}

body.dark-mode .favorite-markdown :deep(th),
body.dark-mode .favorite-markdown :deep(td) {
  border-color: #30363d;
}

body.dark-mode .favorite-markdown :deep(h1),
body.dark-mode .favorite-markdown :deep(h2),
body.dark-mode .favorite-markdown :deep(h3),
body.dark-mode .favorite-markdown :deep(h4) {
  color: #c9d1d9;
}

body.dark-mode .favorite-action-btn {
  color: #8b949e;
}

body.dark-mode .favorite-action-btn:hover {
  background-color: #30363d;
  color: #c9d1d9;
}

body.dark-mode .favorite-action-btn.danger:hover {
  background-color: rgba(248, 81, 73, 0.15);
  color: #f85149;
}
</style>

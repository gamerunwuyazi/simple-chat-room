import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';

// 侧边栏聊天列表分页：
// - 默认只渲染排序后列表的前 20 条
// - 滚动到列表底部时再加载后 10 条
// - 搜索关键词变化时重置分页并回到顶部（搜索不受分页影响，始终搜索完整列表）
// - 列表内容变化（新消息导致重排等）时保存并恢复滚动位置，避免列表跳动
const PAGE_SIZE = 20;
const LOAD_MORE_COUNT = 10;
const BOTTOM_THRESHOLD = 40;

// 匹配率：完全匹配 > 前缀匹配 > 包含匹配
export function getMatchScore(keyword, name) {
  const k = String(keyword || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (!k || !n) return 0;
  if (n === k) return 100;
  if (n.startsWith(k)) return 80;
  if (n.includes(k)) return 60;
  return 0;
}

// 会话最后消息时间（毫秒），用于匹配率相同时按最近活跃排序
export function getSessionTimeMs(session) {
  if (session.session_last_active_time) return new Date(session.session_last_active_time).getTime();
  if (session.last_message_time) return new Date(session.last_message_time).getTime();
  return 0;
}

// 搜索结果排序：匹配率降序，匹配率相同按最后消息时间从近到远
export function searchSorter(keyword, getName) {
  return (a, b) => {
    const diff = getMatchScore(keyword, getName(a)) - getMatchScore(keyword, getName(b));
    if (diff !== 0) return -diff;
    return getSessionTimeMs(b) - getSessionTimeMs(a);
  };
}

export function usePagedList(source, { containerRef = null, resetTrigger = null } = {}) {
  const renderedCount = ref(PAGE_SIZE);
  const listContainer = containerRef || ref(null);
  let searchResetPending = false;
  let savedScrollTop = null;

  const pagedList = computed(() => {
    const list = source.value || [];
    return list.slice(0, renderedCount.value);
  });

  const hasMore = computed(() => renderedCount.value < (source.value || []).length);

  function resetPagination() {
    searchResetPending = true;
    renderedCount.value = PAGE_SIZE;
    nextTick(() => {
      const el = listContainer.value;
      if (el) el.scrollTop = 0;
      searchResetPending = false;
    });
  }

  function loadMoreItems() {
    const total = (source.value || []).length;
    if (renderedCount.value < total) {
      renderedCount.value = Math.min(renderedCount.value + LOAD_MORE_COUNT, total);
    }
  }

  function handleScroll() {
    const el = listContainer.value;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD) {
      loadMoreItems();
    }
  }

  // 搜索关键词变化：重置分页并回到顶部
  // 必须先于下面的 source watch 注册，确保标志先置位，source watch 才能跳过恢复
  if (resetTrigger) {
    watch(resetTrigger, () => {
      resetPagination();
    });
  }

  // 列表内容变化（新消息/排序变化等）：保存并恢复滚动位置，避免列表跳动
  watch(source, () => {
    if (searchResetPending) return;
    const el = listContainer.value;
    if (el) {
      savedScrollTop = el.scrollTop;
      nextTick(() => {
        const c = listContainer.value;
        if (c && savedScrollTop !== null) {
          c.scrollTop = savedScrollTop;
        }
      });
    }
  });

  onMounted(() => {
    const el = listContainer.value;
    if (el) {
      el.addEventListener('scroll', handleScroll, { passive: true });
    }
  });

  onBeforeUnmount(() => {
    const el = listContainer.value;
    if (el) {
      el.removeEventListener('scroll', handleScroll);
    }
  });

  return {
    pagedList,
    hasMore,
    resetPagination,
    loadMoreItems
  };
}

import { ref } from 'vue';
import { browseMessages } from '@/api/message.js';

// 查找消息弹窗的分页逻辑（后端分页版）：
// - executeSearch(keyword, types)：keyword 为空且选了类型 = 浏览模式，否则为关键词查找
// - loadMore()：滚动到底部加载下一页，结果按 id 追加（keyed v-for），
//   已渲染 DOM 不重建，天然保持滚动进度不跳动（参考 usePagedList.js 的思路，
//   但数据源是后端分页接口而非本地完整数组）
// - getScopeParams 由视图注入当前会话范围（public / group+groupId / private+peerId），
//   权限边界由后端校验
const PAGE_SIZE = 20;

export function useMessageBrowse(getScopeParams) {
  const searchResults = ref([]);
  const isSearching = ref(false);
  const hasSearched = ref(false);
  const isLoadingMore = ref(false);
  const hasMore = ref(false);
  const browseKeyword = ref('');
  let browseState = { keyword: '', types: [], page: 1 };

  async function fetchPage(page, append) {
    const scopeParams = getScopeParams() || {};
    const res = await browseMessages({
      ...scopeParams,
      types: browseState.types.join(','),
      keyword: browseState.keyword || undefined,
      page,
      pageSize: PAGE_SIZE
    });
    const data = res.data;
    if (!data || data.status !== 'success') {
      throw new Error((data && data.message) || '查询失败');
    }
    if (append) {
      const existingIds = new Set(searchResults.value.map((m) => m.id));
      searchResults.value = searchResults.value.concat(
        data.messages.filter((m) => !existingIds.has(m.id))
      );
    } else {
      searchResults.value = data.messages;
    }
    hasMore.value = !!data.hasMore;
    browseState.page = page;
  }

  async function executeSearch(keyword, types = []) {
    if (isSearching.value) return;
    browseState = { keyword: String(keyword || '').trim(), types: [...types], page: 1 };
    browseKeyword.value = browseState.keyword;
    if (!browseState.keyword && browseState.types.length === 0) {
      // 未选类型也未输入关键词：清空结果区
      searchResults.value = [];
      hasMore.value = false;
      hasSearched.value = false;
      return;
    }
    isSearching.value = true;
    hasSearched.value = false;
    try {
      await fetchPage(1, false);
      hasSearched.value = true;
    } catch (err) {
      console.error('查找消息失败:', err);
      searchResults.value = [];
      hasMore.value = false;
      hasSearched.value = true;
    } finally {
      isSearching.value = false;
    }
  }

  async function loadMore() {
    if (isLoadingMore.value || isSearching.value || !hasMore.value) return;
    isLoadingMore.value = true;
    try {
      await fetchPage(browseState.page + 1, true);
    } catch (err) {
      console.error('加载更多消息失败:', err);
    } finally {
      isLoadingMore.value = false;
    }
  }

  return {
    searchResults,
    isSearching,
    hasSearched,
    isLoadingMore,
    hasMore,
    browseKeyword,
    executeSearch,
    loadMore
  };
}

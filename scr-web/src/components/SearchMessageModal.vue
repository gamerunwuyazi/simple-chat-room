<template>
  <Teleport to="body" v-if="modelValue">
    <div class="search-modal-overlay" @click.self="handleClose">
      <div class="search-modal" :style="modalStyle">
        <div class="search-modal-header">
          <h3>查找消息</h3>
          <button class="close-btn" @click="handleClose">×</button>
        </div>
        <div class="search-modal-body">
          <div class="search-input-container">
            <input
              v-model="searchKeyword"
              type="text"
              :placeholder="inputPlaceholder"
              :disabled="isBrowseOnlyTypes"
              @keyup.enter="handleSearch"
              ref="searchInputRef"
            />
            <button
              class="search-btn"
              @click="handleSearch"
              :disabled="isSearching || (!searchKeyword.trim() && selectedTypes.length === 0)"
            >
              {{ isSearching ? '搜索中...' : searchBtnLabel }}
            </button>
          </div>
          <div class="search-type-filter">
            <button
              class="type-chip"
              :class="{ active: selectedTypes.length === 0 }"
              @click="clearTypes"
            >全部</button>
            <button
              v-for="opt in SEARCH_TYPE_OPTIONS"
              :key="opt.key"
              class="type-chip"
              :class="{ active: selectedTypes.includes(opt.key) }"
              @click="toggleType(opt.key)"
            >{{ opt.label }}</button>
          </div>
          <div v-if="searchResults.length > 0" class="search-results" ref="resultsScrollRef" @scroll="handleResultsScroll">
            <div class="search-results-count">
              {{ resultCountText }}
              <span class="search-nav-btns">
                <button class="search-nav-btn" @click="emit('navigatePrev')" :disabled="searchResults.length <= 1"><i class="fas fa-chevron-up" aria-hidden="true"></i></button>
                <button class="search-nav-btn" @click="emit('navigateNext')" :disabled="searchResults.length <= 1"><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
              </span>
            </div>
            <div class="search-results-list" ref="resultsListRef">
              <slot name="results" :results="searchResults" :onClick="handleScrollToMessage" />
              <div v-if="isLoadingMore" class="search-load-more-tip">加载中...</div>
              <div v-else-if="!hasMore" class="search-load-more-tip">没有更多了</div>
            </div>
          </div>
          <div v-else-if="hasSearched && !isSearching" class="no-results">
            {{ noResultsText }}
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.search-type-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 0 4px;
}

.type-chip {
  padding: 4px 12px;
  font-size: 12px;
  line-height: 20px;
  border: 1px solid #ddd;
  border-radius: 14px;
  background: #fff;
  color: #666;
  cursor: pointer;
}

.type-chip.active {
  border-color: #07c160;
  color: #07c160;
  background: rgba(7, 193, 96, 0.08);
}

.search-load-more-tip {
  text-align: center;
  font-size: 12px;
  color: #999;
  padding: 8px 0 2px;
}
</style>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';

const props = defineProps({
  modelValue: Boolean,
  searchResults: { type: Array, default: () => [] },
  isSearching: Boolean,
  hasSearched: Boolean,
  isLoadingMore: Boolean,
  hasMore: Boolean
});

const emit = defineEmits(['update:modelValue', 'search', 'navigatePrev', 'navigateNext', 'scrollToMessage', 'loadMore']);

const searchKeyword = ref('');
// 与后端 groupFeatureService.SEARCH_TYPES 的 key 保持一致
const SEARCH_TYPE_OPTIONS = [
  { key: 'text', label: '文本' },
  { key: 'image', label: '图片' },
  { key: 'file', label: '文件' },
  { key: 'card', label: '名片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' }
];
// 空数组 = 全部，不限制类型
const selectedTypes = ref([]);
const searchInputRef = ref(null);
const resultsListRef = ref(null);
const resultsScrollRef = ref(null);
const modalWidth = ref(null);

const BOTTOM_THRESHOLD = 40;

const modalStyle = computed(() => {
  if (modalWidth.value) {
    return { maxWidth: modalWidth.value + 'px' };
  }
  return {};
});

// 图片/文件类型没有可搜索文本：选了它们就只浏览，关键词输入置灰
const isBrowseOnlyTypes = computed(
  () => selectedTypes.value.includes('image') || selectedTypes.value.includes('file')
);

const inputPlaceholder = computed(() => {
  if (isBrowseOnlyTypes.value) return '该类型仅支持浏览，不支持关键词搜索';
  return '输入搜索内容，或选择类型直接浏览...';
});

const searchBtnLabel = computed(() => (searchKeyword.value.trim() ? '搜索' : '浏览'));

const resultCountText = computed(() =>
  searchKeyword.value.trim() ? `找到 ${props.searchResults.length} 条消息` : `已加载 ${props.searchResults.length} 条消息`
);

const noResultsText = computed(() =>
  searchKeyword.value.trim() || !isBrowseOnlyTypes.value ? '未找到匹配的消息' : '该类型暂无消息'
);

watch(() => props.searchResults, async () => {
  if (props.searchResults.length === 0) {
    modalWidth.value = null;
    return;
  }
  await nextTick();
  await nextTick();
  if (resultsListRef.value) {
    const children = resultsListRef.value.children;
    let maxWidth = 500;
    for (const child of children) {
      const w = child.scrollWidth;
      if (w > maxWidth) maxWidth = w;
    }
    modalWidth.value = maxWidth + 10;
  }
});

// 新搜索（非加载更多）开始时结果会被整体替换：
// 搜索结束后把结果区滚回顶部，避免停留在旧位置的中间
watch(() => props.isSearching, async (val, oldVal) => {
  if (oldVal && !val) {
    await nextTick();
    if (resultsScrollRef.value) {
      resultsScrollRef.value.scrollTop = 0;
    }
  }
});

function toggleType(key) {
  const idx = selectedTypes.value.indexOf(key);
  if (idx >= 0) {
    selectedTypes.value.splice(idx, 1);
  } else {
    selectedTypes.value.push(key);
  }
  // 选了图片/文件后只浏览：清掉已输入的关键词
  if (isBrowseOnlyTypes.value && searchKeyword.value) {
    searchKeyword.value = '';
  }
  // 已在浏览态（无关键词）时切换类型/全部，直接重新浏览或清空结果
  if (!searchKeyword.value.trim()) {
    emit('search', '', [...selectedTypes.value]);
  }
}

function clearTypes() {
  const hadBrowse = !searchKeyword.value.trim() && selectedTypes.value.length > 0;
  selectedTypes.value = [];
  if (hadBrowse) {
    emit('search', '', []);
  }
}

// 第二个参数为类型筛选；关键词为空且选了类型 = 浏览模式
function handleSearch() {
  emit('search', searchKeyword.value, [...selectedTypes.value]);
}

function handleResultsScroll() {
  const el = resultsScrollRef.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight >= BOTTOM_THRESHOLD) return;
  if (!props.hasMore || props.isLoadingMore || props.isSearching) return;
  emit('loadMore');
}

function handleClose() {
  searchKeyword.value = '';
  selectedTypes.value = [];
  emit('update:modelValue', false);
}

function handleScrollToMessage(msg) {
  emit('scrollToMessage', msg);
}

watch(() => props.modelValue, (val) => {
  if (val) {
    nextTick(() => {
      if (searchInputRef.value) {
        searchInputRef.value.focus();
      }
    });
  } else {
    searchKeyword.value = '';
    selectedTypes.value = [];
  }
});

defineExpose({ searchKeyword, searchInputRef, selectedTypes });
</script>

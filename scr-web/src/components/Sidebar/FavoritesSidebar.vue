<script setup>
/* eslint-disable vue/multi-word-component-names */
import { computed, onMounted } from 'vue';

import { useFavoriteStore, FAVORITE_CATEGORIES } from '@/stores/favoriteStore';

const favoriteStore = useFavoriteStore();

onMounted(() => {
  if (!favoriteStore.loaded) favoriteStore.loadFavorites();
});

const activeCategory = computed(() => favoriteStore.activeCategory);
const counts = computed(() => favoriteStore.categoryCounts);

function selectCategory(key) {
  favoriteStore.setActiveCategory(key);
}

function countOf(key) {
  return counts.value[key] || 0;
}
</script>

<template>
  <div id="secondary-sidebar">
    <div class="secondary-content" data-content="favorites">
        <div class="sidebar-section">
            <h3>我的收藏（{{ counts.all }}）</h3>
            <ul class="favorites-category-list">
                <li
                  v-for="cat in FAVORITE_CATEGORIES"
                  :key="cat.key"
                  :class="['favorites-category-item', { active: activeCategory === cat.key }]"
                  @click="selectCategory(cat.key)"
                >
                    <span class="favorites-category-label">{{ cat.label }}</span>
                    <span class="favorites-category-count">{{ countOf(cat.key) }}</span>
                </li>
            </ul>
            <div v-if="counts.all === 0" class="favorites-empty-hint">暂无收藏</div>
        </div>
    </div>
  </div>
</template>

<style scoped>
.favorites-category-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.favorites-category-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
  font-size: 14px;
  color: #334155;
  transition: all 0.2s ease;
}

.favorites-category-item:hover {
  background-color: #dde1e7;
}

.favorites-category-item.active {
  background-color: #3b82f6;
  color: #fff;
}

.favorites-category-item.active .favorites-category-count {
  background-color: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.favorites-category-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background-color: #e2e8f0;
  color: #64748b;
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}

.favorites-empty-hint {
  font-size: 13px;
  color: #94a3b8;
  padding: 8px 3px;
}

/* === 深色模式 === */
body.dark-mode .favorites-category-item {
  color: #c9d1d9;
}

body.dark-mode .favorites-category-item:hover {
  background-color: #21262d;
}

body.dark-mode .favorites-category-item.active {
  background-color: #1f6feb;
  color: #fff;
}

body.dark-mode .favorites-category-count {
  background-color: #30363d;
  color: #8b949e;
}

body.dark-mode .favorites-empty-hint {
  color: #6e7681;
}
</style>

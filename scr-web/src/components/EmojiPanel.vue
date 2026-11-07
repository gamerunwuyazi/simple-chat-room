<template>
  <div v-if="visible" ref="panelRef" class="emoji-panel" :style="panelStyle" @mousedown.stop>
    <div class="panel-head">
      <span class="panel-title">表情</span>
      <button class="panel-close" type="button" title="关闭" @mousedown.prevent @click="close">×</button>
    </div>

    <section v-if="recent.length > 0" class="panel-section">
      <div class="section-title">最近使用</div>
      <div class="emoji-grid">
        <button
          v-for="emoji in recent"
          :key="'recent-' + emoji"
          class="emoji-item"
          type="button"
          :title="emoji"
          @mousedown.prevent
          @click="pick(emoji)"
        >{{ emoji }}</button>
      </div>
    </section>

    <section class="panel-section">
      <div class="section-title">全部表情</div>
      <div class="emoji-grid all-grid">
        <button
          v-for="emoji in allEmojis"
          :key="'all-' + emoji"
          class="emoji-item"
          type="button"
          :title="emoji"
          @mousedown.prevent
          @click="pick(emoji)"
        >{{ emoji }}</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // 最近使用最多保留条数
  maxRecent: { type: Number, default: 20 }
});

const emit = defineEmits(['update:visible', 'select']);

const STORAGE_KEY = 'emoji:recent';

const EMOJI_GROUPS = [
  [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
    '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
    '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳',
    '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫',
    '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '😱', '😨',
    '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐'
  ],
  [
    '👍', '👎', '👌', '🤌', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙',
    '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋',
    '🤝', '🙏', '💪', '👏', '🙌', '👐', '🤲', '🫶', '✍️', '🫡'
  ],
  [
    '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🔥', '💯', '✨', '⭐',
    '🌟', '⚡', '💥', '💫', '❤️', '🧡', '💛', '💚', '💙', '💜',
    '🖤', '🤍', '💔', '💖', '💗', '💓', '💞', '💕', '☕', '🍺',
    '🍻', '🍎', '🍉', '🍰', '🎂', '🌹', '🌸', '🌻', '🌈', '☀️'
  ]
];

const allEmojis = computed(() => EMOJI_GROUPS.flat());

const recent = ref(readRecent());

function readRecent() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((item) => typeof item === 'string' && item).slice(0, props.maxRecent);
  } catch (e) {
    return [];
  }
}

function writeRecent(list) {
  recent.value = list;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    // localStorage 不可用（隐私模式/配额满）时仅保留内存态
  }
}

function pick(emoji) {
  const next = [emoji, ...recent.value.filter((item) => item !== emoji)].slice(0, props.maxRecent);
  writeRecent(next);
  emit('select', emoji);
}

/**
 * 把表情插入 contenteditable 的光标处。
 * 面板按钮都做了 mousedown.prevent，正常不会丢选区；
 * 若输入框此前已失焦（例如先点了工具栏再点表情），退化为追加到末尾。
 * @returns {boolean} 是否插入成功
 */
function insertAtCaret(target, text) {
  if (!target || !text) return false;
  if (typeof document === 'undefined') return false;

  // 先判断插入前是否已有落在输入框内的选区：focus() 会把光标重置到开头，
  // 必须在 focus 之前判断，否则失焦后插入会跑到文本最前面
  const selection = window.getSelection();
  if (!selection) return false;

  const hadCaret = selection.rangeCount > 0
    && target.contains(selection.getRangeAt(0).commonAncestorContainer);

  target.focus();

  if (!hadCaret) {
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch (e) {
    inserted = false;
  }

  if (!inserted) {
    // execCommand 不被支持时的降级：手工在光标处插入文本节点
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  target.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function close() {
  emit('update:visible', false);
}

/**
 * 计算面板在视口内的位置（纯函数，不依赖 DOM，便于在 node 中直接验证）
 *
 * 背景：面板原先用 `position:absolute; bottom:calc(100% + 8px)`，
 * 而它在三处聊天页里都是整屏高容器的直接子元素，百分比基准落到最近的
 * `position:relative` 祖先（#chat-main，rect y=0 h=900），
 * 导致面板被推到视口上方（实测 rect y=-261/-315）并被祖先 overflow:hidden 裁掉。
 * 现在改为 position:fixed + 依据触发按钮的视口坐标显式计算位置。
 *
 * @param {{left:number,top:number,bottom:number}} triggerRect 触发按钮的视口坐标
 * @param {{width:number,height:number}} panelSize 面板自身尺寸
 * @param {{width:number,height:number}} viewport 视口尺寸
 * @returns {{top:number,left:number,maxHeight:number,placement:'above'|'below'|'fit'}}
 */
function computePanelPlacement(triggerRect, panelSize, viewport) {
  const gap = 8;
  const margin = 8;
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = Math.min(panelSize.width, availableWidth);
  // 实际渲染高度（超出可用空间时由 max-height 限制 + 内部滚动）
  const height = Math.min(panelSize.height, availableHeight);

  // 水平：与按钮左边缘对齐，超出视口则向内收
  const left = Math.min(
    Math.max(triggerRect.left, margin),
    Math.max(margin, viewport.width - width - margin)
  );

  // 垂直：默认向上弹出（面板在按钮上方）；上方放不下改为向下；都放不下就贴视口顶部
  const aboveTop = triggerRect.top - height - gap;
  const belowTop = triggerRect.bottom + gap;
  const fitsAbove = aboveTop >= margin && aboveTop + height <= viewport.height - margin;
  const fitsBelow = belowTop >= margin && belowTop + height <= viewport.height - margin;
  let top;
  let placement;
  if (fitsAbove) {
    top = aboveTop;
    placement = 'above';
  } else if (fitsBelow) {
    top = belowTop;
    placement = 'below';
  } else {
    top = Math.max(margin, Math.min(belowTop, viewport.height - margin - height));
    placement = 'fit';
  }

  return { top, left, maxHeight: height, placement };
}

const panelRef = ref(null);
// 定位完成前先隐藏，避免面板先以静态位置渲染一帧再跳到目标位置
const panelStyle = ref({ opacity: '0' });

/** 找到触发按钮：优先同视图内（面板父容器下）的 .emoji-button，其次页面上可见的那个 */
function findTrigger() {
  const panel = panelRef.value;
  const scope = panel?.parentElement;
  const inScope = scope?.querySelector?.('.emoji-button');
  if (inScope) return inScope;
  const all = Array.from(document.querySelectorAll('.emoji-button'));
  return all.find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }) || null;
}

function updatePosition() {
  const panel = panelRef.value;
  if (!panel || typeof window === 'undefined') return;
  const panelSize = { width: panel.offsetWidth, height: panel.offsetHeight };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const trigger = findTrigger();

  let placement;
  if (trigger) {
    placement = computePanelPlacement(trigger.getBoundingClientRect(), panelSize, viewport);
  } else {
    // 找不到触发按钮时贴视口左下角，保证面板仍然可见可用
    placement = {
      top: Math.max(8, viewport.height - panelSize.height - 8),
      left: 8,
      maxHeight: Math.min(panelSize.height, Math.max(0, viewport.height - 16)),
      placement: 'fallback'
    };
  }

  panelStyle.value = {
    position: 'fixed',
    top: `${placement.top}px`,
    left: `${placement.left}px`,
    maxHeight: `${placement.maxHeight}px`,
    opacity: '1'
  };
}

function handleViewportChange() {
  if (props.visible) updatePosition();
}

watch(
  () => props.visible,
  async (val) => {
    if (!val) return;
    // 等面板渲染出来拿到实际尺寸后再定位
    await nextTick();
    updatePosition();
  }
);

onMounted(() => {
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
});

defineExpose({ recent, allEmojis, pick, insertAtCaret, close });
</script>

<style scoped>
.emoji-panel {
  /* 定位改为 JS 依据触发按钮计算（position:fixed + top/left，见 computePanelPlacement）。
     原来的 position:absolute + bottom:calc(100% + 8px) 的百分比基准会落到
     #chat-main（整屏高），把面板推到视口外并被 overflow:hidden 裁掉 */
  position: fixed;
  width: 336px;
  max-width: calc(100vw - 16px);
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  padding: 8px;
  z-index: 1200;
  overflow-y: auto;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px 6px;
  border-bottom: 1px solid #f0f2f5;
}

.panel-title {
  font-size: 12px;
  color: #909399;
}

.panel-close {
  border: none;
  background: transparent;
  color: #909399;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.panel-section {
  margin-top: 8px;
}

.section-title {
  font-size: 11px;
  color: #a8abb2;
  margin-bottom: 4px;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
}

.all-grid {
  max-height: 180px;
  overflow-y: auto;
}

.emoji-item {
  border: none;
  background: transparent;
  font-size: 18px;
  line-height: 1;
  padding: 4px 0;
  border-radius: 6px;
  cursor: pointer;
}

.emoji-item:hover {
  background: #f2f4f8;
}
</style>

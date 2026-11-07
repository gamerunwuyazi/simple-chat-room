<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-box">
        <div class="modal-head">
          <h3>{{ isJoinMode ? '接龙' : '发起群接龙' }}</h3>
          <button class="close-btn" type="button" @click="close">×</button>
        </div>
        <div class="modal-body">
          <div v-if="isJoinMode" class="join-chain-title">
            <span class="join-chain-label">接龙标题</span>
            <span class="join-chain-name">{{ chainTitle || '未命名接龙' }}</span>
          </div>
          <label v-if="!isJoinMode" class="field">
            <span>标题</span>
            <input v-model="form.title" type="text" maxlength="60" placeholder="例如：周末聚餐报名" />
          </label>
          <label class="field">
            <span>{{ isJoinMode ? '接龙内容（可选）' : '说明（可选）' }}</span>
            <textarea v-model="form.content" rows="3" maxlength="500" :placeholder="isJoinMode ? '填写接龙内容，例如姓名/份数' : '补充说明，例如时间地点'"></textarea>
          </label>
          <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="close">取消</button>
          <button class="btn primary" type="button" :disabled="submitting || (!isJoinMode && !form.title.trim())" @click="submit">
            {{ submitting ? '提交中...' : (isJoinMode ? '确认接龙' : '发起接龙') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  submitting: { type: Boolean, default: false },
  // create = 发起接龙；join = 参与接龙（复用同一弹窗形态）
  mode: { type: String, default: 'create' },
  // join 模式下展示的接龙标题
  chainTitle: { type: String, default: '' }
});

const emit = defineEmits(['update:modelValue', 'confirm']);

const isJoinMode = computed(() => props.mode === 'join');

const form = reactive({ title: '', content: '' });
const errorMsg = ref('');

watch(() => props.modelValue, (visible) => {
  if (visible) {
    form.title = '';
    form.content = '';
    errorMsg.value = '';
  }
});

function close() {
  emit('update:modelValue', false);
}

function submit() {
  const title = form.title.trim();
  if (!isJoinMode.value && !title) {
    errorMsg.value = '标题不能为空';
    return;
  }
  emit('confirm', { title, content: form.content.trim(), mode: props.mode });
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.modal-box {
  width: 380px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #f0f2f5;
}

.modal-head h3 {
  margin: 0;
  font-size: 15px;
  color: #303133;
}

.close-btn {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: #909399;
  cursor: pointer;
}

.modal-body {
  padding: 14px 16px;
}

.join-chain-title {
  margin-bottom: 12px;
  padding: 8px 10px;
  background: #f5f8ff;
  border-radius: 6px;
}

.join-chain-label {
  display: block;
  font-size: 11px;
  color: #909399;
  margin-bottom: 2px;
}

.join-chain-name {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  word-break: break-word;
}

.field {
  display: block;
  margin-bottom: 12px;
}

.field span {
  display: block;
  font-size: 12px;
  color: #606266;
  margin-bottom: 4px;
}

.field input,
.field textarea {
  width: 100%;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
  box-sizing: border-box;
  outline: none;
}

.field input:focus,
.field textarea:focus {
  border-color: #409eff;
}

.error-msg {
  margin: 0;
  font-size: 12px;
  color: #f56c6c;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #f0f2f5;
}

.btn {
  border-radius: 6px;
  font-size: 13px;
  padding: 6px 14px;
  cursor: pointer;
  border: 1px solid transparent;
}

.btn.ghost {
  background: #fff;
  border-color: #dcdfe6;
  color: #606266;
}

.btn.primary {
  background: #409eff;
  color: #fff;
}

.btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 深色模式：对齐 index.css 的 #161b22/#21262d/#30363d/#c9d1d9 调色板 */
body.dark-mode .modal-overlay {
  background: rgba(0, 0, 0, 0.7);
}

body.dark-mode .modal-box {
  background: #161b22;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}

body.dark-mode .modal-head {
  border-bottom-color: #30363d;
}

body.dark-mode .modal-head h3 {
  color: #c9d1d9;
}

body.dark-mode .close-btn {
  color: #8b949e;
}

body.dark-mode .join-chain-title {
  background: #21262d;
}

body.dark-mode .join-chain-label {
  color: #8b949e;
}

body.dark-mode .join-chain-name {
  color: #c9d1d9;
}

body.dark-mode .field span {
  color: #8b949e;
}

body.dark-mode .field input,
body.dark-mode .field textarea {
  background-color: #21262d;
  color: #c9d1d9;
  border-color: #30363d;
}

body.dark-mode .field input::placeholder,
body.dark-mode .field textarea::placeholder {
  color: #484f58;
}

body.dark-mode .modal-foot {
  border-top-color: #30363d;
}

body.dark-mode .btn.ghost {
  background: #21262d;
  border-color: #30363d;
  color: #c9d1d9;
}
</style>

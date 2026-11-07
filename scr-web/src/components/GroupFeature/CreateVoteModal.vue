<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="close">
      <div class="modal-box">
        <div class="modal-head">
          <h3>发起群投票</h3>
          <button class="close-btn" type="button" @click="close">×</button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>标题</span>
            <input v-model="form.title" type="text" maxlength="60" placeholder="例如：下次团建去哪里" />
          </label>
          <label class="field">
            <span>说明（可选）</span>
            <textarea v-model="form.description" rows="2" maxlength="300"></textarea>
          </label>

          <div class="field">
            <span>选项（2-10 个）</span>
            <div v-for="(option, index) in form.options" :key="index" class="option-row">
              <input v-model="form.options[index]" type="text" maxlength="40" :placeholder="`选项 ${index + 1}`" />
              <button
                v-if="form.options.length > 2"
                class="remove-btn"
                type="button"
                title="删除"
                @click="removeOption(index)"
              >−</button>
            </div>
            <button v-if="form.options.length < 10" class="add-btn" type="button" @click="addOption">+ 添加选项</button>
          </div>

          <div class="switch-row">
            <label class="switch-item">
              <input v-model="form.multiple" type="checkbox" />
              <span>多选</span>
            </label>
            <label class="switch-item">
              <input v-model="form.anonymous" type="checkbox" />
              <span>匿名投票</span>
            </label>
          </div>

          <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="close">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中...' : '发起投票' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { reactive, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  submitting: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue', 'confirm']);

const form = reactive({
  title: '',
  description: '',
  multiple: false,
  anonymous: false,
  options: ['', '']
});

const errorMsg = ref('');

watch(() => props.modelValue, (visible) => {
  if (visible) {
    form.title = '';
    form.description = '';
    form.multiple = false;
    form.anonymous = false;
    form.options = ['', ''];
    errorMsg.value = '';
  }
});

function addOption() {
  form.options.push('');
}

function removeOption(index) {
  form.options.splice(index, 1);
}

function close() {
  emit('update:modelValue', false);
}

function submit() {
  const title = form.title.trim();
  const options = form.options.map((item) => item.trim()).filter(Boolean);

  if (!title) {
    errorMsg.value = '标题不能为空';
    return;
  }
  if (options.length < 2) {
    errorMsg.value = '至少需要两个选项';
    return;
  }
  if (new Set(options).size !== options.length) {
    errorMsg.value = '选项不能重复';
    return;
  }

  emit('confirm', {
    title,
    description: form.description.trim(),
    multiple: form.multiple,
    anonymous: form.anonymous,
    options
  });
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
  width: 400px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
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
  overflow-y: auto;
}

.field {
  display: block;
  margin-bottom: 12px;
}

.field > span {
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

.option-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.remove-btn {
  flex: 0 0 26px;
  height: 26px;
  border: 1px solid #dcdfe6;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  color: #909399;
}

.add-btn {
  border: 1px dashed #c0c4cc;
  background: #fff;
  color: #606266;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.switch-row {
  display: flex;
  gap: 18px;
  margin-bottom: 6px;
}

.switch-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #606266;
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

body.dark-mode .field > span {
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

body.dark-mode .remove-btn {
  background: #21262d;
  border-color: #30363d;
  color: #8b949e;
}

body.dark-mode .add-btn {
  background: #21262d;
  border-color: #4b5563;
  color: #c9d1d9;
}

body.dark-mode .switch-item {
  color: #8b949e;
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

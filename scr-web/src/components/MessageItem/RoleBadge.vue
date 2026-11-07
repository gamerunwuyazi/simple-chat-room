<template>
  <span v-if="role" :class="['role-badge', role]">{{ label }}</span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  role: {
    type: String,
    default: '',
    validator: (v) => ['', 'owner', 'admin'].includes(v)
  }
});

const label = computed(() => (props.role === 'owner' ? '群主' : props.role === 'admin' ? '管理员' : ''));
</script>

<style scoped>
.role-badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  margin-left: 4px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 1;
  font-weight: 500;
  vertical-align: middle;
  white-space: nowrap;
}

.role-badge.owner {
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fcd34d;
}

.role-badge.admin {
  color: #1d4ed8;
  background: #e0edff;
  border: 1px solid #bfdbfe;
}
</style>

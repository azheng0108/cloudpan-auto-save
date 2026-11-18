import { defineStore } from 'pinia';
import { ref } from 'vue';
import { taskApi, type TaskItem } from '../api/task';

export const useTaskStore = defineStore('task', () => {
  const tasks = ref<TaskItem[]>([]);
  const loading = ref(false);

  async function fetchTasks() {
    loading.value = true;
    try {
      tasks.value = await taskApi.getTasks();
    } finally {
      loading.value = false;
    }
  }

  return {
    tasks,
    loading,
    fetchTasks,
  };
});

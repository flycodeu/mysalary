<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{ open: boolean; title: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
async function sync() {
  await nextTick();
  if (props.open && !dialog.value?.open) dialog.value?.showModal();
  else if (!props.open && dialog.value?.open) dialog.value.close();
}
watch(() => props.open, sync);
onMounted(sync);
function close() {
  if (!props.busy) emit("close");
}
function backdrop(event: MouseEvent) {
  if (event.target !== dialog.value) return;
  const rect = dialog.value.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    close();
}
</script>
<template>
  <dialog
    ref="dialog"
    class="modal-sheet"
    :aria-label="title"
    @cancel.prevent="close"
    @click="backdrop"
  >
    <template v-if="open">
      <header class="sheet-header">
        <h2>{{ title }}</h2>
        <button
          class="icon-button"
          title="关闭"
          aria-label="关闭"
          :disabled="busy"
          @click="close"
        >
          <AppIcon name="close" />
        </button>
      </header>
      <slot />
    </template>
  </dialog>
</template>

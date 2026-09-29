<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useModalNavigation } from "../composables/useBackNavigation";
import AppIcon from "./AppIcon.vue";
const props = defineProps<{ open: boolean; title: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const navigation = useModalNavigation();
const blocked = computed(() => Boolean(props.busy || navigation?.blocked()));
let unregister: (() => void) | undefined;
const layer = {
  close,
  busy: () => Boolean(props.busy),
};
async function sync() {
  await nextTick();
  if (props.open && dialog.value && !dialog.value.open) {
    dialog.value.showModal();
    unregister = navigation?.add(layer);
  } else if (!props.open) {
    dialog.value?.close();
    unregister?.();
    unregister = undefined;
  }
}
watch(() => props.open, sync);
onMounted(sync);
onBeforeUnmount(() => { unregister?.(); });
function close() {
  if (!props.open || blocked.value) return;
  if (navigation && !navigation.isTop(layer)) return;
  emit("close");
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
    :aria-busy="blocked"
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
          :disabled="blocked"
          @click="close"
        >
          <AppIcon name="close" />
        </button>
      </header>
      <slot />
    </template>
  </dialog>
</template>

<script setup lang="ts">
defineProps<{
  name:
    | "plus"
    | "arrow"
    | "image"
    | "check"
    | "back"
    | "scan"
    | "close"
    | "eye"
    | "save"
    | "trash"
    | "more"
    | "edit"
    | "cloud"
    | "sync"
    | "settings"
    | "dashboard"
    | "download"
    | "file";
}>();
const paths = {
  dashboard: "M4 4h6v7H4zM14 4h6v4h-6zM4 15h6v5H4zM14 12h6v8h-6z",
  settings: "m9 3-.6 2.3-2 .9-2.1-.7-2 3.5 1.5 1.6v2.8L2.3 15l2 3.5 2.1-.7 2 .9L9 21h4l.6-2.3 2-.9 2.1.7 2-3.5-1.5-1.6v-2.8L19.7 9l-2-3.5-2.1.7-2-.9L13 3H9zM11 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  cloud: "M6 18a4 4 0 0 1-1-7.87A7 7 0 0 1 18.5 9 4.5 4.5 0 0 1 18 18H6z",
  sync: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 4M18 18a8 8 0 0 1-13-4",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  edit: "m15 4 5 5M4 20l5-1L20 8l-5-5L4 14v6z",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  image: "M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01",
  check: "m5 12 4 4L19 6",
  back: "m14 5-7 7 7 7",
  scan: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M6 12h12",
  close: "m6 6 12 12M6 18 18 6",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  save: "M5 3h12l4 4v14H3V3h2zm2 0v6h10V3M7 21v-8h10v8",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  file: "M14 3H5v18h14V8l-5-5zm0 0v5h5M8 12h8m-8 4h6",
};
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>

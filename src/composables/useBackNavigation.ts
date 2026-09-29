import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  type InjectionKey,
  type Ref,
} from "vue";

export const NATIVE_BACK_EVENT = "salary:navigate-back";
type Page = "root" | "detail" | "deleted";
interface ModalLayer {
  close(): void;
  busy(): boolean;
}
interface ModalNavigation {
  add(layer: ModalLayer): () => void;
  isTop(layer: ModalLayer): boolean;
  blocked(): boolean;
}
const navigationKey: InjectionKey<ModalNavigation> = Symbol("salary-back-navigation");

/** Registered when showModal succeeds, so stack order matches the browser top layer. */
export function useModalNavigation() {
  return inject(navigationKey, undefined);
}

export function useBackNavigation(options: {
  blocked: Ref<boolean>;
  page: Ref<Page>;
  back(): void;
  root(): void;
}) {
  const layers = shallowRef<ModalLayer[]>([]);
  const gesture = ref<{ edge: "left" | "right"; distance: number }>();
  let handling = false;
  const navigation: ModalNavigation = {
    add(layer) {
      layers.value = [...layers.value, layer];
      return () => {
        layers.value = layers.value.filter((entry) => entry !== layer);
      };
    },
    isTop: (layer) => layers.value.at(-1) === layer,
    blocked: () => options.blocked.value,
  };
  provide(navigationKey, navigation);

  const state = computed(() => {
    if (options.blocked.value || layers.value.at(-1)?.busy()) return "busy";
    return layers.value.length ? "modal" : options.page.value;
  });
  async function back() {
    if (handling || state.value === "busy") return;
    // Repeated native callbacks in one render must not close a dialog and its parent page.
    handling = true;
    try {
      const top = layers.value.at(-1);
      if (top) top.close();
      else if (options.page.value !== "root") options.back();
      else options.root();
      await nextTick();
    } finally {
      handling = false;
    }
  }

  let touch: {
    id: number;
    x: number;
    y: number;
    edge: "left" | "right";
    horizontal: boolean;
    cancelled: boolean;
  } | undefined;
  let lastGestureBack = -Infinity;
  function resetGesture() {
    touch = undefined;
    gesture.value = undefined;
  }
  function start(event: TouchEvent) {
    resetGesture();
    if (window.innerWidth >= 960 || event.touches.length !== 1 || state.value === "busy") return;
    const target = event.target;
    if (target instanceof Element && target.closest("input,textarea,select,[contenteditable=true]")) return;
    const point = event.touches[0]!;
    const edge = point.clientX <= 24 ? "left" : point.clientX >= window.innerWidth - 24 ? "right" : undefined;
    if (!edge) return;
    touch = { id: point.identifier, x: point.clientX, y: point.clientY, edge, horizontal: false, cancelled: false };
  }
  function move(event: TouchEvent) {
    if (!touch || touch.cancelled) return;
    if (event.touches.length !== 1 || state.value === "busy") return resetGesture();
    const point = [...event.touches].find((entry) => entry.identifier === touch!.id);
    if (!point) return resetGesture();
    const dx = (point.clientX - touch.x) * (touch.edge === "left" ? 1 : -1);
    const dy = Math.abs(point.clientY - touch.y);
    if (!touch.horizontal) {
      // Once vertical scrolling wins, later sideways motion cannot turn it into a back action.
      if (dy > 12 && dy >= Math.abs(dx)) { touch.cancelled = true; return; }
      if (dx < -12) { touch.cancelled = true; return; }
      if (dx < 16 || dx < dy * 1.8) return;
      touch.horizontal = true;
    }
    if (dy > 64 || dx < 0) { touch.cancelled = true; gesture.value = undefined; return; }
    if (event.cancelable) event.preventDefault();
    gesture.value = { edge: touch.edge, distance: Math.max(0, dx) };
  }
  function end(event: TouchEvent) {
    const point = touch && [...event.changedTouches].find((entry) => entry.identifier === touch!.id);
    // Browsers can coalesce the final touchmove, so the release position is authoritative.
    const distance = point && touch ? (point.clientX - touch.x) * (touch.edge === "left" ? 1 : -1) : 0;
    const completed = Boolean(point && touch && !touch.cancelled && touch.horizontal &&
      Math.abs(point.clientY - touch.y) <= 64 && distance >= Math.max(72, window.innerWidth * 0.2));
    resetGesture();
    if (completed) {
      lastGestureBack = performance.now();
      void back();
    }
  }
  const nativeBack = () => {
    resetGesture();
    // Some Android WebViews also report the system edge gesture after its touch sequence.
    if (performance.now() - lastGestureBack < 400) return;
    void back();
  };
  onMounted(() => {
    window.addEventListener(NATIVE_BACK_EVENT, nativeBack);
    document.addEventListener("touchstart", start, { passive: true });
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", resetGesture, { passive: true });
  });
  onBeforeUnmount(() => {
    window.removeEventListener(NATIVE_BACK_EVENT, nativeBack);
    document.removeEventListener("touchstart", start);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", resetGesture);
  });
  return { state, gesture, back };
}

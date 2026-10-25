import { useSyncExternalStore } from "react";
import { store } from "./host";

/** 1s 心跳（本地时钟），驱动"已运行 x 秒"这类相对时间的重渲染。 */
export function useTicker(ms = 1000): number {
  return useSyncExternalStore(
    (notify) => {
      const t = setInterval(notify, ms);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / ms),
    () => 0,
  );
}

export function useStore(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
}

/*
 * 正交意图：应用版本号的唯一注入点（tsdown define），宿主侧展示（窗口标题/启动日志）引用此处。
 */
declare const __APP_VERSION__: string;

export const APP_VERSION = __APP_VERSION__;

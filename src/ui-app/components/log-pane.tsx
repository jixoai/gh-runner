import { useEffect, useRef } from "react";
import { Glass } from "solid-glass/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { store } from "@/lib/host";
import { classifyLog, splitEventLine } from "@/lib/format";
import type { InstanceView } from "@/lib/host";

const LINE_COLOR = {
  ok: "text-ok",
  bad: "text-bad",
  warn: "text-warn",
  run: "text-run",
  dim: "text-muted-foreground",
} as const;

export function LogPane({
  inst,
  logLines,
  autoScroll,
  onAutoScrollChange,
}: {
  inst: InstanceView | null;
  logLines: string[];
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // 追加/重置时贴底（仅当用户停留在底部附近；用户上翻则不打扰）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (autoScroll && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [logLines.length, autoScroll, inst?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  return (
    <Glass
      effect="frosted"
      options={{ blur: 18, tintOpacity: 0.06 }}
      className="glass-panel flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/25 dark:border-white/10"
    >
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {inst ? `日志 — ${inst.name}` : "日志（选择实例）"}
        </span>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <Switch checked={autoScroll} onCheckedChange={onAutoScrollChange} aria-label="自动滚动" />
          自动滚动
        </label>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          disabled={!inst}
          onClick={() => inst && store.send({ type: "open-diag", id: inst.id })}
        >
          日志目录
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="log-scroll flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {logLines.length === 0 ? (
          <div className="grid h-full place-items-center text-muted-foreground/70">
            {inst ? "暂无日志" : "尚无实例"}
          </div>
        ) : (
          logLines.map((line, i) => <LogLine key={i} line={line} />)
        )}
      </div>
    </Glass>
  );
}

function LogLine({ line }: { line: string }) {
  if (!line) return <div>&nbsp;</div>;
  const cls = classifyLog(line);
  const split = cls && cls !== "dim" ? splitEventLine(line) : null;
  if (split && cls && cls !== "dim") {
    return (
      <div className="log-line whitespace-pre">
        <span className="text-muted-foreground/70">{split.ts}: </span>
        <span className={LINE_COLOR[cls]}>{split.body}</span>
      </div>
    );
  }
  return (
    <div className={cn("log-line whitespace-pre", cls && LINE_COLOR[cls])}>{line}</div>
  );
}

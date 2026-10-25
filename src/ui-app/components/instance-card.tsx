import { Play, Square, FolderOpen, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { store, type InstanceView } from "@/lib/host";
import { cn } from "@/lib/utils";
import { dotClass, fmtAgo, fmtDuration, outcomeClass, stateText } from "@/lib/format";

const DOT: Record<string, string> = {
  busy: "bg-run dot-busy",
  running: "bg-ok",
  stopped: "bg-muted-foreground/60",
  starting: "bg-warn",
  stopping: "bg-warn",
};

const PILL: Record<string, string> = {
  busy: "border-transparent bg-run/15 text-run",
  running: "border-transparent bg-ok/15 text-ok",
  stopped: "border-border bg-secondary text-muted-foreground",
  starting: "border-transparent bg-warn/15 text-warn",
  stopping: "border-transparent bg-warn/15 text-warn",
};

export function InstanceCard({
  inst,
  selected,
  onSelect,
  tick,
}: {
  inst: InstanceView;
  selected: boolean;
  onSelect: (id: string) => void;
  tick: number;
}) {
  const startable = inst.processState === "stopped" && inst.configured;
  const stoppable = inst.processState === "running" || inst.processState === "starting";
  const busy = inst.currentJob !== null;

  const onStop = () => {
    if (busy) {
      const job = inst.currentJob!.job;
      if (!window.confirm(`「${inst.name}」正在作业 ${job}。\n强制停止会把该作业标记为失败。确定停止？`)) return;
    }
    store.send({ type: "stop", id: inst.id });
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onSelect(inst.id)}
      onKeyDown={(e) => e.key === "Enter" && onSelect(inst.id)}
      className={cn(
        "glass-card cursor-pointer gap-2.5 rounded-xl border border-white/25 p-3.5 transition-all hover:brightness-[1.03] focus-visible:ring-2 dark:border-white/10",
        selected && "border-primary/50 bg-primary/8 ring-1 ring-primary/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-[7px] shrink-0 rounded-full", DOT[dotClass(inst)])} />
        <span className="truncate text-sm font-semibold">{inst.name}</span>
        <Badge variant="outline" className={cn("px-2 text-[11px]", PILL[dotClass(inst)])}>
          {stateText(inst)}
        </Badge>
        {inst.external && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="border-transparent bg-ext/15 px-2 text-[11px] text-ext">
                外部
              </Badge>
            </TooltipTrigger>
            <TooltipContent>由其它终端/launchd 启动，非本工具拉起</TooltipContent>
          </Tooltip>
        )}
        {!inst.configured && (
          <Badge variant="outline" className="border-transparent bg-warn/15 px-2 text-[11px] text-warn">
            未注册
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={!startable}
            onClick={() => store.send({ type: "start", id: inst.id })}
          >
            <Play className="size-3" /> 启动
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs text-bad hover:text-bad"
            disabled={!stoppable}
            onClick={onStop}
          >
            <Square className="size-3" /> 停止
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  disabled={!inst.configured}
                  onClick={() => store.send({ type: "open-diag", id: inst.id })}
                >
                  <FolderOpen className="size-3.5" />
                </Button>
              </div>
            </TooltipTrigger>
            <TooltipContent>在文件管理器中打开日志目录</TooltipContent>
          </Tooltip>
          <label
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
            title="工具启动时自动拉起该实例"
          >
            <Switch
              checked={inst.autoStart}
              onCheckedChange={(v) => store.send({ type: "set-auto-start", id: inst.id, value: v })}
              aria-label="自动启动"
            />
            自启
          </label>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        #{inst.agentId ?? "—"} · <span className="truncate align-middle">{inst.dir}</span>
      </div>

      <div className="grid min-h-5 gap-0.5 text-xs">
        {inst.currentJob && (
          <span>
            作业中 <b className="text-foreground">{inst.currentJob.job}</b>
            <span className="text-muted-foreground">
              （已运行 {fmtDuration(tick - Date.parse(inst.currentJob.startedAt))}）
            </span>
          </span>
        )}
        {inst.lastResult ? (
          <span>
            最近动作 <b className="text-foreground">{inst.lastResult.job}</b>
            {" → "}
            <span className={cn("font-medium", outcomeText(outcomeClass(inst.lastResult.outcome)))}>
              {inst.lastResult.outcome === "Succeeded" || inst.lastResult.outcome === "SucceededWithIssues"
                ? "✔"
                : "✘"}{" "}
              {inst.lastResult.outcome}
            </span>
            <span className="text-muted-foreground">
              （{fmtDuration(inst.lastResult.durationMs)}，{fmtAgo(inst.lastResult.at)}前）
            </span>
          </span>
        ) : (
          !inst.currentJob && <span className="text-muted-foreground/70">暂无作业记录</span>
        )}
      </div>

      {inst.lastError && (
        <div className="flex items-start gap-1.5 text-xs text-bad">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="select-text">{inst.lastError}</span>
        </div>
      )}
    </Card>
  );
}

function outcomeText(cls: "ok" | "warn" | "bad"): string {
  return { ok: "text-ok", warn: "text-warn", bad: "text-bad" }[cls];
}

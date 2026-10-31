import { useEffect, useState } from "react";
import { Glass } from "solid-glass/react";
import { FolderInput, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstanceCard } from "@/components/instance-card";
import { LogPane } from "@/components/log-pane";
import { RegisterDialog } from "@/components/register-dialog";
import { RunnerOperationDialog } from "@/components/runner-operation-dialog";
import { setTaskAnnouncer, store, type InstanceView } from "@/lib/host";
import { useStore, useTicker } from "@/lib/hooks";
import { Toaster, toast } from "sonner";

export function App() {
  useStore(); // 订阅宿主推送
  const tick = useTicker(1000);
  const summary = store.summary;
  const [selected, setSelected] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [managed, setManaged] = useState<InstanceView | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    setTaskAnnouncer((message, kind) =>
      kind === "ok" ? toast.success(message) : toast.error(message),
    );
  }, []);

  // 注册任务进行中自动弹开对话框（进度在对话框内可见）
  useEffect(() => {
    if (summary?.task.kind === "register" && summary.task.status === "running") {
      setRegisterOpen(true);
    }
  }, [summary?.task.status, summary?.task.kind]);

  const instances = summary?.instances ?? [];
  if (selected && !instances.some((i) => i.id === selected)) setSelected(null);
  const effectiveSelected = selected ?? instances[0]?.id ?? null;
  const selectedInst = instances.find((i) => i.id === effectiveSelected) ?? null;

  const running = instances.filter((i) => i.processState === "running" || i.processState === "starting").length;
  const busy = instances.filter((i) => i.currentJob).length;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部玻璃条：标题 + 摘要 + 主行动 */}
      <Glass
        effect="frosted"
        options={{ blur: 20, tintOpacity: 0.05 }}
        className="flex flex-none items-center gap-3 border-b border-white/25 px-4 py-2.5 dark:border-white/10"
      >
        <span className="text-sm font-bold tracking-wide">GH Runner</span>
        <span className="flex-1 truncate text-xs text-muted-foreground">
          {summary
            ? `${instances.length} 实例 · ${running} 在线 · ${busy} 作业中`
            : "连接宿主中…"}
        </span>
        <Button
          size="sm"
          className="h-7 gap-1 text-xs"
          title="选择已有 runner 的目录（含 .runner），免 Token 接入管理；work 目录自动恢复"
          disabled={summary?.task.status === "running"}
          onClick={() => store.send({ type: "import-runner-dir" })}
        >
          <FolderInput className="size-3.5" /> 导入 runner 目录
        </Button>
        <Button size="sm" className="h-7 gap-1 text-xs" disabled={summary?.task.status === "running"} onClick={() => setRegisterOpen(true)}>
          <Plus className="size-3.5" /> 注册新实例
        </Button>
      </Glass>

      {/* 主面板：左实例卡 / 右实时日志（八二空间：高频操作占满视觉区） */}
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(380px,11fr)_minmax(320px,9fr)]">
        <section className="min-h-0 space-y-2.5 overflow-y-auto p-3">
          {instances.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground/90">
              尚无实例——点击右上角「注册新实例」开始
            </div>
          ) : (
            instances.map((inst) => (
              <InstanceCard
                key={inst.id}
                inst={inst}
                selected={inst.id === effectiveSelected}
                onSelect={setSelected}
                tick={tick}
                onManage={setManaged}
                operationBusy={summary?.task.status === "running"}
              />
            ))
          )}
        </section>
        <section className="min-h-0 border-l border-border/60 p-3">
          <LogPane
            inst={selectedInst}
            logLines={store.logsOf(effectiveSelected)}
            autoScroll={autoScroll}
            onAutoScrollChange={setAutoScroll}
          />
        </section>
      </main>

      {registerOpen && <RegisterDialog open onOpenChange={setRegisterOpen} summary={summary} />}
      {managed && <RunnerOperationDialog inst={managed} summary={summary} onClose={() => setManaged(null)} />}
      <Toaster position="top-center" richColors closeButton />
    </div>
  );
}

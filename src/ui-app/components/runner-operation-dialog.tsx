import { useEffect, useRef, useState } from "react";
import { FolderOpen, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeviceAuthorization } from "@/components/register-dialog";
import { store, type InstanceView, type SummaryPush } from "@/lib/host";

export function RunnerOperationDialog({ inst, summary, onClose }: { inst: InstanceView; summary: SummaryPush | null; onClose: () => void }) {
  const action = inst.unregistered ? "reregister" : "unregister";
  const removing = action === "unregister";
  const [method, setMethod] = useState<"github" | "token">("github");
  const [token, setToken] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const submitting = useRef(false);
  const operation = summary?.runnerOperation?.requestId === requestId ? summary.runnerOperation : null;
  const busy = requestId !== null && (!operation || operation.status === "running");
  const finished = operation?.status === "ok";
  const authorization = busy && operation ? summary?.authorization : null;
  const waiting = authorization?.status === "waiting";
  const current = summary?.instances.find((item) => item.id === inst.id) ?? inst;
  const blocked = Boolean(current.currentJob || current.external || current.processState === "starting" || current.processState === "stopping" || (summary?.task.status === "running" && !busy));
  const title = removing ? "注销 runner" : "重新注册 runner";
  useEffect(() => {
    if (operation && operation.status !== "running") submitting.current = false;
  }, [operation?.status]);
  const submit = () => {
    if (submitting.current || blocked) return;
    submitting.current = true;
    const nextId = crypto.randomUUID();
    setRequestId(nextId);
    store.send({ type: "runner-operation", requestId: nextId, id: inst.id, action, method, token: token.trim() });
    setToken("");
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }} className="flex max-h-[calc(100dvh-24px)] flex-col overflow-hidden sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{finished ? removing ? "已注销，文件已保留" : "已重新注册" : title}</DialogTitle>
        <DialogDescription>{removing ? "从 GitHub 注销并清理本机连接凭据，不删除安装包、工作文件或日志。" : "复用原安装目录和工作目录，重新授权并生成新的连接凭据，不清空工作文件。"}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">
      <dl className="space-y-2 text-sm">
        <div><dt className="text-xs text-muted-foreground">实例</dt><dd className="break-all font-medium">{inst.name}</dd></div>
        <div><dt className="text-xs text-muted-foreground">GitHub 目标</dt><dd className="break-all">{inst.orgUrl}</dd></div>
        <div><dt className="text-xs text-muted-foreground">保留的工作目录</dt><dd className="break-all select-text">{inst.workFolder || "未记录"}</dd></div>
      </dl>
      {!busy && !finished && <>
        <p className="text-sm text-muted-foreground">{removing ? "确认后先授权，再停止 runner 并执行 GitHub 官方注销命令。注销后不能接收作业，可随时重新注册。" : "重新注册完成后保持停止状态，由你决定何时启动。若删除了安装文件，需要重新下载分发包。"}</p>
        {blocked && <p role="alert" className="text-sm text-bad">{current.currentJob ? "请等待当前作业完成后再操作。" : current.external ? "请先停止外部终端或系统服务中的 runner。" : "有任务正在执行或实例正在切换状态，请稍后重试。"}</p>}
        <fieldset className="space-y-3" disabled={blocked}>
          <legend className="mb-2 text-sm font-medium">授权方式</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="runner-auth" checked={method === "github"} onChange={() => setMethod("github")} />手机 / 浏览器重新授权</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="runner-auth" checked={method === "token"} onChange={() => setMethod("token")} />已有{removing ? "注销" : "注册"} Token</label>
          {method === "token" && <><label htmlFor="runner-operation-token" className="block text-xs text-muted-foreground">{removing ? "填写 GitHub Remove runner 页面给出的移除 Token，不是注册 Token 或 PAT。" : "填写 GitHub New self-hosted runner 页面给出的注册 Token，不是 PAT。"}</label><Input id="runner-operation-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></>}
        </fieldset>
      </>}
      {busy && (waiting && authorization?.userCode && authorization.verificationUri && authorization.expiresAt
        ? <DeviceAuthorization code={authorization.userCode} uri={authorization.verificationUri} expiresAt={authorization.expiresAt} />
        : <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />{authorization?.message || operation?.message || "正在开始…"}</p>)}
      {busy && waiting && store.demo && <Button variant="secondary" onClick={() => void import("../demo").then(({ demoHost }) => demoHost.authorize())}>模拟手机已确认（演示）</Button>}
      {operation && operation.status !== "running" && <p role={operation.status === "error" ? "alert" : "status"} className={`text-sm ${operation.status === "error" ? "text-bad" : "text-muted-foreground"}`}>{operation.message}</p>}
      {finished && <p className="text-xs text-muted-foreground">可打开目录手动删除不需要的工作文件。保留安装文件和目录结构，才能直接重新注册。</p>}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button variant="ghost" disabled={!inst.workFolder} onClick={() => store.send({ type: "open-work-dir", id: inst.id })}><FolderOpen className="size-4" />打开工作目录</Button>
        {busy ? <Button variant="outline" disabled={authorization?.status === "registering"} onClick={() => store.send({ type: "cancel-authorization" })}>取消授权</Button> : <>
          <Button variant="outline" onClick={onClose}>{finished ? "完成" : "取消"}</Button>
          {!finished && <Button variant={removing ? "destructive" : "default"} disabled={blocked || (method === "token" && !token.trim())} onClick={submit}>{operation?.status === "error" ? "重试" : removing ? "注销并保留文件" : "授权并重新注册"}</Button>}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}

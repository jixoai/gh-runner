import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, CheckCircle2, Copy, ExternalLink, Loader2, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RunnerPackagePicker } from "./runner-package-picker";
import { store, type SummaryPush } from "@/lib/host";
import { useTicker } from "@/lib/hooks";
import { nextRunner, registrationError, runnerPaths, type RunnerDraft } from "@/lib/registration-form";
import { parseRunnerTarget } from "../../github-target.ts";

export function RegisterDialog({ open, onOpenChange, summary }: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  summary: SummaryPush | null;
}) {
  const id = useId();
  const defaults = summary?.registrationDefaults;
  const [targetUrl, setTargetUrl] = useState(summary?.instances.find((instance) => instance.orgUrl)?.orgUrl ?? "");
  const [root, setRoot] = useState(defaults?.parentDir ?? "");
  const base = defaults?.name ?? "runner";
  const [runners, setRunners] = useState<RunnerDraft[]>(() => [nextRunner(base, summary?.instances.map((instance) => instance.name) ?? [], 1)]);
  const nextKey = useRef(2);
  const [method, setMethod] = useState<"github" | "token">("github");
  const [clientId, setClientId] = useState(defaults?.clientId ?? "");
  const [token, setToken] = useState("");
  const [packagePath, setPackagePath] = useState(() => summary?.download && ["running", "paused", "cancelling"].includes(summary.download.status) ? "" : summary?.packages.find((pkg) => pkg.compatible)?.path ?? "");
  const [labels, setLabels] = useState("");
  const [stage, setStage] = useState<"configure" | "progress">(summary?.task.status === "running" ? "progress" : "configure");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const taskBusy = summary?.task.kind === "register" && summary.task.status === "running";
  const busy = pending || taskBusy;
  const authorization = stage === "progress" && !pending ? summary?.authorization : null;
  const batch = stage === "progress" && !pending && requestId === summary?.registrationBatch?.requestId ? summary.registrationBatch : null;
  const waiting = authorization?.status === "waiting";
  const cancellable = busy && authorization && ["requesting", "waiting", "exchanging"].includes(authorization.status);
  const packages = summary?.packages ?? [];
  const selectedPkg = packages.find((pkg) => pkg.path === packagePath && pkg.compatible)?.path ?? "";
  const download = summary?.download;
  const downloading = download != null && ["running", "paused", "cancelling"].includes(download.status);
  const completed = batch?.items.filter((item) => item.status === "ok").length ?? 0;
  const finished = stage === "progress" && !busy;
  let target: ReturnType<typeof parseRunnerTarget> | null = null;
  try { target = parseRunnerTarget(targetUrl); } catch {}

  useEffect(() => {
    if (pending && requestId === summary?.registrationBatch?.requestId) setPending(false);
  }, [pending, requestId, summary?.registrationBatch?.requestId]);

  useEffect(() => {
    if (defaults) {
      setRoot((current) => current || defaults.parentDir);
      setClientId((current) => current || defaults.clientId);
    }
  }, [defaults?.parentDir, defaults?.clientId]);

  const addRunner = () => {
    setRunners((current) => [...current, nextRunner(base, [...current.map((runner) => runner.name), ...(summary?.instances.map((instance) => instance.name) ?? [])], nextKey.current++)]);
  };
  const updateRunner = (key: number, patch: Partial<RunnerDraft>) => setRunners((current) => current.map((runner) => runner.key === key ? { ...runner, ...patch } : runner));
  const submit = () => {
    const problem = registrationError(targetUrl, root, runners) ||
      (!selectedPkg ? "请先下载适配本机的 runner 分发包，或导入已有分发包" : null) ||
      (method === "github" && !clientId.trim() ? "请填写维护者提供的 GitHub App Client ID，或切换为已有注册 Token" : null) ||
      (method === "token" && !token.trim() ? "请填写 runner 注册 Token" : null);
    if (problem) { setError(problem); return; }
    setError(null);
    const batchId = `${Date.now()}-${nextKey.current++}`;
    setRequestId(batchId);
    setPending(true);
    setStage("progress");
    store.send({
      type: "register-batch", requestId: batchId, method, clientId: clientId.trim(), token: token.trim(),
      targetUrl: target!.url, packagePath: selectedPkg,
      runners: runners.map((runner) => ({ ...runnerPaths(root, runner), name: runner.name.trim(), labels: labels.trim() })),
    });
    setToken("");
  };
  const editFailed = () => {
    const successful = new Set(batch?.items.filter((item) => item.status === "ok").map((item) => item.dir));
    setRunners((current) => current.filter((runner) => !successful.has(runnerPaths(root, runner).dir)));
    setStage("configure");
    setError(null);
  };
  const addAnotherBatch = () => {
    setRunners([nextRunner(base, summary?.instances.map((instance) => instance.name) ?? [], nextKey.current++)]);
    setStage("configure");
    setRequestId(null);
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent showCloseButton={!busy} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }} className="flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="px-6 pt-5 text-left">
          <DialogTitle>{stage === "configure" ? "添加 runner" : finished ? "创建结果" : waiting ? "在手机上确认授权" : "正在创建 runner"}</DialogTitle>
          <DialogDescription>{stage === "configure" ? "同一组织或仓库的多个 runner，只需一次授权。" : "工具不保存账号访问 Token，也不会修改现有 gh 登录。"}</DialogDescription>
        </DialogHeader>
        <ol aria-label="创建步骤" className="mx-6 mt-4 flex gap-4 border-b border-border pb-3 text-xs text-muted-foreground">
          {["配置实例", "授权与创建", "完成"].map((label, index) => <li key={label} aria-current={(stage === "configure" ? 0 : finished ? 2 : 1) === index ? "step" : undefined} className="flex items-center gap-1.5 aria-[current=step]:font-semibold aria-[current=step]:text-foreground"><span className="tabular-nums">{index + 1}</span>{label}</li>)}
        </ol>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {stage === "configure" ? (
            <div className="space-y-6">
              {store.demo && <p className="text-xs text-warn">浏览器演示：不会请求 GitHub 或创建真实 runner。</p>}
              <Field id={`${id}-target`} label="GitHub 组织或仓库" hint="填写完整地址；这一批实例将注册到同一目标。">
                <Input id={`${id}-target`} value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://github.com/你的组织" autoComplete="off" spellCheck={false} />
              </Field>
              <RunnerPackagePicker summary={summary} value={selectedPkg} onValueChange={setPackagePath} />
              <section aria-labelledby={`${id}-instances`}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 id={`${id}-instances`} className="text-sm font-semibold">实例 <span className="ml-1 text-muted-foreground tabular-nums">{runners.length}/10</span></h3>
                  <span className="text-xs text-muted-foreground">名称和目录各自独立</span>
                </div>
                <div className="divide-y divide-border rounded-xl border border-border px-3">
                  {runners.map((runner) => {
                    const paths = runnerPaths(root, runner);
                    return <div key={runner.key} className="py-3">
                      <div className="flex items-end gap-2">
                        <div className="min-w-0 flex-1"><Label htmlFor={`${id}-name-${runner.key}`} className="mb-1.5 block text-xs">实例名称</Label><Input id={`${id}-name-${runner.key}`} value={runner.name} onChange={(event) => updateRunner(runner.key, { name: event.target.value })} spellCheck={false} /></div>
                        <Button variant="ghost" size="icon" disabled={runners.length === 1} aria-label={`移除 ${runner.name || "此 runner"}`} onClick={() => setRunners((current) => current.filter((item) => item.key !== runner.key))}><Trash2 className="size-4" /></Button>
                      </div>
                      <details className="mt-2 text-xs text-muted-foreground">
                        <summary className="cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-ring">目录：<span className="break-all">{paths.dir}</span><span className="ml-2 text-primary">自定义</span></summary>
                        <div className="mt-2 space-y-3 pb-1">
                          <Field id={`${id}-dir-${runner.key}`} label="实例目录（必须为空）"><Input id={`${id}-dir-${runner.key}`} value={runner.dir} placeholder={paths.dir} onChange={(event) => updateRunner(runner.key, { dir: event.target.value })} /></Field>
                          <Field id={`${id}-work-${runner.key}`} label="Work 目录"><Input id={`${id}-work-${runner.key}`} value={runner.workFolder} placeholder={paths.workFolder} onChange={(event) => updateRunner(runner.key, { workFolder: event.target.value })} /></Field>
                          <p>留空时随名称自动生成；不要共用其他实例的目录。</p>
                        </div>
                      </details>
                    </div>;
                  })}
                </div>
                <Button variant="outline" className="mt-3 w-full" onClick={addRunner} disabled={runners.length >= 10}><Plus className="size-4" />添加 runner</Button>
                <details className="mt-3 text-xs text-muted-foreground">
                  <summary className="cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-ring">存放位置与标签</summary>
                  <div className="mt-3 space-y-3">
                    <Field id={`${id}-root`} label="实例存放位置"><Input id={`${id}-root`} value={root} onChange={(event) => setRoot(event.target.value)} /></Field>
                    <Field id={`${id}-labels`} label="附加标签（逗号分隔）" hint="留空使用当前平台的默认标签。"><Input id={`${id}-labels`} value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="例如 build,fast" /></Field>
                  </div>
                </details>
              </section>
              <section aria-labelledby={`${id}-method`}>
                <h3 id={`${id}-method`} className="mb-3 text-sm font-semibold">授权方式</h3>
                <div className="flex flex-wrap gap-x-5 gap-y-3 text-sm">
                  <label className="flex cursor-pointer items-center gap-2"><input type="radio" name={`${id}-method`} checked={method === "github"} onChange={() => { setMethod("github"); setToken(""); }} className="size-4 accent-primary" />手机 / 浏览器授权</label>
                  <label className="flex cursor-pointer items-center gap-2"><input type="radio" name={`${id}-method`} checked={method === "token"} onChange={() => setMethod("token")} className="size-4 accent-primary" />已有注册 Token</label>
                </div>
                {method === "github" ? <div className="mt-3 space-y-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">下一步显示二维码和验证码。手机确认后自动创建全部实例，不需要复制 Token；不保证出现 GitHub App 推送。</p>
                  <details open={!defaults?.clientId} className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-ring">GitHub App 配置{!defaults?.clientId ? " · 尚未预配置" : ""}</summary>
                    <div className="mt-2"><Field id={`${id}-client`} label="GitHub App Client ID" hint="由工具维护者提供，不是 PAT。只用于本次会话。"><Input id={`${id}-client`} value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="例如 Iv23…" autoComplete="off" spellCheck={false} /></Field></div>
                  </details>
                  <p className="text-xs leading-relaxed text-muted-foreground">{target?.kind === "repository" ? "仓库级注册需要 App 的 Administration: write 权限及你的仓库管理权限。" : "组织级注册需要 App 的 Self-hosted runners: write 权限及你的组织管理权限。"}App 需预先安装到目标；GitHub 授权页会显示实际权限，请核对后确认。</p>
                </div> : <div className="mt-3"><Field id={`${id}-token`} label="Runner 注册 Token" hint="从目标的 Actions → Runners → New runner 页面获取，有效期 1 小时；不要填写 PAT。"><div className="flex gap-2"><Input id={`${id}-token`} type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" className="min-w-0 flex-1" /><Button variant="outline" disabled={!target} onClick={() => target && store.send({ type: "open-url", url: target.settingsUrl })}><ExternalLink className="size-4" />获取</Button></div></Field></div>}
              </section>
              <p className="flex items-start gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" />临时凭据仅用于本批注册，不写配置或日志。完成后清理本机凭据；GitHub 上的应用授权仍保留。</p>
            </div>
          ) : (
            <div className="space-y-5">
              {waiting && authorization.userCode && <DeviceAuthorization code={authorization.userCode} uri={authorization.verificationUri!} expiresAt={authorization.expiresAt!} />}
              {waiting && store.demo && <Button variant="secondary" onClick={() => void import("../demo").then(({ demoHost }) => demoHost.authorize())}>模拟手机已确认（演示）</Button>}
              {busy && !waiting && <div role="status" className="flex items-center gap-3 py-3"><Loader2 className="size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none" /><p className="text-sm">{authorization?.message ?? "检查配置，准备创建…"}</p></div>}
              {!busy && summary?.task.status === "error" && <p role="alert" className="break-words text-sm text-bad">{summary.task.message}</p>}
              {finished && completed > 0 && <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" /><div><p className="font-semibold">{completed} 个 runner 已注册</p><p className="mt-1 text-xs text-muted-foreground">可在实例列表查看连接状态、作业和日志。</p></div></div>}
              {finished && !batch && summary?.task.status === "ok" && <p role="status" className="text-sm text-ok">{summary.task.message}</p>}
              {batch && batch.items.length > 0 && <ul className="divide-y divide-border rounded-xl border border-border px-3" aria-label="逐项注册结果">{batch.items.map((item) => <li key={item.dir} className="flex items-start gap-3 py-3">
                {item.status === "ok" ? <Check className="mt-0.5 size-4 shrink-0 text-ok" /> : item.status === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-bad" /> : item.status === "registering" ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" /> : <span className="mt-1 size-3 shrink-0 rounded-full border border-border" />}
                <div className="min-w-0"><p className="break-all text-sm font-medium">{item.name}</p><p className={`mt-1 break-words text-xs ${item.status === "error" ? "text-bad" : "text-muted-foreground"}`}>{item.message}</p></div>
              </li>)}</ul>}
              {finished && batch?.credentialsCleared && <p role="status" className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />本机临时凭据已清理；仅保留已注册 runner 的运行凭据。GitHub 上的应用授权未撤销。</p>}
              {finished && batch?.items.some((item) => item.status === "error") && <p className="text-xs leading-relaxed text-muted-foreground">成功项不会重复创建。失败项如已解包，请换一个空目录后重试；已有 .runner 的目录可直接导入。</p>}
            </div>
          )}
        </div>
        {error && <p role="alert" className="border-t border-border px-6 py-3 text-sm text-bad">{error}</p>}
        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
          {stage === "configure" ? <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
            <Button disabled={downloading || busy || !selectedPkg} onClick={submit}>{method === "github" ? "继续：手机授权" : `创建 ${runners.length} 个 runner`}</Button>
          </> : busy ? <>
            <span className="text-xs text-muted-foreground">{waiting ? "完成授权后自动继续，无需点击下一步" : "创建期间请勿退出应用"}</span>
            {cancellable && <Button variant="outline" onClick={() => store.send({ type: "cancel-authorization" })}>取消授权</Button>}
          </> : <>
            {completed === runners.length ? <Button variant="outline" onClick={addAnotherBatch}><Plus className="size-4" />再添加一批</Button> : <Button variant="outline" onClick={editFailed}><ArrowLeft className="size-4" />{completed ? "编辑失败项" : "返回修改"}</Button>}
            {method === "github" && batch && batch.items.length > 0 && authorization && ["error", "cancelled"].includes(authorization.status) ? <Button onClick={submit}>重新授权</Button> : <Button onClick={() => onOpenChange(false)}>完成</Button>}
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return <div className="grid gap-1.5"><Label htmlFor={id} className="text-xs">{label}</Label>{children}{hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>;
}

export function DeviceAuthorization({ code, uri, expiresAt }: { code: string; uri: string; expiresAt: number }) {
  const tick = useTicker();
  const [image, setImage] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    let active = true;
    void import("qrcode").then((qr) => qr.toDataURL(uri, { width: 160, margin: 2, errorCorrectionLevel: "M" })).then((url) => { if (active) setImage(url); }).catch(() => {});
    return () => { active = false; };
  }, [uri]);
  const seconds = Math.max(0, Math.ceil((expiresAt - tick * 1000) / 1000));
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  };
  return <section aria-label="GitHub 设备授权" className="space-y-4">
    <div className="flex flex-wrap items-center gap-5">
      {image && <img src={image} width={144} height={144} alt="扫码打开 GitHub 官方设备授权页面" className="rounded-lg bg-white" />}
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">手机扫码，输入以下验证码</p><p className="mt-1 break-all text-xs text-muted-foreground">github.com/login/device</p><div className="mt-3 flex flex-wrap items-center gap-2"><code className="select-all rounded-md bg-muted px-3 py-2 font-mono text-2xl font-semibold tracking-wider tabular-nums">{code}</code><Button variant="ghost" size="icon" aria-label={copied ? "验证码已复制" : "复制验证码"} onClick={() => void copy()}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div>{copyError && <p role="status" className="mt-1 text-xs text-muted-foreground">无法访问剪贴板，请手动选中并复制验证码。</p>}</div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3"><Button variant="outline" onClick={() => store.send({ type: "open-url", url: uri })}><ExternalLink className="size-4" />在这台电脑打开</Button><span className="text-xs text-muted-foreground tabular-nums">{seconds > 0 ? `验证码剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "验证码已过期，请重新发起"}</span></div>
    <p className="text-xs leading-relaxed text-muted-foreground">仅确认自己刚刚发起的授权。二维码只打开 GitHub 官方网页，不包含访问 Token；请核对页面上的应用名称和权限。</p>
    <p className="text-xs leading-relaxed text-muted-foreground">手机确认不会登录本机浏览器。如果选择在本机浏览器登录 GitHub，浏览器可能保留登录状态，需要自行退出。</p>
  </section>;
}

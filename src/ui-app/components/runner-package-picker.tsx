import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Download, FolderInput, Loader2, Pause, Play, Square } from "lucide-react";
import { Tabs } from "radix-ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Progress } from "./ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./ui/select";
import { store, type SummaryPush } from "../lib/host";
import { downloadTemplateError } from "../../download-source.ts";
import { RUNNER_TARGETS, recommendedRunnerTarget, resolvePackageSelection, type RunnerPackageTarget } from "../../runner-package.ts";

type PackageSummary = Pick<SummaryPush, "packages" | "platform" | "arch" | "download">;
const tabStyle = "flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm";

export function RunnerPackagePicker({ summary, value, onValueChange }: {
  summary: PackageSummary | null;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const id = useId();
  const packages = summary?.packages ?? [];
  const download = summary?.download;
  const downloading = download != null && ["running", "paused", "cancelling"].includes(download.status);
  const [mode, setMode] = useState(downloading || !value ? "download" : "local");
  const [target, setTarget] = useState<RunnerPackageTarget | "auto">("auto");
  const [versionMode, setVersionMode] = useState("latest");
  const [version, setVersion] = useState("");
  const [source, setSource] = useState("github");
  const [sourceTemplate, setSourceTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seenPaths = useRef(new Set(packages.map((pkg) => pkg.path)));
  const completedPath = useRef<string | null>(null);
  const selected = packages.find((pkg) => pkg.path === value && pkg.compatible);
  const recommended = recommendedRunnerTarget(summary?.platform ?? "", summary?.arch ?? "");
  const effectiveTarget = target === "auto" ? recommended : target;
  const targetLabel = RUNNER_TARGETS.find((entry) => entry.id === effectiveTarget)?.label;
  const deviceLabel = RUNNER_TARGETS.find((entry) => entry.id === recommended)?.label ?? `${summary?.platform ?? "未知系统"} / ${summary?.arch ?? "未知架构"}`;
  const foreign = effectiveTarget != null && effectiveTarget !== recommended;
  const downloaded = download?.status === "ok" ? packages.find((pkg) => pkg.path === download.packagePath) : undefined;
  const selectedVersion = selected?.name.match(/-(\d+\.\d+\.\d+)\./)?.[1];

  useEffect(() => {
    const added = packages.find((pkg) => pkg.compatible && !seenPaths.current.has(pkg.path));
    seenPaths.current = new Set(packages.map((pkg) => pkg.path));
    if (mode === "local" && added) onValueChange(added.path);
  }, [packages, mode, onValueChange]);

  useEffect(() => {
    if (!downloaded || completedPath.current === downloaded.path) return;
    completedPath.current = downloaded.path;
    if (downloaded.compatible) onValueChange(downloaded.path);
  }, [downloaded, onValueChange]);

  const changeOption = () => { setError(null); onValueChange(""); };
  const changeMode = (next: string) => {
    setMode(next);
    setError(null);
    onValueChange(next === "local" ? packages.find((pkg) => pkg.compatible)?.path ?? "" : "");
  };
  const startDownload = () => {
    try {
      const template = source === "mirror" ? sourceTemplate.trim() : "";
      const problem = source === "mirror" && !template ? "请填写加速服务的 HTTPS 地址模板" : downloadTemplateError(template);
      if (problem) throw new Error(problem);
      const selection = resolvePackageSelection({ target: effectiveTarget, version: versionMode === "latest" ? "latest" : version }, recommended);
      setError(null);
      completedPath.current = null;
      onValueChange("");
      store.send({ type: "download-latest", sourceTemplate: template, selection });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  return <section aria-labelledby={`${id}-title`} className="space-y-3">
    <div>
      <h3 id={`${id}-title`} className="text-sm font-semibold">Runner 安装包</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">准备一次安装包，供本批全部 runner 使用。</p>
    </div>
    <Tabs.Root value={mode} onValueChange={changeMode}>
      <Tabs.List aria-label="安装包来源" className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        <Tabs.Trigger value="download" disabled={downloading} className={tabStyle}><Download className="size-4" />在线下载</Tabs.Trigger>
        <Tabs.Trigger value="local" disabled={downloading} className={tabStyle}><FolderInput className="size-4" />本地安装包</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="download" className="mt-4 space-y-4 outline-none">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            {selected && !downloading ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" /> : <Download className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0">
              <p className="text-sm font-medium">{selected && !downloading ? "安装包已就绪" : targetLabel ?? "选择下载平台"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{selected && !downloading ? `v${selectedVersion ?? "未知版本"} · 已选用于本批 runner` : `${versionMode === "latest" ? "最新稳定版" : `版本 ${version.trim() || "待填写"}`} · ${source === "github" ? "GitHub 官方" : "自定义加速源"}`}</p>
            </div>
          </div>
          {!downloading && <Button variant="outline" size="sm" className="shrink-0" disabled={!effectiveTarget} onClick={startDownload}><Download className="size-4" />{selected ? "重新下载" : download?.status === "error" ? "重试下载" : foreign ? "仅下载安装包" : "下载并使用"}</Button>}
        </div>
        <details className="text-xs" open={!recommended || undefined}>
          <summary className="w-fit cursor-pointer rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">下载选项{target !== "auto" || versionMode !== "latest" || source !== "github" ? " · 已自定义" : ""}</summary>
          <fieldset disabled={downloading} className="mt-3 grid min-w-0 gap-3 border-t border-border pt-3">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`${id}-target`} className="text-xs">操作系统与架构</Label>
              <Select value={target} onValueChange={(next) => { setTarget(next as RunnerPackageTarget | "auto"); changeOption(); }} disabled={downloading}>
                <SelectTrigger id={`${id}-target`} aria-label="下载平台与架构" className="w-full min-w-0"><span className="truncate">{target === "auto" ? `自动适配 · ${deviceLabel}` : targetLabel}</span></SelectTrigger>
                <SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]"><SelectItem value="auto">自动适配当前设备（推荐）</SelectItem>{RUNNER_TARGETS.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}{entry.id === recommended ? " · 本机" : ""}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor={`${id}-version-mode`} className="text-xs">版本</Label>
                <Select value={versionMode} onValueChange={(next) => { setVersionMode(next); changeOption(); }} disabled={downloading}>
                  <SelectTrigger id={`${id}-version-mode`} aria-label="下载版本" className="w-full"><span>{versionMode === "latest" ? "最新稳定版（推荐）" : "指定版本"}</span></SelectTrigger>
                  <SelectContent position="popper" align="start"><SelectItem value="latest">最新稳定版（推荐）</SelectItem><SelectItem value="custom">指定版本</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor={`${id}-source`} className="text-xs">下载源</Label>
                <Select value={source} onValueChange={(next) => { setSource(next); changeOption(); }} disabled={downloading}>
                  <SelectTrigger id={`${id}-source`} aria-label="下载源" className="w-full"><span>{source === "github" ? "GitHub 官方" : "自定义加速源"}</span></SelectTrigger>
                  <SelectContent position="popper" align="start"><SelectItem value="github">GitHub 官方</SelectItem><SelectItem value="mirror">自定义加速源</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            {versionMode === "custom" && <div className="grid gap-1.5"><Label htmlFor={`${id}-version`} className="text-xs">版本号</Label><Input id={`${id}-version`} value={version} onChange={(event) => { setVersion(event.target.value); changeOption(); }} placeholder="例如 2.338.2 或 v2.338.2" spellCheck={false} autoComplete="off" /><p className="leading-relaxed text-muted-foreground">指定初始安装版本，不会禁用 runner 的自动更新。</p></div>}
            {source === "mirror" && <div className="grid gap-1.5"><Label htmlFor={`${id}-template`} className="text-xs">加速地址模板</Label><Input id={`${id}-template`} value={sourceTemplate} onChange={(event) => { setSourceTemplate(event.target.value); changeOption(); }} placeholder="https://你的加速服务/{url}" autoComplete="off" spellCheck={false} /><p className="leading-relaxed text-muted-foreground">仅使用你信任的 HTTPS 服务，支持 {"{url}"}、{"{version}"} 和 {"{asset}"}。使用 GitHub 官方 SHA-256 校验，不发送授权凭据。</p></div>}
          </fieldset>
        </details>
        {foreign && <p role="status" className="text-xs leading-relaxed text-warn">所选平台与本机不匹配。可以下载留存，但不能用于创建本机 runner。</p>}
        {!effectiveTarget && <p role="status" className="text-xs text-warn">暂时无法自动适配，请在下载选项中选择平台。</p>}
        {(error || download?.status === "error") && <p role="alert" className="break-words text-xs leading-relaxed text-bad">{error ?? download?.message}</p>}
        {downloading ? <div className="space-y-3" aria-label="安装包下载状态">
          <div role="status" className="flex items-center justify-between text-xs"><span>{download.status === "paused" ? "下载已暂停" : download.status === "cancelling" ? "正在取消下载…" : "正在下载安装包…"}</span><span className="tabular-nums">{download.pct}%</span></div>
          <Progress value={download.pct} aria-label="安装包下载进度" />
          <div className="flex flex-wrap gap-2">
            {download.status === "running" && <Button variant="outline" size="sm" onClick={() => store.send({ type: "pause-download" })}><Pause className="size-4" />暂停</Button>}
            {download.status === "paused" && <Button variant="outline" size="sm" onClick={() => store.send({ type: "resume-download" })}><Play className="size-4" />继续下载</Button>}
            <Button variant="ghost" size="sm" disabled={download.status === "cancelling"} onClick={() => store.send({ type: "cancel-download" })}>{download.status === "cancelling" ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}取消下载</Button>
          </div>
          <p className="text-xs text-muted-foreground">关闭此窗口仍会下载；退出应用会取消并清理未完成文件。</p>
        </div> : <>
          {download?.status === "cancelled" && <p role="status" className="text-xs text-muted-foreground">下载已取消，可重新开始。</p>}
          {downloaded && !downloaded.compatible && <p role="status" className="break-all text-xs text-muted-foreground">已保存 {downloaded.name}。请切回本机平台下载，或选择本地适配包。</p>}
        </>}
        {(selected || download) && <details className="text-xs text-muted-foreground"><summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline-2 focus-visible:outline-ring">文件与连接详情</summary><div className="mt-2 space-y-1.5 break-all leading-relaxed">{selected && <p>{selected.name}</p>}{download && <p>{download.message}</p>}{download?.network && <p>连接：{download.network}</p>}{download?.source && <p>下载源：{download.source}</p>}</div></details>}
      </Tabs.Content>
      <Tabs.Content value="local" className="mt-4 space-y-3 outline-none">
        {packages.length > 0 ? <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${id}-local`} className="text-xs">选择已有安装包</Label>
          <Select value={value} onValueChange={onValueChange}>
            <SelectTrigger id={`${id}-local`} aria-label="本地安装包" className="w-full min-w-0"><span className="truncate">{selected ? `v${selectedVersion ?? "未知版本"} · ${deviceLabel}` : "选择适配当前设备的安装包"}</span></SelectTrigger>
            <SelectContent position="popper" align="start" className="max-w-[calc(100vw-2rem)]">{packages.map((pkg) => <SelectItem key={pkg.path} value={pkg.path} disabled={!pkg.compatible} className="break-all">{pkg.name}{pkg.compatible ? "" : " · 不适配本机"}</SelectItem>)}</SelectContent>
          </Select>
          {selected ? <><p className="break-all text-xs leading-relaxed text-muted-foreground">{selected.name}</p><p role="status" className="mt-1 flex items-center gap-1.5 text-xs text-ok"><CheckCircle2 className="size-3.5" />已就绪，无需重新下载</p></> : <p className="text-xs leading-relaxed text-muted-foreground">列表中的其他平台包不可用于本机。请选择适配包，或从电脑导入。</p>}
        </div> : <div><p className="text-sm">还没有本地安装包</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">导入已下载的 .tar.gz 或 .zip 文件，也可以切换到在线下载。</p></div>}
        <Button variant="outline" size="sm" onClick={() => store.send({ type: "import-package" })}><FolderInput className="size-4" />从电脑导入…</Button>
      </Tabs.Content>
    </Tabs.Root>
  </section>;
}

import { useEffect, useState } from "react";
import { Download, ExternalLink, FolderInput, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { store, type PackageInfo, type SummaryPush } from "@/lib/host";

const RUNNER_NEW_URL = "https://github.com/organizations/jixoai/settings/actions/runners/new";

const INITIAL = { dir: "", name: "", token: "", labels: "self-hosted,macOS,ARM64", orgUrl: "https://github.com/jixoai", workFolder: "", packagePath: "" };

export function RegisterDialog({
  open,
  onOpenChange,
  summary,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  summary: SummaryPush | null;
}) {
  const [form, setForm] = useState(INITIAL);
  const [labelsTouched, setLabelsTouched] = useState(false);
  const [placeholder, setPlaceholder] = useState({ dir: "/Volumes/bnqkl/Users/kzf/actions-runner-5", work: "/Volumes/bnqkl/Users/kzf/gh-runner-work-5" });
  const set = (k: keyof typeof INITIAL) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  // 平台默认值：仅在用户未触碰 labels 时按平台注入
  useEffect(() => {
    if (!summary || summary.platform !== "win32") return;
    setPlaceholder({ dir: "C:\\actions-runner-5", work: "C:\\gh-runner-work-5" });
    if (!labelsTouched) setForm((f) => ({ ...f, labels: `self-hosted,Windows,${summary.arch === "arm64" ? "ARM64" : "X64"}` }));
  }, [summary?.platform, summary?.arch, labelsTouched]);

  const busy = summary?.task.status === "running" && summary.task.kind === "register";
  const download = summary?.download ?? null;
  const downloading = download?.status === "running";
  const packages: PackageInfo[] = summary?.packages ?? [];
  const selectedPkg = form.packagePath || packages.find((p) => p.compatible)?.path || "";

  // 目录已含 .runner = attach（免 Token/名称/Work）；否则全新注册（全部必填）
  const looksAttach = form.dir.trim().length > 0;
  const valid =
    form.dir.trim().length > 0 &&
    (looksAttach ? true : form.name.trim().length > 0 && form.token.trim().length > 0 && form.workFolder.trim().length > 0);
  const submit = () => {
    if (!valid) return;
    store.send({
      type: "register",
      dir: form.dir.trim(),
      name: form.name.trim(),
      token: form.token.trim(),
      labels: form.labels.trim(),
      orgUrl: form.orgUrl.trim() || "https://github.com/jixoai",
      workFolder: form.workFolder.trim(),
      packagePath: selectedPkg,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-20px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="px-5 pt-4">
          <DialogTitle>注册新 runner 实例</DialogTitle>
          <DialogDescription>
            表单配置后即注册并自动启动；分发包可下载最新或从本地导入。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-3.5">
          <Field label="实例目录（空目录=全新注册；已含 .runner 的目录=接入管理）">
            <Input value={form.dir} onChange={(e) => set("dir")(e.target.value)} placeholder={placeholder.dir} />
          </Field>
          <Field label={looksAttach ? "实例名称（接入时忽略，读自 .runner）" : "实例名称"}>
            <Input value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="mac-ext-05" />
          </Field>
          <Field label="注册 Token（org 设置页生成，一次性）">
            <div className="flex items-center gap-2">
              <Input
                type="password"
                value={form.token}
                onChange={(e) => set("token")(e.target.value)}
                placeholder="粘贴一次性注册 Token"
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 gap-1.5 text-xs"
                onClick={() => store.send({ type: "open-url", url: RUNNER_NEW_URL })}
              >
                <ExternalLink className="size-3.5" /> 获取 Token
              </Button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Labels">
              <Input
                value={form.labels}
                onChange={(e) => {
                  setLabelsTouched(true);
                  set("labels")(e.target.value);
                }}
              />
            </Field>
            <Field label="GitHub Org URL">
              <Input value={form.orgUrl} onChange={(e) => set("orgUrl")(e.target.value)} />
            </Field>
          </div>
          <Field label="Work 目录（必填，独立于其它实例，避免缓存互踩）">
            <Input value={form.workFolder} onChange={(e) => set("workFolder")(e.target.value)} placeholder={placeholder.work} />
          </Field>
          <Field label="分发包（解包并注册；可下载最新或导入本地包）">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Select value={selectedPkg} onValueChange={set("packagePath")}>
                  <SelectTrigger className="w-full min-w-0" title={selectedPkg}>
                    <span className="truncate">
                      {selectedPkg
                        ? packages.find((p) => p.path === selectedPkg)?.name ?? selectedPkg
                        : packages.length === 0
                          ? "暂无包：先下载或导入"
                          : "选择分发包"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {packages.map((pkg) => (
                      <SelectItem key={pkg.path} value={pkg.path} disabled={!pkg.compatible}>
                        {pkg.name}（{Math.max(1, Math.round(pkg.sizeBytes / (1 << 20)))} MB）
                        {pkg.compatible ? "" : " · 不兼容"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 gap-1.5 text-xs"
                disabled={downloading}
                title="从 actions/runner 官方 release 下载当前平台最新包"
                onClick={() => store.send({ type: "download-latest" })}
              >
                {downloading ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} 下载最新
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 gap-1.5 text-xs"
                disabled={downloading}
                title="选择本地包文件（tar.gz / zip）"
                onClick={() => store.send({ type: "import-package" })}
              >
                <FolderInput className="size-3.5" /> 导入…
              </Button>
            </div>
            {download && (
              <div className="mt-1.5">
                <Progress
                  value={download.status === "running" ? download.pct : download.status === "ok" ? 100 : 0}
                  className={download.status === "error" ? "opacity-40" : ""}
                />
                <p
                  className={
                    "mt-1 text-xs font-medium " +
                    (download.status === "ok"
                      ? "text-ok"
                      : download.status === "error"
                        ? "text-bad"
                        : "text-foreground")
                  }
                >
                  {download.status === "running" ? `下载中 ${download.pct}% — ${download.message}` : download.message}
                </p>
              </div>
            )}
          </Field>
        </div>

        <DialogFooter className="border-t border-border/60 px-5 py-3.5">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || downloading || !valid}
            title={valid ? "" : "全新注册需填：目录 / 名称 / Token / Work 目录"}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {busy ? "注册中…" : "注册并启动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

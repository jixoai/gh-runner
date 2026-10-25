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

  const submit = () => {
    if (!form.dir.trim() || !form.name.trim() || !form.token.trim() || !form.workFolder.trim()) return;
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
            表单配置后即注册并自动启动；分发包可下载最新或导入本地。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
          <Field label="实例目录（必须为空目录）">
            <Input value={form.dir} onChange={(e) => set("dir")(e.target.value)} placeholder={placeholder.dir} />
          </Field>
          <Field label="实例名称">
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
                size="sm"
                className="h-8 shrink-0 gap-1.5 text-xs"
                onClick={() => store.send({ type: "open-url", url: RUNNER_NEW_URL })}
              >
                <ExternalLink className="size-3" /> 获取
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
            <Field label="GitHub org URL">
              <Input value={form.orgUrl} onChange={(e) => set("orgUrl")(e.target.value)} />
            </Field>
          </div>
          <Field label="Work 目录（必填，独立于其它实例，避免缓存互踩）">
            <Input value={form.workFolder} onChange={(e) => set("workFolder")(e.target.value)} placeholder={placeholder.work} />
          </Field>
          <Field label="分发包（解包并注册）">
            <div className="flex items-center gap-2">
              <Select value={selectedPkg} onValueChange={set("packagePath")}>
                <SelectTrigger className="min-w-0 flex-1">
                  <SelectValue placeholder={packages.length === 0 ? "暂无包" : "选择分发包"} />
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
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5 text-xs"
                disabled={downloading}
                onClick={() => store.send({ type: "download-latest" })}
              >
                {downloading ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />} 最新
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1.5 text-xs"
                disabled={downloading}
                onClick={() => store.send({ type: "import-package" })}
              >
                <FolderInput className="size-3" /> 导入…
              </Button>
            </div>
            {download && (
              <div className="mt-2">
                <Progress
                  value={download.status === "running" ? download.pct : download.status === "ok" ? 100 : 0}
                  className={download.status === "error" ? "opacity-40" : ""}
                />
                <p
                  className={
                    "mt-1 text-[11px] " +
                    (download.status === "ok"
                      ? "text-ok"
                      : download.status === "error"
                        ? "text-bad"
                        : "text-muted-foreground")
                  }
                >
                  {download.message}
                </p>
              </div>
            )}
          </Field>
        </div>

        <DialogFooter className="border-t border-border/60 px-5 py-3.5">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
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

import { setTimeout as delay } from "node:timers/promises";
import { parseRunnerTarget } from "./github-target.ts";

declare const __GITHUB_APP_CLIENT_ID__: string;

export function githubClientId(): string {
  return process.env.GH_RUNNER_GITHUB_CLIENT_ID?.trim() ||
    (typeof __GITHUB_APP_CLIENT_ID__ === "string" ? __GITHUB_APP_CLIENT_ID__.trim() : "") ||
    "Iv23liwxZ2AQwKPeyeYF";
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

interface AuthorizationOptions {
  clientId: string;
  targetUrl: string;
  signal: AbortSignal;
  onCode: (code: DeviceCode) => void;
  onAuthorized: () => void;
  count: number;
  purpose?: "register" | "remove";
}

type Json = Record<string, unknown>;

async function readJson(response: Response): Promise<Json> {
  try {
    const data: unknown = await response.json();
    if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Json;
  } catch {}
  throw new Error("GitHub 返回了无法识别的响应，请稍后重试");
}

export async function authorizeRunners(
  options: AuthorizationOptions,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const { clientId, signal, onCode, onAuthorized } = options;
  const target = parseRunnerTarget(options.targetUrl);
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 10) throw new Error("每批可创建 1–10 个 runner");
  const removing = options.purpose === "remove";
  if (!clientId.trim()) throw new Error("尚未配置 GitHub App Client ID，请联系应用维护者或使用手动 Token");
  const post = (path: string, values: Record<string, string>, activeSignal = signal) => request(`https://github.com${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.any([activeSignal, AbortSignal.timeout(20_000)]),
    redirect: "error",
  });
  const codeResponse = await post("/login/device/code", { client_id: clientId });
  const code = await readJson(codeResponse);
  if (!codeResponse.ok || code.error) {
    throw new Error("无法发起 GitHub 授权，请检查 Client ID，并在 GitHub App 设置中启用 Device Flow");
  }
  if (
    typeof code.device_code !== "string" || !code.device_code ||
    typeof code.user_code !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.user_code) ||
    code.verification_uri !== "https://github.com/login/device" ||
    typeof code.expires_in !== "number" || code.expires_in <= 0 || code.expires_in > 3600 ||
    typeof code.interval !== "number" || code.interval < 1 || code.interval > 60
  ) {
    throw new Error("GitHub 设备授权响应无效，请重新发起授权");
  }
  const expiresAt = Date.now() + code.expires_in * 1000;
  const pollingSignal = AbortSignal.any([signal, AbortSignal.timeout(code.expires_in * 1000)]);
  onCode({ userCode: code.user_code, verificationUri: code.verification_uri, expiresAt });
  let interval = code.interval;
  let accessToken = "";
  const tokens: string[] = [];
  try {
    while (!accessToken) {
      await delay(interval * 1000, undefined, { signal: pollingSignal });
      const response = await post("/login/oauth/access_token", {
        client_id: clientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }, pollingSignal);
      const result = await readJson(response);
      if (result.error === "authorization_pending") continue;
      if (result.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (result.error === "access_denied") throw new Error("你已拒绝授权；未创建新 runner，可以重新尝试");
      if (result.error === "expired_token") throw new Error("验证码已过期，请重新发起授权");
      if (!response.ok || result.error || typeof result.access_token !== "string" || !result.access_token) {
        throw new Error("GitHub 授权失败，请检查应用配置后重试");
      }
      accessToken = result.access_token;
      result.access_token = "";
      result.refresh_token = "";
    }
    signal.throwIfAborted();
    onAuthorized();
    for (let index = 0; index < options.count; index += 1) {
      const apiPath = removing ? target.apiPath.replace(/registration-token$/, "remove-token") : target.apiPath;
      const response = await request(`https://api.github.com${apiPath}`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        redirect: "error",
      });
      const registration = await readJson(response);
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
          throw new Error(target.kind === "organization"
            ? "无法管理该组织的 runner：请确认你是组织管理员，GitHub App 已安装到该组织并获授 Self-hosted runners: write；如有 SSO，请先完成组织授权"
            : "无法管理该仓库的 runner：请确认你有仓库管理权限，GitHub App 已获授该仓库的 Administration: write；如有 SSO，请先完成组织授权");
        }
        throw new Error(`申请 runner ${removing ? "注销" : "注册"} Token 失败（HTTP ${response.status}），请稍后重试`);
      }
      if (typeof registration.token !== "string" || !registration.token) {
        throw new Error(`GitHub 未返回 runner ${removing ? "注销" : "注册"} Token，请重试`);
      }
      tokens.push(registration.token);
      registration.token = "";
    }
    signal.throwIfAborted();
    return tokens;
  } catch (error) {
    tokens.fill("");
    if (signal.aborted) throw new Error("授权已取消，本机临时凭据已清理");
    if (Date.now() >= expiresAt) throw new Error("验证码已过期，请重新发起授权");
    throw error;
  } finally {
    accessToken = "";
    code.device_code = "";
    code.user_code = "";
  }
}

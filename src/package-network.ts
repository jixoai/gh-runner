import { execFile } from "node:child_process";
import { BlockList, isIP } from "node:net";
import { promisify } from "node:util";
import { Agent, ProxyAgent } from "undici";

const execute = promisify(execFile);

export interface SystemProxy {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  excludeSimpleHosts?: boolean;
  unsupported?: boolean;
}

export interface PackageProxy extends SystemProxy {
  description: string;
}

function systemAddress(host: string | undefined, port: string | undefined): string {
  if (!host || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || /[\s/@?#]/.test(host)) {
    throw new Error("系统代理地址无效，请检查系统网络设置");
  }
  return `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function parseMacProxy(text: string): SystemProxy {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(text)?.[1]?.trim();
  const exceptions = /ExceptionsList\s*:\s*<array>\s*{([^}]+)}/.exec(text)?.[1] ?? "";
  return {
    httpProxy: value("HTTPEnable") === "1" ? systemAddress(value("HTTPProxy"), value("HTTPPort")) : undefined,
    httpsProxy: value("HTTPSEnable") === "1" ? systemAddress(value("HTTPSProxy"), value("HTTPSPort")) : undefined,
    noProxy: [...exceptions.matchAll(/^\s*\d+\s*:\s*(.+)$/gm)].map((match) => match[1]!.trim()).join(","),
    excludeSimpleHosts: value("ExcludeSimpleHostnames") === "1",
    unsupported: value("ProxyAutoConfigEnable") === "1" || value("ProxyAutoDiscoveryEnable") === "1" || (value("SOCKSEnable") === "1" && value("HTTPEnable") !== "1" && value("HTTPSEnable") !== "1"),
  };
}

export function parseWindowsProxy(text: string): SystemProxy {
  const value = (key: string) => new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.+)$`, "mi").exec(text)?.[1]?.trim();
  const enabled = /^(0x)?0*1$/i.test(value("ProxyEnable") ?? "");
  const server = enabled ? value("ProxyServer") ?? "" : "";
  const address = (entry: string | undefined) => entry ? (/^https?:\/\//i.test(entry) ? entry : `http://${entry}`) : undefined;
  const protocols = Object.fromEntries(server.split(";").filter((entry) => entry.includes("=")).map((entry) => entry.split("=").map((part) => part.trim())));
  const common = server && !server.includes("=") ? address(server) : undefined;
  const bypass = (value("ProxyOverride") ?? "").split(";").map((entry) => entry.trim());
  return {
    httpProxy: common ?? address(protocols.http),
    httpsProxy: common ?? address(protocols.https),
    noProxy: bypass.filter((entry) => entry !== "<local>").join(","),
    excludeSimpleHosts: bypass.includes("<local>"),
    unsupported: Boolean(value("AutoConfigURL")) || Boolean(protocols.socks && !protocols.http && !protocols.https),
  };
}

async function systemProxy(signal?: AbortSignal): Promise<SystemProxy> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/sbin/scutil", ["--proxy"], { signal, timeout: 3000, maxBuffer: 128 * 1024 });
      return parseMacProxy(stdout);
    }
    if (process.platform === "win32") {
      const { stdout } = await execute("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { signal, timeout: 3000, maxBuffer: 128 * 1024 });
      return parseWindowsProxy(stdout);
    }
    return {};
  } catch (error) {
    signal?.throwIfAborted();
    if (process.platform === "win32" && (error as { code?: number }).code === 1) return {};
    throw new Error("无法读取系统代理，请设置 HTTPS_PROXY / HTTP_PROXY，或用 GH_RUNNER_PROXY=direct 明确选择直连");
  }
}

function checkedProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error("代理地址无效或协议不支持；请使用 http:// 或 https:// 代理地址（SOCKS / PAC 请改用客户端的 HTTP 或混合端口）");
  }
}

export async function resolvePackageProxy(
  env: NodeJS.ProcessEnv = process.env,
  readSystem: () => Promise<SystemProxy> = () => systemProxy(),
): Promise<PackageProxy> {
  const override = env.GH_RUNNER_PROXY?.trim();
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  if (override === "direct") return { description: "直连（GH_RUNNER_PROXY=direct）" };
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  const all = env.all_proxy ?? env.ALL_PROXY;
  let settings: SystemProxy;
  let source: string;
  if (override || http !== undefined || https !== undefined || all !== undefined) {
    const httpProxy = override ?? http ?? all;
    settings = { httpProxy, httpsProxy: override ?? https ?? all ?? httpProxy, noProxy };
    source = override ? "指定代理" : "环境变量代理";
  } else {
    settings = await readSystem();
    if (settings.unsupported) throw new Error("系统使用 PAC / 自动发现或仅 SOCKS 代理；请用 HTTPS_PROXY 指定代理客户端的 HTTP 或混合端口");
    settings.noProxy = noProxy ?? settings.noProxy;
    source = "系统代理";
  }
  settings.httpProxy = checkedProxy(settings.httpProxy);
  settings.httpsProxy = checkedProxy(settings.httpsProxy);
  const endpoint = (proxy: string | undefined) => proxy ? new URL(proxy).host : "直连";
  const description = settings.httpProxy || settings.httpsProxy
    ? `${source} · HTTPS ${endpoint(settings.httpsProxy)} · HTTP ${endpoint(settings.httpProxy)}${settings.noProxy || settings.excludeSimpleHosts ? "（遵循代理绕过规则）" : ""}`
    : "直连（未配置 HTTP / HTTPS 代理）";
  return { ...settings, description };
}

export function bypassPackageProxy(url: URL, settings: SystemProxy): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (settings.excludeSimpleHosts && !hostname.includes(".") && !isIP(hostname)) return true;
  return (settings.noProxy ?? "").split(/[,;\s]+/).some((entry) => {
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry.includes("/")) {
      const [network, prefix] = entry.split("/");
      const family = isIP(network!);
      if (!family || !isIP(hostname) || !/^\d+$/.test(prefix ?? "")) return false;
      try {
        const block = new BlockList();
        block.addSubnet(network!, Number(prefix), family === 6 ? "ipv6" : "ipv4");
        return block.check(hostname, isIP(hostname) === 6 ? "ipv6" : "ipv4");
      } catch { return false; }
    }
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match) return hostname === entry.toLowerCase();
    if (match[2] && match[2] !== port) return false;
    const host = match[1]!.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (host.includes("*")) {
      const expression = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp(`^${expression}$`).test(hostname);
    }
    const domain = host.replace(/^\./, "");
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

export interface PackageTransport {
  description: string;
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export async function createPackageTransport(signal?: AbortSignal): Promise<PackageTransport> {
  const settings = await resolvePackageProxy(process.env, () => systemProxy(signal));
  signal?.throwIfAborted();
  return packageTransport(settings);
}

export function packageTransport(settings: PackageProxy): PackageTransport {
  const direct = new Agent({ connect: { timeout: 30_000 } });
  const agents = new Map<string, ProxyAgent>();
  const proxyFor = (address: string | undefined) => {
    if (!address) return direct;
    if (!agents.has(address)) agents.set(address, new ProxyAgent({ uri: address, connect: { timeout: 30_000 } }));
    return agents.get(address)!;
  };
  const dispatcher = direct.compose(() => (options, handler) => {
    const url = new URL(String(options.origin));
    const address = url.protocol === "https:" ? settings.httpsProxy : settings.httpProxy;
    return (bypassPackageProxy(url, settings) ? direct : proxyFor(address)).dispatch(options, handler);
  });
  return {
    description: settings.description,
    fetch: async (input, init) => {
      try {
        return await globalThis.fetch(input, { ...init, dispatcher } as RequestInit);
      } catch (error) {
        init?.signal?.throwIfAborted();
        throw new Error("下载网络请求失败，请检查网络和代理设置后重试", { cause: error });
      }
    },
    close: async () => { await Promise.all([direct.destroy(), ...[...agents.values()].map((agent) => agent.destroy())]); },
  };
}

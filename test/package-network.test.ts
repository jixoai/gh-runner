import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { bypassPackageProxy, packageTransport, parseMacProxy, parseWindowsProxy, resolvePackageProxy, type PackageTransport } from "../src/package-network.ts";
import { fetchLatestReleaseInfo, downloadPackage } from "../src/packages.ts";
import { assetNameFor } from "../src/platform.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/config.ts", async (original) => ({
  ...await original<typeof import("../src/config.ts")>(), configDir: () => isolated.root,
}));

const servers: Server[] = [];
const sockets = new Set<Socket>();
const transports: PackageTransport[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function transport(settings: Awaited<ReturnType<typeof resolvePackageProxy>>) {
  const value = packageTransport(settings);
  transports.push(value);
  return value;
}

async function proxy(targetPort?: number) {
  const requests: string[] = [];
  const server = createServer();
  server.on("connect", (request, client, head) => {
    requests.push(request.url!);
    if (!targetPort) return;
    const upstream = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, requests };
}

afterEach(async () => {
  for (const value of transports.splice(0)) await value.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
  if (isolated.root) await rm(isolated.root, { recursive: true, force: true });
  isolated.root = "";
});

describe("分发包代理设置", () => {
  it("读取 macOS HTTP/HTTPS、CIDR 绕过和本地主机设置", () => {
    expect(parseMacProxy(`<dictionary> {
      HTTPEnable : 1
      HTTPProxy : 127.0.0.1
      HTTPPort : 7890
      HTTPSEnable : 1
      HTTPSProxy : ::1
      HTTPSPort : 7891
      ExcludeSimpleHostnames : 1
      ExceptionsList : <array> {
        0 : 192.168.0.0/16
        1 : *.local
      }
    }`)).toMatchObject({ httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://[::1]:7891", noProxy: "192.168.0.0/16,*.local", excludeSimpleHosts: true, unsupported: false });
  });

  it("读取 Windows 每协议代理、本地绕过规则和关闭状态", () => {
    const registry = `
      ProxyEnable    REG_DWORD    0x1
      ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891
      ProxyOverride    REG_SZ    <local>;*.local;127.0.0.1
    `;
    expect(parseWindowsProxy(registry)).toMatchObject({ httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7891", noProxy: "*.local,127.0.0.1", excludeSimpleHosts: true });
    expect(parseWindowsProxy(registry.replace("0x1", "0x0")).httpProxy).toBeUndefined();
    expect(parseWindowsProxy("ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:7890")).toMatchObject({ httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7890" });
  });

  it("显式代理 > 环境变量 > 系统；小写优先，HTTPS 回退 HTTP，支持 ALL_PROXY", async () => {
    const system = vi.fn(async () => ({ httpProxy: "http://system.test:7890", httpsProxy: "http://system.test:7890", noProxy: "localhost" }));
    const env = { http_proxy: "http://lower.test:8080", HTTP_PROXY: "http://upper.test:8080", NO_PROXY: "*.local" };
    expect(await resolvePackageProxy(env, system)).toMatchObject({ httpProxy: "http://lower.test:8080/", httpsProxy: "http://lower.test:8080/", noProxy: "*.local" });
    expect(await resolvePackageProxy({ ...env, GH_RUNNER_PROXY: "http://explicit.test:80" }, system)).toMatchObject({ httpProxy: "http://explicit.test/", httpsProxy: "http://explicit.test/" });
    expect(await resolvePackageProxy({ ALL_PROXY: "http://all.test:80" }, system)).toMatchObject({ httpProxy: "http://all.test/", httpsProxy: "http://all.test/" });
    expect(await resolvePackageProxy({ GH_RUNNER_PROXY: "direct" }, system)).toMatchObject({ description: expect.stringContaining("直连") });
    expect(system).not.toHaveBeenCalled();
    expect(await resolvePackageProxy({}, system)).toMatchObject({ httpsProxy: "http://system.test:7890/", noProxy: "localhost", description: expect.stringContaining("系统代理") });
    expect(await resolvePackageProxy({ NO_PROXY: "*" }, system)).toMatchObject({ noProxy: "*" });
  });

  it("拒绝 SOCKS/PAC 和无效地址，错误及连接说明不泄漏用户名或密码", async () => {
    await expect(resolvePackageProxy({ HTTPS_PROXY: "socks5://secret:password@127.0.0.1:7890" })).rejects.toThrow("HTTP 或混合端口");
    await expect(resolvePackageProxy({}, async () => ({ unsupported: true }))).rejects.toThrow("PAC");
    await expect(resolvePackageProxy({ HTTPS_PROXY: "password@invalid" })).rejects.toThrow("代理地址无效");
    const settings = await resolvePackageProxy({ HTTPS_PROXY: "http://secret:password@127.0.0.1:7890" });
    expect(settings.description).toContain("127.0.0.1:7890");
    expect(settings.description).not.toMatch(/secret|password/);
    expect(parseMacProxy("ProxyAutoConfigEnable : 1").unsupported).toBe(true);
    expect(parseWindowsProxy("AutoConfigURL REG_SZ https://example.test/proxy.pac").unsupported).toBe(true);
  });

  it.each([
    ["http://localhost:8080", "localhost:8080", true],
    ["http://localhost:8081", "localhost:8080", false],
    ["https://api.github.com", ".github.com", true],
    ["https://api.github.com", "github.com", true],
    ["https://notgithub.com", ".github.com", false],
    ["http://192.168.2.3", "192.168.0.0/16", true],
    ["http://192.169.2.3", "192.168.0.0/16", false],
    ["http://[::1]:8080", "[::1]:8080", true],
    ["http://[fd00::1]", "fd00::/8", true],
    ["https://github.com", "*", true],
    ["http://build.local", "*.local", true],
    ["http://192.168.2.3", "192.168.0.0/no", false],
  ])("正确绕过 %s（%s → %s）", (url, noProxy, bypass) => {
    expect(bypassPackageProxy(new URL(url), { noProxy })).toBe(bypass);
  });

  it("支持 Windows <local>，但不把公网 IP 误认为本地主机", () => {
    expect(bypassPackageProxy(new URL("http://build-server"), { excludeSimpleHosts: true })).toBe(true);
    expect(bypassPackageProxy(new URL("http://8.8.8.8"), { excludeSimpleHosts: true })).toBe(false);
  });
});

describe("真实本地 HTTP CONNECT 代理", () => {
  it("release 元数据、下载地址和重定向都使用代理，NO_PROXY 对重定向后的主机也生效", async () => {
    isolated.root = await mkdtemp(join(tmpdir(), "runner-proxy-"));
    const body = Buffer.from("official runner archive test content");
    const asset = assetNameFor("2.340.0");
    let originPort: number;
    originPort = await listen(createServer((request, response) => {
      if (request.url === "/latest") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ tag_name: "v2.340.0", assets: [{ name: asset, browser_download_url: "http://assets.test/redirect", size: body.length }] }));
      } else if (request.url === "/redirect") {
        response.writeHead(302, { Location: "http://cdn.test/bypass" }); response.end();
      } else if (request.url === "/bypass") {
        response.writeHead(302, { Location: `http://127.0.0.1:${originPort}/archive` }); response.end();
      } else {
        response.writeHead(200, { "Content-Length": body.length }); response.end(body);
      }
    }));
    const localProxy = await proxy(originPort);
    const network = transport(await resolvePackageProxy({ HTTP_PROXY: localProxy.url, NO_PROXY: "127.0.0.1" }));
    const request: typeof fetch = (input, init) => network.fetch(String(input).includes("api.github.com") ? "http://api.test/latest" : input, init);
    const release = await fetchLatestReleaseInfo(undefined, request);
    const dest = await downloadPackage(release, () => {}, undefined, undefined, request);
    expect(await readFile(dest)).toEqual(body);
    expect(localProxy.requests).toEqual(["api.test:80", "assets.test:80", "cdn.test:80"]);
  });

  it("GitHub HTTPS API 使用 HTTPS_PROXY，等待代理响应时仍可取消", async () => {
    const http = await proxy(); const https = await proxy();
    const network = transport(await resolvePackageProxy({ HTTP_PROXY: http.url, HTTPS_PROXY: https.url }));
    const controller = new AbortController();
    const pending = fetchLatestReleaseInfo(controller.signal, network.fetch);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(https.requests).toEqual(["api.github.com:443"]));
    controller.abort();
    await rejected;
    expect(http.requests).toEqual([]);
  });

  it("代理不可达时报错，不静默回落直连，也不暴露代理认证信息", async () => {
    const unavailable = createServer();
    const port = await listen(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const network = transport(await resolvePackageProxy({ HTTP_PROXY: `http://secret:password@127.0.0.1:${port}` }));
    await expect(network.fetch("http://never-contact.test")).rejects.toThrow("下载网络请求失败");
  });
});

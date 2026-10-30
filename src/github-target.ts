export interface RunnerTarget {
  url: string;
  apiPath: string;
  settingsUrl: string;
  kind: "organization" | "repository";
  name: string;
}

export function parseRunnerTarget(value: string): RunnerTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的 GitHub 组织或仓库地址");
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (
    url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash ||
    parts.length < 1 || parts.length > 2 ||
    parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")
  ) {
    throw new Error("仅支持 https://github.com/组织 或 https://github.com/所有者/仓库");
  }
  const name = parts.join("/");
  const organization = parts.length === 1;
  return {
    url: `https://github.com/${name}`,
    apiPath: organization ? `/orgs/${name}/actions/runners/registration-token` : `/repos/${name}/actions/runners/registration-token`,
    settingsUrl: organization ? `https://github.com/organizations/${name}/settings/actions/runners/new` : `https://github.com/${name}/settings/actions/runners/new`,
    kind: organization ? "organization" : "repository",
    name,
  };
}

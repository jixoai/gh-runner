import { describe, expect, it } from "vitest";
import { formatDeviceAuthorization, formatHostPlatform } from "../src/cli.ts";

describe("CLI host platform label", () => {
  it.each([
    ["darwin", "arm64", "macOS · ARM64"],
    ["win32", "x64", "Windows · X64"],
    ["linux", "x64", "Linux · X64"],
  ])("formats %s/%s for the package download", (platform, arch, expected) => {
    expect(formatHostPlatform(platform, arch)).toBe(expected);
  });
});

describe("GitHub device authorization display", () => {
  it("renders a scannable terminal QR and a readable fallback code", async () => {
    const panel = await formatDeviceAuthorization("https://github.com/login/device", "110B-21A1");
    expect(panel).toContain("https://github.com/login/device");
    expect(panel).toContain("110B-21A1");
    expect(panel).toContain("█");
  });
});

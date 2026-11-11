import { describe, expect, it } from "vitest";
import { renderSystemdUnit } from "../src/cli.ts";

describe("Linux systemd user service", () => {
  it("renders a persistent runner unit with safely quoted paths", () => {
    const unit = renderSystemdUnit('/home/runner/actions runners/one$prod');
    expect(unit).toContain('WorkingDirectory="/home/runner/actions runners/one$$prod"');
    expect(unit).toContain('ExecStart=/bin/bash "/home/runner/actions runners/one$$prod/run.sh"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

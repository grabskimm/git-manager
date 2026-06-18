import { describe, it, expect } from "vitest";
import { sessionFromMeta } from "../src/agents/copilot.js";

describe("copilot CLI sessionFromMeta", () => {
  it("maps workspaceFolder + timestamps, translating Windows<->WSL paths", () => {
    const created = 1779989774578;
    const modified = 1779989775790;
    const s = sessionFromMeta(
      "1a8fb10b-3574-486a-a847-9ea40732bcb6",
      { workspaceFolder: { folderPath: "m:\\git\\waf-upgrade" }, created, modified },
      Date.now(),
    );
    expect(s).not.toBeNull();
    expect(s!.id).toBe("1a8fb10b-3574-486a-a847-9ea40732bcb6");
    expect(s!.source).toBe("copilot");
    expect(s!.cwd).toBe(process.platform === "win32" ? "M:\\git\\waf-upgrade" : "/mnt/m/git/waf-upgrade");
    expect(s!.startedAt).toBe(new Date(created).toISOString());
    expect(s!.lastEventAt).toBe(new Date(modified).toISOString());
  });

  it("falls back to repositoryProperties.repositoryPath", () => {
    const s = sessionFromMeta(
      "x",
      { repositoryProperties: { repositoryPath: "m:\\git\\terraform-training" }, modified: 1781800222088 },
      Date.now(),
    );
    expect(s!.cwd).toBe(
      process.platform === "win32" ? "M:\\git\\terraform-training" : "/mnt/m/git/terraform-training",
    );
  });

  it("tolerates missing cwd (emits unbound session)", () => {
    const s = sessionFromMeta("y", { created: 1779989774578 }, Date.now());
    expect(s!.cwd).toBe("");
  });
});

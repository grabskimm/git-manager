import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isolateHome, tmpDir, initRepo, writeAndCommit, createBranch } from "./helpers.js";
import { openDb } from "../src/db.js";
import { setConfigValue } from "../src/config.js";
import { upsertRepo, createPr } from "../src/store.js";
import { resolveIdentity } from "../src/identity.js";
import { defaultBranch } from "../src/git.js";
import { AgentManager } from "../src/agents/manager.js";
import { ClaudeCodeSource } from "../src/agents/claudeCode.js";
import type { WsHub } from "../src/ws.js";

const fakeHub = { broadcast() {} } as unknown as WsHub;

beforeAll(() => {
  isolateHome();
});

describe("Claude Code agent source (§5/§6)", () => {
  it("exposes observe=true, control=false", () => {
    const src = new ClaudeCodeSource();
    expect(src.capabilities).toEqual({ observe: true, control: false });
  });

  it("control methods throw NotSupported in v1", () => {
    const src = new ClaudeCodeSource();
    expect(() => src.start()).toThrow(/not supported/i);
    expect(() => src.stop()).toThrow(/not supported/i);
  });

  it("discovers a session and binds it to repo + branch + open PR", async () => {
    const db = openDb();

    // Ingest a repo and check out a feature branch.
    const { path: repoPath } = await initRepo();
    await writeAndCommit(repoPath, "a.txt", "1", "c1");
    await createBranch(repoPath, "feature");
    await writeAndCommit(repoPath, "b.txt", "2", "c2");
    const identity = await resolveIdentity(repoPath);
    const repo = upsertRepo(db, {
      id: identity.id,
      display_name: "agent-repo",
      abs_path: repoPath,
      default_branch: await defaultBranch(repoPath),
    });

    // Open a PR whose head matches the checked-out branch.
    const pr = createPr(db, {
      repo_id: repo.id,
      title: "wip",
      description: null,
      base_ref: "main",
      head_ref: "feature",
    });

    // Fabricate a Claude Code transcript pointing its cwd at the repo.
    const projects = tmpDir("gm-claude-projects-");
    const projDir = path.join(projects, "encoded-project");
    fs.mkdirSync(projDir, { recursive: true });
    const sid = "sess-123";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ type: "user", sessionId: sid, cwd: repoPath, timestamp: now }),
      JSON.stringify({
        type: "assistant",
        sessionId: sid,
        cwd: repoPath,
        timestamp: now,
        message: { content: [{ type: "tool_use", name: "Edit", input: { file: "b.txt" } }] },
      }),
    ];
    fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.join("\n"));
    process.env.GITMANAGER_CLAUDE_PROJECTS = projects;

    setConfigValue(db, "agent_observe_enabled", true);
    const mgr = new AgentManager(db, fakeHub);
    mgr.enable();
    const sessions = await mgr.refresh();

    const session = sessions.find((s) => s.id === sid);
    expect(session).toBeTruthy();
    expect(session!.repo_id).toBe(repo.id);
    expect(session!.branch).toBe("feature");
    expect(session!.pr_id).toBe(pr.id);
    expect(session!.status).toBe("running");

    mgr.disable();
    db.close();
  });
});

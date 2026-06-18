import { spawn } from "node:child_process";
import http from "node:http";
import { startEngine } from "./server.js";
import { loadOrCreateToken } from "./token.js";

function openBrowser(url: string): void {
  if (process.env.GITMANAGER_NO_OPEN || process.argv.includes("--no-open")) return;
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // headless / no browser — fine, the URL is printed.
  }
}

/** `gitmanager hook-event` — invoked by Claude Code hooks to nudge a refresh. */
function hookEvent(): void {
  const token = loadOrCreateToken();
  const port = process.env.GITMANAGER_PORT ? Number(process.env.GITMANAGER_PORT) : 4317;
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/api/agents/hook",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "Content-Length": "2",
      },
    },
    (res) => res.resume(),
  );
  req.on("error", () => {});
  req.end("{}");
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === "hook-event") {
    hookEvent();
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    process.stdout.write(
      [
        "gitmanager — local-first git UI with local PRs and AI review",
        "",
        "Usage:",
        "  gitmanager [start]        Start the engine and open the UI (default)",
        "  gitmanager hook-event     Internal: nudge agent refresh (used by hooks)",
        "",
        "Options:",
        "  --no-open                 Do not open a browser",
        "",
        "Env:",
        "  GITMANAGER_PORT           Port to bind (default 4317)",
        "  GITMANAGER_HOME           State dir (default ~/.gitmanager)",
        "",
      ].join("\n"),
    );
    return;
  }

  const engine = await startEngine();
  // Best-effort: register Claude Code hooks so observation has low latency.
  engine.ctx.agents.installHooks("gitmanager hook-event");

  process.stdout.write(
    [
      "",
      "  GitManager engine running (loopback only)",
      `  ➜  ${engine.url}`,
      `  Token stored at ~/.gitmanager/token (injected into the served UI)`,
      "",
    ].join("\n") + "\n",
  );

  openBrowser(engine.url);

  const shutdown = async (): Promise<void> => {
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Failed to start GitManager: ${(err as Error).message}\n`);
  process.exit(1);
});

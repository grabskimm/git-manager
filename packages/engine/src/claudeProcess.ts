import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolved at call time so tests and users can override the binary. */
export function claudeBin(): string {
  return process.env.GITMANAGER_CLAUDE_BIN || "claude";
}

/**
 * A dedicated cwd for all internal `claude --print` subprocess calls.
 * Using a fixed path inside GITMANAGER_HOME ensures the Claude Code agent
 * transcript discovery never picks up our review/chat sessions as user
 * sessions (they would otherwise pollute the agent observe panel).
 */
function internalCwd(): string {
  const home = process.env.GITMANAGER_HOME ?? join(homedir(), ".gitmanager");
  const dir = join(home, ".internal");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

/** Is the `claude` CLI present and runnable? */
export function isClaudeAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin(), ["--version"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export type StreamResult =
  | { status: "ok"; body: string }
  | { status: "skipped"; reason: string };

/**
 * Run the `claude` CLI in structured streaming mode and stream text deltas to
 * `onToken`. Works with a plain login and stays compatible with environments
 * that inject `--include-partial-messages`. Never throws — returns a skip
 * result on any failure so callers can degrade gracefully.
 */
export function runClaudeStreaming(opts: {
  prompt: string;
  onToken: (token: string) => void;
  model?: string;
}): Promise<StreamResult> {
  return new Promise((resolve) => {
    const args = ["--print", "--verbose", "--output-format", "stream-json"];
    if (opts.model) args.push("--model", opts.model);
    let child;
    try {
      child = spawn(claudeBin(), args, {
        cwd: internalCwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ status: "skipped", reason: `Failed to launch \`claude\`: ${(err as Error).message}` });
      return;
    }

    let buffer = "";
    let streamed = "";
    let resultText = "";
    let sawDelta = false;
    let stderr = "";

    const emit = (token: string): void => {
      if (!token) return;
      streamed += token;
      opts.onToken(token);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      const delta = extractDeltaText(obj);
      if (delta !== null) {
        sawDelta = true;
        emit(delta);
        return;
      }
      if (obj.type === "assistant" && !sawDelta) {
        const text = extractAssistantText(obj);
        if (text) emit(text);
      }
      if (obj.type === "result" && typeof obj.result === "string") {
        resultText = obj.result;
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      resolve({ status: "skipped", reason: `\`claude\` failed to run: ${err.message}` });
    });

    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      const body = (resultText || streamed).trim();
      if (code !== 0 || !body) {
        const reason =
          stderr.trim() ||
          `\`claude\` exited with code ${code}. You may need to log in (run \`claude\` once).`;
        resolve({ status: "skipped", reason });
        return;
      }
      resolve({ status: "ok", body });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}

/** Pull incremental text from a stream-json partial-message event, if present. */
function extractDeltaText(obj: Record<string, unknown>): string | null {
  const event = obj.event as Record<string, unknown> | undefined;
  const candidate = event ?? obj;
  if (
    candidate &&
    candidate.type === "content_block_delta" &&
    candidate.delta &&
    typeof candidate.delta === "object"
  ) {
    const delta = candidate.delta as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }
  return null;
}

/** Concatenate text blocks from a complete assistant message. */
function extractAssistantText(obj: Record<string, unknown>): string {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text: string } =>
        !!p && typeof p === "object" && (p as { type?: string }).type === "text",
    )
    .map((p) => p.text)
    .join("");
}

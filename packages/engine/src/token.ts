import crypto from "node:crypto";
import fs from "node:fs";
import { tokenPath } from "./paths.js";

/**
 * Load the loopback auth token, generating it on first run.
 * Stored at ~/.gitmanager/token with 0600 permissions.
 */
export function loadOrCreateToken(): string {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not present yet
  }
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  // Enforce perms even if the file pre-existed with looser bits.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
  return token;
}

/** Constant-time string comparison to avoid timing leaks on the token. */
export function safeEqual(a: string, b: string): boolean {
  // Hash both inputs so the digests are always the same length — the early
  // `length !== length` short-circuit would otherwise reveal token length to
  // an attacker probing the loopback port.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

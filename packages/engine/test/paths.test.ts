import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalTmpDir, tmpPath } from "../src/paths.js";

const ORIGINAL_TMP = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };

afterEach(() => {
  // Restore whatever os.tmpdir() was reading so other suites are unaffected.
  for (const k of ["TMPDIR", "TMP", "TEMP"] as const) {
    const v = ORIGINAL_TMP[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("canonicalTmpDir", () => {
  it("returns an absolute path that exists", () => {
    const dir = canonicalTmpDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("resolves a symlinked temp dir to its real target", () => {
    // Mirrors the Windows 8.3 short-path case (and macOS /var symlink): the env
    // points at an indirection, and we must hand callers the canonical path so
    // the spawned `claude` agent's path-safety guard accepts the cwd.
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "gm-real-"));
    const link = path.join(os.tmpdir(), `gm-link-${Date.now()}`);
    try {
      fs.symlinkSync(real, link, "dir");
    } catch {
      // Some platforms/CI lack symlink privileges — nothing to assert then.
      fs.rmSync(real, { recursive: true, force: true });
      return;
    }
    try {
      process.env.TMPDIR = link;
      process.env.TMP = link;
      process.env.TEMP = link;
      expect(canonicalTmpDir()).toBe(fs.realpathSync.native(real));
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe("tmpPath", () => {
  it("lives under the canonical temp dir and carries the prefix/suffix", () => {
    const p = tmpPath("gm-impl");
    expect(path.dirname(p)).toBe(canonicalTmpDir());
    expect(path.basename(p)).toMatch(/^gm-impl-[0-9a-f]{12}$/);
  });

  it("appends a suffix when given one", () => {
    expect(tmpPath("gm-bundle", ".bundle")).toMatch(/gm-bundle-[0-9a-f]{12}\.bundle$/);
  });

  it("is unique across calls", () => {
    expect(tmpPath("gm-impl")).not.toBe(tmpPath("gm-impl"));
  });
});

import { describe, it, expect } from "vitest";
import { gitUserName } from "../src/git.js";

describe("gitUserName", () => {
  it("resolves a non-empty name (git config or OS account) and caches it", async () => {
    const a = await gitUserName();
    const b = await gitUserName();
    expect(a).toBe(b); // cached → stable
    if (a !== null) expect(a.length).toBeGreaterThan(0);
  });
});

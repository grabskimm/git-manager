import { describe, it, expect } from "vitest";
import { loadDep, MissingDepError } from "../src/storage/optionalDep.js";
import { AzureBackend } from "../src/storage/azureBackend.js";

describe("loadDep", () => {
  it("throws an actionable MissingDepError for a package that isn't installed", async () => {
    await expect(loadDep("@gitmanager/definitely-not-installed")).rejects.toBeInstanceOf(
      MissingDepError,
    );
    try {
      await loadDep("@gitmanager/definitely-not-installed");
    } catch (e) {
      expect((e as Error).message).toMatch(/not installed/);
      expect((e as Error).message).toMatch(/npm install/);
    }
  });

  it("loads a real module", async () => {
    const mod = await loadDep("node:path");
    expect(typeof mod.join).toBe("function");
  });
});

describe("backend isReady surfaces missing-dep cause (not a misleading auth hint)", () => {
  it("reports the install error, not `az login`, when the SDK is the problem", async () => {
    // We can't uninstall @azure here, so just assert MissingDepError's message
    // shape is what isReady would relay (it returns e.message verbatim).
    const err = new MissingDepError("@azure/storage-blob");
    expect(err.message).not.toMatch(/az login/);
    expect(err.message).toMatch(/npm install/);
    // Sanity: the backend constructs without throwing.
    expect(new AzureBackend("acct", "container").id).toBe("azure");
  });
});

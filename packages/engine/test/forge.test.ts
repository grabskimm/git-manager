import { describe, it, expect } from "vitest";
import { parseGitHubSlug } from "../src/forge.js";

describe("parseGitHubSlug", () => {
  it("parses https, ssh, and scp-style GitHub URLs (with/without .git)", () => {
    expect(parseGitHubSlug("https://github.com/grabskimm/git-manager.git")).toBe(
      "grabskimm/git-manager",
    );
    expect(parseGitHubSlug("https://github.com/grabskimm/git-manager")).toBe(
      "grabskimm/git-manager",
    );
    expect(parseGitHubSlug("git@github.com:grabskimm/git-manager.git")).toBe(
      "grabskimm/git-manager",
    );
    expect(parseGitHubSlug("ssh://git@github.com/grabskimm/git-manager")).toBe(
      "grabskimm/git-manager",
    );
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubSlug("https://gitlab.com/foo/bar.git")).toBeNull();
    expect(parseGitHubSlug("/srv/local/repo")).toBeNull();
    expect(parseGitHubSlug("")).toBeNull();
  });
});

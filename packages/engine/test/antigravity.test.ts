import { describe, it, expect } from "vitest";
import { parseTrajectories, normalizeToPlatform } from "../src/agents/antigravity.js";
import { collectScalars, topLevelEntries } from "../src/agents/protobuf.js";

// --- minimal protobuf encoders (test fixtures) ---
function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}
function strField(field: number, s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}
function msgField(field: number, body: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}
function varField(field: number, n: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

describe("protobuf wire reader", () => {
  it("decodes nested messages and base64-wrapped strings", () => {
    const inner = strField(1, "PS M:\\git\\tf-avd-module\\examples\\x");
    const nestedB64 = inner.toString("base64");
    const entry = Buffer.concat([strField(1, "abcdef01-2345-6789-abcd-ef0123456789"), strField(2, nestedB64)]);
    const { strings } = collectScalars(entry);
    expect(strings).toContain("abcdef01-2345-6789-abcd-ef0123456789");
    // the path was nested inside a base64-encoded protobuf string and recovered
    expect(strings.some((s) => s.includes("M:\\git\\tf-avd-module"))).toBe(true);
  });

  it("extracts top-level repeated field-1 entries", () => {
    const e1 = strField(1, "one");
    const e2 = strField(1, "two");
    const msg = Buffer.concat([msgField(1, e1), msgField(1, e2)]);
    expect(topLevelEntries(msg)).toHaveLength(2);
  });
});

describe("normalizeToPlatform", () => {
  it("maps file:// URIs and Windows paths to the current platform", () => {
    const out = normalizeToPlatform("file:///m%3A/git/tf-avd-module");
    if (process.platform === "win32") {
      expect(out).toBe("M:\\git\\tf-avd-module");
    } else {
      expect(out).toBe("/mnt/m/git/tf-avd-module");
    }
  });
});

describe("parseTrajectories", () => {
  it("emits a session per trajectory, binding cwd to a known workspace folder", () => {
    const ts = 1_900_000_000_000; // ms, in plausible range
    const uuid = "d06ab8f7-8db3-4d61-85c1-c6cb97f277ec";
    // entry: id + an embedded windows path + a timestamp varint
    const entry = Buffer.concat([
      strField(1, uuid),
      strField(2, "M:\\git\\tf-avd-module\\examples\\main.tf"),
      varField(3, ts),
    ]);
    const top = msgField(1, entry);
    const b64 = top.toString("base64");

    const result = parseTrajectories(b64, ["file:///m%3A/git/tf-avd-module"], Date.now());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(uuid);
    const expectedCwd =
      process.platform === "win32" ? "M:\\git\\tf-avd-module" : "/mnt/m/git/tf-avd-module";
    expect(result[0].cwd).toBe(expectedCwd);
    expect(result[0].lastEventAt).toBe(new Date(ts).toISOString());
  });

  it("returns nothing for garbage input (fail-soft)", () => {
    expect(parseTrajectories("not!!base64!!", [], Date.now())).toEqual([]);
  });
});

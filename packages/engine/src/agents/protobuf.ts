// Tolerant, schema-less protobuf helpers. We don't have Antigravity's .proto,
// and its messages contain fields/encodings our minimal reader doesn't model,
// so extraction is intentionally forgiving: we recover as much as we can rather
// than failing the whole message.

export interface PbField {
  field: number;
  wire: number;
  value: bigint | Buffer;
}

function readVarint(buf: Buffer, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i];
    result |= BigInt(byte & 0x7f) << shift;
    i++;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 70n) break; // malformed
  }
  return [-1n, -1];
}

/**
 * Decode a protobuf message into fields, stopping at the first byte we can't
 * interpret and returning whatever was parsed so far (best-effort, never null).
 */
export function decodeMessage(buf: Buffer): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, next] = readVarint(buf, i);
    if (next < 0) break;
    i = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) break;
    if (wire === 0) {
      const [v, n] = readVarint(buf, i);
      if (n < 0) break;
      i = n;
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      const [len, n] = readVarint(buf, i);
      if (n < 0) break;
      const L = Number(len);
      if (L < 0 || n + L > buf.length) break;
      out.push({ field, wire, value: buf.subarray(n, n + L) });
      i = n + L;
    } else if (wire === 1) {
      if (i + 8 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break; // group wire types — give up here, keep what we have
    }
  }
  return out;
}

/**
 * Tolerant top-level splitter: walk the message and collect every length-
 * delimited `field` chunk (Antigravity wraps repeated lists as field 1),
 * skipping other fields/wire types gracefully.
 */
export function topLevelEntries(buf: Buffer, field = 1): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, n1] = readVarint(buf, i);
    if (n1 < 0) break;
    const f = Number(key >> 3n);
    const w = Number(key & 7n);
    let j = n1;
    if (w === 2) {
      const [len, n2] = readVarint(buf, j);
      if (n2 < 0) break;
      const L = Number(len);
      if (L < 0 || n2 + L > buf.length) break;
      if (f === field) out.push(buf.subarray(n2, n2 + L));
      j = n2 + L;
    } else if (w === 0) {
      const [, n2] = readVarint(buf, j);
      if (n2 < 0) break;
      j = n2;
    } else if (w === 1) {
      j += 8;
    } else if (w === 5) {
      j += 4;
    } else {
      break;
    }
    if (j <= i) break;
    i = j;
  }
  return out;
}

function looksBase64(s: string): boolean {
  return s.length >= 20 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

function isPrintableByte(b: number): boolean {
  return b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126);
}

/** Whole-buffer printable check → the decoded string, or null if it's binary. */
function printableString(b: Buffer): string | null {
  if (b.length === 0) return null;
  let bad = 0;
  for (const c of b) {
    if (c === 0) return null;
    if (!isPrintableByte(c) && c < 128) bad++;
  }
  if (bad / b.length > 0.1) return null;
  return b.toString("utf8");
}

/** Walk protobuf fields (tolerant), recursing into sub-messages; decode base64
 * string fields cleanly (exact boundaries) and recurse into those too. */
function fieldWalk(buf: Buffer, depth: number, out: string[]): void {
  if (depth > 8) return;
  for (const f of decodeMessage(buf)) {
    if (f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
    const v = f.value;
    const s = printableString(v);
    if (s !== null) {
      out.push(s);
      if (looksBase64(s)) {
        try {
          const d = Buffer.from(s, "base64");
          if (d.length > 4) fieldWalk(d, depth + 1, out);
        } catch {
          // not base64
        }
      }
    } else {
      fieldWalk(v, depth + 1, out);
    }
  }
}

/** Raw scan for printable ASCII runs — catches anything field parsing misses. */
function byteScan(buf: Buffer, out: string[]): void {
  let i = 0;
  while (i < buf.length) {
    if (!isPrintableByte(buf[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < buf.length && isPrintableByte(buf[j])) j++;
    if (j - i >= 3) out.push(buf.toString("utf8", i, j));
    i = j;
  }
}

/**
 * Robustly extract strings from arbitrary (protobuf) bytes. Combines a tolerant
 * field-walk (clean base64 boundaries, handles Antigravity's nested blobs) with
 * a raw byte-scan, so paths survive even when the message can't be fully parsed.
 */
export function extractStrings(buf: Buffer): string[] {
  const out: string[] = [];
  fieldWalk(buf, 0, out);
  byteScan(buf, out);
  return [...new Set(out)];
}

/** Best-effort recursive collection of varints (e.g. timestamps). */
export function collectVarints(buf: Buffer, depth = 0, out: bigint[] = []): bigint[] {
  if (depth > 10) return out;
  for (const f of decodeMessage(buf)) {
    if (f.wire === 0) {
      out.push(f.value as bigint);
    } else if (f.wire === 2 && Buffer.isBuffer(f.value) && f.value.length >= 2) {
      collectVarints(f.value, depth + 1, out);
    }
  }
  return out;
}

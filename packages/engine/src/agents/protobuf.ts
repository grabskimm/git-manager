// Minimal, schema-less protobuf wire-format reader. We don't have Antigravity's
// .proto, but observe-only only needs to pull scalars (ids, paths, timestamps)
// out of the message tree, which the wire format permits without a schema.

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

/** Decode one protobuf message into its fields, or null if malformed. */
export function decodeMessage(buf: Buffer): PbField[] | null {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, next] = readVarint(buf, i);
    if (next < 0) return null;
    i = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field <= 0) return null;
    if (wire === 0) {
      const [v, n] = readVarint(buf, i);
      if (n < 0) return null;
      i = n;
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      const [len, n] = readVarint(buf, i);
      if (n < 0) return null;
      const L = Number(len);
      if (L < 0 || n + L > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(n, n + L) });
      i = n + L;
    } else if (wire === 1) {
      if (i + 8 > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return null;
      out.push({ field, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      return null; // unsupported wire type (3/4 groups)
    }
  }
  return out;
}

/** Top-level repeated field 1 entries (Antigravity wraps lists this way). */
export function topLevelEntries(buf: Buffer, field = 1): Buffer[] {
  const fields = decodeMessage(buf);
  if (!fields) return [];
  return fields
    .filter((f) => f.field === field && f.wire === 2 && Buffer.isBuffer(f.value))
    .map((f) => f.value as Buffer);
}

function printableString(b: Buffer): string | null {
  if (b.length === 0) return null;
  let bad = 0;
  for (const c of b) {
    if (c === 0) return null;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  if (bad / b.length > 0.1) return null;
  return b.toString("utf8");
}

function looksBase64(s: string): boolean {
  return s.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/**
 * Recursively collect every scalar from a protobuf message: printable strings
 * (leaves) and varints. Strings that are themselves base64-encoded protobuf
 * (Antigravity nests them) are decoded and walked too. Fail-soft throughout.
 */
export function collectScalars(buf: Buffer): { strings: string[]; varints: bigint[] } {
  const strings: string[] = [];
  const varints: bigint[] = [];

  const walk = (b: Buffer, depth: number): void => {
    if (depth > 12) return;
    const fields = decodeMessage(b);
    if (!fields) return;
    for (const f of fields) {
      if (f.wire === 0) {
        varints.push(f.value as bigint);
      } else if (f.wire === 2 && Buffer.isBuffer(f.value)) {
        const v = f.value;
        const s = printableString(v);
        if (s !== null) {
          strings.push(s);
          if (looksBase64(s)) {
            try {
              const decoded = Buffer.from(s, "base64");
              if (decoded.length > 1) walk(decoded, depth + 1);
            } catch {
              // not really base64
            }
          }
        } else {
          walk(v, depth + 1);
        }
      }
    }
  };

  walk(buf, 0);
  return { strings, varints };
}

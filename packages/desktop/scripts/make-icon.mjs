// Generates the GitManager app icon + logo, procedurally, with no external
// tooling so CI and contributors can regenerate it deterministically:
//
//   packages/desktop/build/icon.ico   multi-size Windows icon (MSI needs it)
//   packages/desktop/build/icon.png    512px — Linux icon + electron-builder base
//   packages/desktop/build/logo.png    1024px — branding / docs
//
// The mark is a git branch-and-merge graph (a commit on the trunk, a feature
// branch that diverges and merges back) in GitManager's green on a dark rounded
// field — recognisable as a git tool. Rendered at 4x and box-downsampled for
// clean anti-aliasing.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(here, "../build");

// palette
const BG_TOP = [22, 27, 34]; // #161b22
const BG_BOT = [9, 12, 16]; // #090c10
const GREEN = [63, 185, 80]; // #3fb950
const GREEN_HI = [86, 211, 100]; // #56d364

const MASTER = 1024;

// --- tiny raster canvas (premultiplied src-over onto opaque/transparent) -----
function canvas(n) {
  return { n, buf: new Float32Array(n * n * 4) }; // rgba, 0..255, a 0..255
}
function blend(c, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= c.n || y >= c.n || a <= 0) return;
  const i = (y * c.n + x) * 4;
  const ia = c.buf[i + 3] / 255;
  const sa = a / 255;
  const oa = sa + ia * (1 - sa);
  if (oa <= 0) return;
  for (let k = 0; k < 3; k++) {
    c.buf[i + k] = (rgb[k] * sa + c.buf[i + k] * (ia * (1 - sa))) / oa;
  }
  c.buf[i + 3] = oa * 255;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
// signed distance helpers (in pixel space)
function roundedRectSDF(x, y, n, pad, r) {
  const min = pad + r;
  const max = n - 1 - pad - r;
  const dx = Math.max(min - x, 0, x - max);
  const dy = Math.max(min - y, 0, y - max);
  return Math.hypot(dx, dy) - r;
}
function aa(d) {
  // coverage from signed distance, ~1px soft edge
  return Math.min(1, Math.max(0, 0.5 - d));
}

function drawBackground(c) {
  const n = c.n;
  const pad = n * 0.02;
  const r = n * 0.22;
  for (let y = 0; y < n; y++) {
    const g = lerp(BG_TOP, BG_BOT, y / (n - 1));
    for (let x = 0; x < n; x++) {
      const cov = aa(roundedRectSDF(x, y, n, pad, r));
      if (cov > 0) blend(c, x, y, g, cov * 255);
    }
  }
}

// stamp a soft disc (used for nodes and as stroke brush)
function disc(c, cx, cy, r, rgb, aFull = 255) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(c.n - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(c.n - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cov = aa(Math.hypot(x - cx, y - cy) - r);
      if (cov > 0) blend(c, x, y, rgb, cov * aFull);
    }
  }
}

// quadratic bezier stroke, round caps, by stamping discs along the curve
function stroke(c, p0, p1, p2, width, rgb) {
  const r = width / 2;
  const steps = 260;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0];
    const y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1];
    disc(c, x, y, r, rgb);
  }
}

// node = green disc with a dark ring (drawn as a larger bg-dark disc behind)
function node(c, x, y, r, rgb) {
  disc(c, x, y, r * 1.32, BG_BOT, 255); // ring/cutout
  disc(c, x, y, r, rgb);
}

function renderMaster() {
  const c = canvas(MASTER);
  const N = MASTER;
  drawBackground(c);

  // normalized coords -> pixels
  const P = (nx, ny) => [nx * N, ny * N];
  const w = 0.052 * N; // stroke width
  const nr = 0.078 * N; // node radius

  const trunkX = 0.40;
  const featX = 0.66;
  const topY = 0.24;
  const midY = 0.5;
  const botY = 0.76;

  // trunk (vertical main line)
  stroke(c, P(trunkX, topY), P(trunkX, (topY + botY) / 2), P(trunkX, botY), w, GREEN);
  // branch out: trunk -> feature node
  stroke(c, P(trunkX, topY + 0.04), P(featX, topY + 0.06), P(featX, midY), w, GREEN_HI);
  // merge back: feature node -> trunk (bottom)
  stroke(c, P(featX, midY), P(featX, botY - 0.06), P(trunkX, botY - 0.04), w, GREEN_HI);

  // nodes
  node(c, ...P(trunkX, topY), nr, GREEN);
  node(c, ...P(featX, midY), nr, GREEN_HI);
  node(c, ...P(trunkX, botY), nr, GREEN);

  return c;
}

// area (box) downsample master -> size, returns RGBA Uint8 buffer
function downsample(master, size) {
  const N = master.n;
  const out = Buffer.alloc(size * size * 4);
  const scale = N / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      const sx0 = Math.floor(x * scale), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * scale));
      const sy0 = Math.floor(y * scale), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * scale));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * N + sx) * 4;
          const sa = master.buf[i + 3];
          r += master.buf[i] * sa;
          g += master.buf[i + 1] * sa;
          b += master.buf[i + 2] * sa;
          a += sa;
          cnt++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / cnt);
    }
  }
  return out;
}

// --- PNG encoder (RGBA, 8-bit) ---
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const master = renderMaster();
fs.mkdirSync(BUILD, { recursive: true });

const icoSizes = [16, 32, 48, 64, 128, 256];
const ico = buildIco(icoSizes.map((size) => ({ size, png: encodePng(downsample(master, size), size) })));
fs.writeFileSync(path.join(BUILD, "icon.ico"), ico);

fs.writeFileSync(path.join(BUILD, "icon.png"), encodePng(downsample(master, 512), 512));
fs.writeFileSync(path.join(BUILD, "logo.png"), encodePng(downsample(master, 1024), 1024));

console.log(`wrote icon.ico (${ico.length} b), icon.png (512), logo.png (1024) to ${BUILD}`);

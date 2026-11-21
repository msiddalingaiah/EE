// Draws the app icons (public/icon-192.png, icon-512.png, icon.svg): an osprey's silhouette in
// flight, seen from below (long wings bent at the wrist, fingered primaries), dark on a rounded
// square in the toolbar's accent yellow. No dependencies: the PNGs are rasterised here (4×4
// supersampling) and written with zlib. The native app's icons (src-tauri/icons) are made from
// icon-512.png with `npx tauri icon public/icon-512.png`.
//
//   node scripts/build-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'public');
const BG = [0xff, 0xd8, 0x4d];
const FG = [0x15, 0x18, 0x1d];

// The design on a 100 × 100 canvas.
const CORNER = 18; // background corner radius
// The bird's right half, from the top of the head round the wing to the tail's tip; mirrored
// about x = 50 for the left. The outline is drawn with a thin stroke (EDGE) to round it off.
const HALF = [[50, 25], [53, 26.5], [54, 30], [54.5, 38], [62, 35], [72, 32.5], [82, 37], [94, 44],
  [91, 45.5], [94, 47.5], [89.5, 48.5], [92, 51], [86.5, 51], [87.5, 53.5], [82, 52], [74, 48.5],
  [64, 50], [56, 54], [55.5, 62], [60, 71], [55, 72.5], [50, 74]];
const BIRD = [...HALF, ...[...HALF].reverse().slice(1, -1).map(([x, y]) => [100 - x, y])];
const EDGE = 1.2;

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inside(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** 0 outside the icon, 1 background, 2 the bird. */
function sample(x, y) {
  const cx = Math.max(CORNER, Math.min(100 - CORNER, x));
  const cy = Math.max(CORNER, Math.min(100 - CORNER, y));
  if (Math.hypot(x - cx, y - cy) > CORNER) return 0;
  if (inside(x, y, BIRD)) return 2;
  for (let i = 0; i < BIRD.length; i++) if (segDist(x, y, BIRD[i], BIRD[(i + 1) % BIRD.length]) <= EDGE / 2) return 2;
  return 1;
}

function png(size) {
  const N = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let j = 0; j < size; j++) {
    raw[j * (size * 4 + 1)] = 0; // filter: none
    for (let i = 0; i < size; i++) {
      let a = 0, fg = 0;
      for (let v = 0; v < N; v++) {
        for (let u = 0; u < N; u++) {
          const s = sample(((i + (u + 0.5) / N) / size) * 100, ((j + (v + 0.5) / N) / size) * 100);
          if (s) a++;
          if (s === 2) fg++;
        }
      }
      const k = j * (size * 4 + 1) + 1 + i * 4;
      const f = a ? fg / a : 0;
      for (let c = 0; c < 3; c++) raw[k + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      raw[k + 3] = Math.round((a / (N * N)) * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${CORNER}" fill="${hex(BG)}"/>
  <path d="M${BIRD.map((p) => p.join(',')).join(' L')} Z" fill="${hex(FG)}" stroke="${hex(FG)}" stroke-width="${EDGE}" stroke-linejoin="round"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) writeFileSync(join(OUT, `icon-${size}.png`), png(size));
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('Wrote public/icon-192.png, icon-512.png, icon.svg');

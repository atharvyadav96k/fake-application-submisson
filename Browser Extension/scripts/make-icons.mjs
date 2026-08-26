#!/usr/bin/env node
/**
 * Generates the extension's PNG icons with no image dependencies.
 *
 * The mark is a rounded shield (verification) with a checkmark cut out of it, drawn
 * analytically per pixel so it stays crisp at 16/48/128 px.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'extension', 'icons');

const BG = [47, 91, 234]; // accent blue
const FG = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Signed distance from p to the segment ab, used to draw the checkmark. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function renderIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const s = size;
  const stroke = Math.max(1.1, s * 0.1);

  for (let y = 0; y < s; y++) {
    const rowStart = y * (s * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < s; x++) {
      const u = (x + 0.5) / s;
      const v = (y + 0.5) / s;

      // Shield: rounded top, tapering to a point at the bottom.
      const cx = 0.5;
      const halfWidth = 0.36 * (v < 0.55 ? 1 : 1 - ((v - 0.55) / 0.45) ** 1.5);
      const inShield = v > 0.08 && v < 0.95 && Math.abs(u - cx) < halfWidth;

      // Check mark.
      const d = Math.min(
        distToSegment(u * s, v * s, s * 0.32, s * 0.5, s * 0.45, s * 0.63),
        distToSegment(u * s, v * s, s * 0.45, s * 0.63, s * 0.69, s * 0.36),
      );
      const inCheck = d < stroke / 2;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (inShield) {
        [r, g, b] = inCheck ? FG : BG;
        a = 255;
      }

      const i = rowStart + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }

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

mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log('[icons] wrote', path.relative(root, file));
}

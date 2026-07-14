// Generates the extension's PNG icons with no external dependencies.
// A dark teal rounded square with a white upward "tally" bars motif.
// Run: node tools/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, pixels) {
  // pixels: Uint8Array length size*size*4 (RGBA)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rows with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) {
      raw[y * (size * 4 + 1) + 1 + x] = pixels[y * size * 4 + x];
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const teal = [3, 54, 61]; // #03363D
  const white = [255, 255, 255];
  const radius = size * 0.18;

  const inRounded = (x, y) => {
    const rx = Math.min(x, size - 1 - x);
    const ry = Math.min(y, size - 1 - y);
    if (rx >= radius || ry >= radius) return true;
    const dx = radius - rx;
    const dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  // Three ascending bars (a "counter" motif).
  const bars = [
    { x0: 0.22, x1: 0.38, top: 0.6 },
    { x0: 0.42, x1: 0.58, top: 0.42 },
    { x0: 0.62, x1: 0.78, top: 0.26 },
  ];
  const barBottom = 0.76;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color = [0, 0, 0];
      let alpha = 0;
      if (inRounded(x, y)) {
        color = teal;
        alpha = 255;
        const fx = x / size;
        const fy = y / size;
        for (const b of bars) {
          if (fx >= b.x0 && fx <= b.x1 && fy >= b.top && fy <= barBottom) {
            color = white;
          }
        }
      }
      const i = (y * size + x) * 4;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = alpha;
    }
  }
  return encodePNG(size, px);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), makeIcon(size));
  console.log(`wrote icons/icon${size}.png`);
}

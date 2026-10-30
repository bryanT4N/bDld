import zlib from "node:zlib";

const PINK = [251, 114, 153];
const WHITE = [255, 255, 255];

function inRoundedSquare(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inArrow(x, y) {
  const shaft = Math.abs(x - 0.5) <= 0.075 && y >= 0.2 && y <= 0.56;
  const head = y >= 0.44 && y <= 0.7 && Math.abs(x - 0.5) <= (0.7 - y) * 0.95;
  const base = y >= 0.76 && y <= 0.84 && x >= 0.24 && x <= 0.76;
  return shaft || head || base;
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** PNG bytes for a width x height RGBA image; `pixel(x, y)` returns [r, g, b, a] at pixel centres in [0, 1). */
export function png(width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let py = 0; py < height; py++) {
    raw[py * (width * 4 + 1)] = 0;
    for (let px = 0; px < width; px++) {
      const o = py * (width * 4 + 1) + 1 + px * 4;
      const [r, g, b, a] = pixel(px, py);
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A pink rounded square with a white download arrow, as PNG bytes. */
export function iconPng(size) {
  const ss = 4;
  return png(size, size, (px, py) => {
    let bg = 0;
    let fg = 0;
    for (let sy = 0; sy < ss; sy++) {
      for (let sx = 0; sx < ss; sx++) {
        const x = (px + (sx + 0.5) / ss) / size;
        const y = (py + (sy + 0.5) / ss) / size;
        if (!inRoundedSquare(x, y)) continue;
        if (inArrow(x, y)) fg++;
        else bg++;
      }
    }
    const mix = bg + fg === 0 ? 0 : fg / (bg + fg);
    const rgb = PINK.map((c, i) => Math.round(c * (1 - mix) + WHITE[i] * mix));
    return [...rgb, Math.round(((bg + fg) / (ss * ss)) * 255)];
  });
}

/** A neutral blue-grey gradient used as a stand-in video cover. */
export function coverPng(width, height) {
  return png(width, height, (x, y) => {
    const t = (x / width) * 0.6 + (y / height) * 0.4;
    return [Math.round(96 + 60 * t), Math.round(118 + 56 * t), Math.round(140 + 50 * t), 255];
  });
}

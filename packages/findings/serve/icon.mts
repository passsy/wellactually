/**
 * The app icon, drawn rather than shipped.
 *
 * A PNG in the repository would be a binary nobody can review in a diff and
 * nobody can regenerate at another size. This is thirty lines of geometry and
 * an encoder, so the icon is source: the shape is readable, the colours are
 * the page's own, and any size that turns out to be wanted is a number.
 *
 * The mark is the flag the queue uses for a finding somebody has agreed is
 * real. Of everything the page draws it is the one shape that survives being
 * sixteen pixels wide in a dock.
 */

import { crc32, deflateSync } from "node:zlib";

/** The page's dark background and its accent, so the icon is the app. */
const INK = [27, 27, 26];
const FLAG = [214, 165, 58];

/** Whether a point is inside the rounded square that fills the canvas. */
function inPlate(x: number, y: number, size: number): boolean {
  const radius = size * 0.22;
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Whether a point is on the flag: a staff, and a pennant hanging off it.
 *
 * Kept inside the middle of the canvas rather than filling it, because a
 * maskable icon is cropped to a circle on some platforms and a shape that
 * runs to the corners loses its ends.
 */
function inFlag(x: number, y: number, size: number): boolean {
  const u = x / size;
  const v = y / size;
  if (u >= 0.32 && u <= 0.385 && v >= 0.18 && v <= 0.82) return true;
  // The pennant: a triangle off the staff, so its two edges have to meet at
  // the far end. Converging by anything less leaves a blunt trapezoid, which
  // is a shape that reads as a speech bubble at the size a dock draws it.
  const tip = 0.7;
  if (u < 0.385 || u > tip || v < 0.21 || v > 0.51) return false;
  const along = (u - 0.385) / (tip - 0.385);
  return v >= 0.21 + along * 0.15 && v <= 0.51 - along * 0.15;
}

/** Three samples each way, so an edge is a gradient rather than a staircase. */
const SAMPLES = 3;

export function appIcon(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let plate = 0;
      let flag = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (inPlate(px, py, size)) plate += 1;
          if (inFlag(px, py, size)) flag += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = plate / total;
      const over = flag / total;
      const at = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        // The flag sits on the plate, so it is mixed in before the plate's own
        // edge fades out. Mixing after would show the flag through the corners.
        pixels[at + channel] = Math.round(
          (INK[channel] ?? 0) * (1 - over) + (FLAG[channel] ?? 0) * over,
        );
      }
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return png(pixels, size);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(tagged));
  return Buffer.concat([length, tagged, check]);
}

/** 8-bit RGBA, no interlacing, one filter byte per row and it is always none. */
function png(pixels: Buffer, size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const from = y * size * 4;
    pixels.copy(rows, y * (size * 4 + 1) + 1, from, from + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

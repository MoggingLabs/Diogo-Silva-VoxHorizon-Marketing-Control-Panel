import { deflateSync } from "node:zlib";

/**
 * Minimal, dependency-free PNG generator for the workflow e2e harness.
 *
 * The QA engine (`worker/src/services/qa_engine.py`) runs deterministic Pillow
 * backstops on the bytes the operator submits to `/work/pipeline/tools/qa_run`:
 *
 *   - `det.format`     — must decode as PNG or JPEG,
 *   - `det.resolution` — must meet the per-ratio minimum (1:1 ⇒ 1080×1080),
 *   - `det.file_size`  — must be in the [1 KiB, 15 MiB] band.
 *
 * The repo has no image library (no sharp/canvas), so we synthesize a valid
 * RGB PNG by hand: signature + IHDR + IDAT (zlib-deflated scanlines) + a tEXt
 * chunk used purely as padding so the encoded file clears the 1 KiB floor even
 * though a solid-colour image compresses to a few hundred bytes + IEND.
 *
 * Returns a base64 string ready to drop into the `image_b64` field of a QA
 * item, so the worker never has to download anything from Storage (no
 * `FAKE_*`-relevant network either way — this keeps the QA verdict purely a
 * function of the deterministic checks + the vision candidates we supply).
 */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Build a solid-colour RGB PNG of `size`×`size` pixels (default 1080, the 1:1
 * shippable minimum). The result is ≥1 KiB so it clears the QA file-size floor.
 */
export function makeSquarePngBase64(size = 1080): string {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth 8, colour type 2 (RGB), no interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Raw scanlines: one filter byte (0 = none) + RGB triples per row. A mid-grey
  // fill (0x80) — the colour is irrelevant; only that it decodes at full size.
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size, 0x80);
  for (let y = 0; y < size; y += 1) {
    raw[y * rowBytes] = 0; // filter type 0 (none) at the start of each scanline
  }
  const idat = deflateSync(raw);

  // tEXt padding so the encoded file is comfortably over the 1 KiB QA floor
  // regardless of how well the solid fill compresses.
  const text = Buffer.concat([
    Buffer.from("Comment\0", "latin1"),
    Buffer.from("x".repeat(1100), "latin1"),
  ]);

  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("tEXt", text),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  return png.toString("base64");
}

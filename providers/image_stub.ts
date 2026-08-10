/**
 * providers/image_stub.ts — the deterministic, offline StubImageProvider (DEFAULT).
 *
 * Sibling to providers/stub.ts. Always works: no network, no API key, no vendor SDK. Given the
 * same prompt it returns the same image (a small solid-color PNG, color derived from a
 * deterministic fingerprint of the prompt) — enough to exercise the ImageProvider seam
 * end-to-end with zero external dependencies.
 *
 * NOTE for callers: this is a placeholder pixel, not a placeholder EXPERIENCE. Product code
 * (companion/portrait_handlers.ts) treats `name === 'stub'` the same as "no provider
 * configured" and returns a clean "unavailable" response instead of surfacing this image to
 * users — exactly like the stub text provider is special-cased for companion chat.
 */
import { deflateSync } from 'node:zlib';
import type { GenerateImageOptions, ImageProvider, ImageResult } from './image_types.js';

export interface StubImageProviderOptions {
  /** Reported model id. Defaults to "stub-image-1". */
  model?: string;
  /** Side length of the generated square PNG, in pixels. Default 8 (kept tiny on purpose). */
  size?: number;
}

const DEFAULT_STUB_MODEL = 'stub-image-1';
const DEFAULT_SIZE = 8;

export class StubImageProvider implements ImageProvider {
  readonly name = 'stub';
  readonly model: string;
  private readonly size: number;

  constructor(options: StubImageProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_STUB_MODEL;
    this.size = options.size ?? DEFAULT_SIZE;
  }

  async generate(prompt: string, opts: GenerateImageOptions = {}): Promise<ImageResult> {
    const size = opts.width && opts.height ? Math.max(1, Math.min(opts.width, opts.height)) : this.size;
    const [r, g, b] = colorFromPrompt(prompt);
    const png = encodeSolidColorPng(size, size, r, g, b);
    return {
      imageBase64: png.toString('base64'),
      mimeType: 'image/png',
      model: this.model,
    };
  }
}

/** Deterministic RGB triple derived from the prompt text (FNV-1a, same style as providers/stub.ts). */
function colorFromPrompt(prompt: string): [number, number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i += 1) {
    h ^= prompt.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
}

/** Minimal, dependency-free PNG encoder for a solid-color RGB square. Standard-library only. */
function encodeSolidColorPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  const rowBytes = 1 + width * 3; // filter byte + RGB per pixel
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = pngChunk('IDAT', deflateSync(raw));

  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

let crcTable: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

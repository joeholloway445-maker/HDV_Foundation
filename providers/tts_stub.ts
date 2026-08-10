/**
 * providers/tts_stub.ts — the deterministic, offline StubTtsProvider (DEFAULT).
 *
 * Sibling to providers/image_stub.ts (a real, valid PNG) and providers/video_stub.ts (honestly
 * not a real playable video). Audio sits closer to the PNG end of that spectrum: a WAV file is
 * just a 44-byte RIFF/WAVE header plus raw PCM samples, so — unlike MP4/codec bitstreams — a
 * genuinely valid, playable (if silent) file is easy to hand-roll with zero dependencies.
 *
 * Deterministic by construction: every call returns byte-for-byte identical silence (the input
 * text has no bearing on synthetic audio content, unlike the image stub's prompt-derived color),
 * which is enough to exercise the TtsProvider seam end-to-end with zero external dependencies.
 *
 * NOTE for callers: this is a placeholder CLIP, not a placeholder EXPERIENCE. Product code
 * (companion/speak_handlers.ts) treats `name === 'stub'` the same as "no provider configured"
 * and returns a clean "unavailable" response instead of surfacing this audio to users — exactly
 * like the stub image/video providers are special-cased for companion portraits/scenes.
 */
import type { GenerateTtsOptions, TtsProvider, TtsResult } from './tts_types.js';

export interface StubTtsProviderOptions {
  /** Reported model id. Defaults to "stub-tts-1". */
  model?: string;
  /** Duration of the silent clip, in seconds. Default 0.5 (kept tiny on purpose). */
  durationSeconds?: number;
  /** Sample rate of the generated PCM data, in Hz. Default 16000. */
  sampleRate?: number;
}

const DEFAULT_STUB_MODEL = 'stub-tts-1';
const DEFAULT_DURATION_SECONDS = 0.5;
const DEFAULT_SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

export class StubTtsProvider implements TtsProvider {
  readonly name = 'stub';
  readonly model: string;
  private readonly durationSeconds: number;
  private readonly sampleRate: number;

  constructor(options: StubTtsProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_STUB_MODEL;
    this.durationSeconds = options.durationSeconds ?? DEFAULT_DURATION_SECONDS;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  }

  async generate(_text: string, _opts: GenerateTtsOptions = {}): Promise<TtsResult> {
    const wav = encodeSilentWav(this.sampleRate, this.durationSeconds);
    return {
      audioBase64: wav.toString('base64'),
      mimeType: 'audio/wav',
      model: this.model,
    };
  }
}

/**
 * Minimal, dependency-free WAV encoder for a silent (all-zero) mono PCM clip. Standard-library
 * only — no `node:zlib`-style compression needed, WAV/PCM is uncompressed by design.
 *
 * Layout (44-byte canonical header + data):
 *   "RIFF" <chunkSize> "WAVE"
 *   "fmt " <16> <PCM=1> <channels> <sampleRate> <byteRate> <blockAlign> <bitsPerSample>
 *   "data" <dataSize> <...silent samples...>
 */
function encodeSilentWav(sampleRate: number, durationSeconds: number): Buffer {
  const numSamples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = CHANNELS * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // chunk size: everything after this field
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  // Silent PCM: all-zero samples. Buffer.alloc zero-fills by default.
  const data = Buffer.alloc(dataSize);

  return Buffer.concat([header, data]);
}

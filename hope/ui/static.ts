/**
 * hope/ui/static.ts — write a rendered HOPE console transcript to a static HTML file.
 *
 * This is a filesystem convenience for demos: it dumps the self-contained HTML produced by
 * `renderTranscriptToHtml` to disk so it can be opened directly in a browser. Writing a
 * presentation file is NOT the same as HOPE creating an artifact in the system's sense — no
 * packet is routed, no tool is used, and no peer agent is touched. It is pure I/O of text
 * HOPE already voiced.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Turn } from './console.js';
import { renderTranscriptToHtml, type RenderOptions } from './render.js';

/** Default output location for the demo console page. */
export const DEFAULT_OUTPUT_PATH = '/tmp/hope-console.html';

/**
 * Render the transcript and write it to `outputPath` (creating parent dirs as needed).
 * Returns the path written.
 */
export function writeConsoleHtml(
  transcript: readonly Turn[],
  outputPath: string = DEFAULT_OUTPUT_PATH,
  options: RenderOptions = {},
): string {
  const html = renderTranscriptToHtml(transcript, options);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

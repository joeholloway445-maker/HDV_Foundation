/**
 * companion/action_string.ts — personality -> LingBot-World `--action_string` camera schedule.
 *
 * Ties the scene endpoint's camera motion to the persona's prompt/personality instead of
 * always leaving it null (free-form/no camera control). Format verified against the actual
 * parser in joeholloway445-maker/lingbot-world (wan/utils/wasd_ijkl_to_c2ws.py,
 * parse_action_string_segments): comma-separated `<keys>-<frames>` segments applied in order,
 * where keys are any of w/a/s/d (translate forward/back/strafe-left/strafe-right) and/or
 * i/j/k/l (pitch-up/yaw-left/pitch-down/yaw-right), held for <frames> frames; "none-<frames>"
 * holds the camera still. colab/08_scene_server.py always passes --frame_num (default 81,
 * satisfies LingBot's F=4n+1 requirement), and when --action_string is also given its total
 * frame count must match --frame_num exactly — buildActionString below guarantees that by
 * repeating a personality-flavoured "cell" as many whole times as fit, then padding the
 * remainder with a trailing hold.
 */
import type { CompanionPersonality } from './types.js';

/** One motion "cell" (a short segment sequence) per personality, chosen for its mood. */
const MOTION_CELLS: Record<CompanionPersonality, string[]> = {
  // Energetic, bouncy: quick forward/strafe pops with little looks, short holds between.
  playful: ['w-3', 'none-2', 'd-3', 'none-2', 'i-2', 'none-2', 'k-2', 'none-2', 'a-3', 'none-2'],
  // Slow, gentle gaze: a soft tilt up, hold, soft tilt down.
  romantic: ['none-10', 'i-4', 'none-10', 'k-4'],
  // Quick, sassy head snaps left/right.
  bratty: ['j-4', 'none-1', 'l-4', 'none-1', 'j-3', 'none-3'],
  // Steady and minimal: one deliberate slow push-in amid long stillness.
  dominant: ['none-35', 'w-6', 'none-35'],
  // Barely-perceptible tilt, like breathing.
  soft: ['none-15', 'i-2', 'none-15', 'k-2'],
  // Slow continuous pan/orbit, holding the reveal.
  mysterious: ['l-15', 'none-5'],
};

const DEFAULT_TOTAL_FRAMES = 81; // matches colab/08_scene_server.py's DEFAULT_FRAME_NUM

/**
 * Build a LingBot action_string for the given personality, whose segment durations sum to
 * exactly `totalFrames` (repeat the mood cell as many whole times as fit, pad the remainder
 * with a trailing hold) so it always matches the --frame_num the scene server passes.
 */
export function buildActionString(
  personality: CompanionPersonality,
  totalFrames: number = DEFAULT_TOTAL_FRAMES,
): string {
  const cell = MOTION_CELLS[personality] ?? MOTION_CELLS.playful;
  const cellFrames = cell.reduce((sum, seg) => sum + Number(seg.split('-').pop()), 0);

  const segments: string[] = [];
  let used = 0;
  while (cellFrames > 0 && used + cellFrames <= totalFrames) {
    segments.push(...cell);
    used += cellFrames;
  }
  const remainder = totalFrames - used;
  if (remainder > 0) segments.push(`none-${remainder}`);
  return segments.join(',');
}

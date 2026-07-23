/**
 * hope/ui/render.ts — render a HOPE conversation transcript to a single self-contained
 * HTML document (all CSS inlined; one external <link> for Google Fonts).
 *
 * This is presentation only. It renders text that HOPE already produced through its voice;
 * it makes NO execution or creation claims on HOPE's behalf. HOPE interprets and documents.
 */
import type { Turn } from './console.js';

export interface RenderOptions {
  /** Document <title> and header eyebrow. Defaults to the HOPE full name. */
  title?: string;
  /** A short tagline shown under the hero brand. */
  tagline?: string;
  /**
   * Whether this console instance can route to APEX. Purely informational — shown as a
   * status pill so a reader knows if the session is interpretation-only.
   */
  canRoute?: boolean;
  /** Timestamp string for the footer. Defaults to an ISO string of "now". */
  generatedAt?: string;
}

const BRAND = 'HOPE';
const BRAND_FULL = "Holloway's Own Providential Enterprise";

/**
 * Produce a complete, standalone HTML string for the given transcript. Safe to write to a
 * file and open directly in a browser (no build step, no local server required).
 */
export function renderTranscriptToHtml(
  transcript: readonly Turn[],
  options: RenderOptions = {},
): string {
  const title = options.title ?? BRAND_FULL;
  const tagline = options.tagline ?? 'The forward-facing voice. It interprets and documents — it does not execute or create.';
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const routePill = options.canRoute
    ? '<span class="pill pill--route">connected to APEX</span>'
    : '<span class="pill pill--local">interpretation-only</span>';

  const turnsHtml = transcript.length
    ? transcript.map((t, i) => renderTurn(t, i)).join('\n')
    : '<p class="empty">No turns yet. HOPE is listening.</p>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(BRAND)} · ${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,340;9..144,600;9..144,900&family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --ink: #eaf4ef;
    --ink-soft: rgba(234, 244, 239, 0.72);
    --ink-faint: rgba(234, 244, 239, 0.5);
    --gold: #f0cf8e;
    --gold-deep: #d8a94f;
    --line: rgba(240, 207, 142, 0.22);
    --hope-bubble: rgba(240, 207, 142, 0.10);
    --user-bubble: rgba(234, 244, 239, 0.06);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    color: var(--ink);
    font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
    font-size: 17px;
    line-height: 1.6;
    background:
      radial-gradient(1200px 800px at 12% -10%, rgba(56, 120, 108, 0.55), transparent 55%),
      radial-gradient(1000px 700px at 100% 0%, rgba(28, 74, 82, 0.6), transparent 50%),
      linear-gradient(155deg, #04161a 0%, #082826 42%, #0c3a33 100%);
    background-size: 160% 160%, 160% 160%, 100% 100%;
    background-attachment: fixed;
    animation: drift 34s ease-in-out infinite alternate;
  }
  .wrap {
    max-width: 780px;
    margin: 0 auto;
    padding: clamp(2.5rem, 6vw, 5.5rem) clamp(1.2rem, 5vw, 2rem) 4rem;
  }
  .eyebrow {
    font-size: 0.72rem;
    letter-spacing: 0.42em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 0.9rem;
  }
  .hero {
    font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
    font-weight: 900;
    font-size: clamp(4.5rem, 22vw, 11rem);
    line-height: 0.86;
    letter-spacing: -0.02em;
    margin: 0;
    background: linear-gradient(180deg, var(--gold) 0%, var(--gold-deep) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: breathe 7s ease-in-out infinite;
    transform-origin: left center;
  }
  .fullname {
    font-family: 'Fraunces', Georgia, serif;
    font-weight: 340;
    font-style: italic;
    font-size: clamp(1.1rem, 3.4vw, 1.5rem);
    color: var(--ink);
    margin: 0.4rem 0 0.2rem;
  }
  .tagline {
    max-width: 46ch;
    color: var(--ink-soft);
    margin: 0.7rem 0 1.4rem;
  }
  .pill {
    display: inline-block;
    font-size: 0.72rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    padding: 0.35em 0.85em;
    border-radius: 999px;
    border: 1px solid var(--line);
  }
  .pill--local { color: var(--ink-soft); }
  .pill--route { color: var(--gold); border-color: rgba(240, 207, 142, 0.45); }

  .composer {
    margin: 2rem 0 2.8rem;
    display: flex;
    gap: 0.6rem;
    align-items: stretch;
    border-bottom: 1px solid var(--line);
    padding-bottom: 1.1rem;
  }
  .composer input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--ink);
    font-family: inherit;
    font-size: 1.05rem;
    padding: 0.6rem 0.2rem;
  }
  .composer input::placeholder { color: var(--ink-faint); }
  .composer input:focus { outline: none; }
  .composer .send {
    font-family: inherit;
    font-size: 0.8rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #05201d;
    background: linear-gradient(180deg, var(--gold) 0%, var(--gold-deep) 100%);
    border: none;
    border-radius: 999px;
    padding: 0 1.4rem;
    cursor: default;
  }

  .transcript { display: flex; flex-direction: column; gap: 1.15rem; }
  .turn {
    opacity: 0;
    animation: rise 0.6s ease forwards;
  }
  .turn .who {
    font-size: 0.68rem;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin: 0 0 0.35rem;
  }
  .turn .line {
    padding: 0.85rem 1.1rem;
    border-radius: 14px;
    border: 1px solid transparent;
  }
  .turn--user .line {
    background: var(--user-bubble);
    border-color: rgba(234, 244, 239, 0.08);
  }
  .turn--hope .who { color: var(--gold-deep); }
  .turn--hope .line {
    background: var(--hope-bubble);
    border-color: var(--line);
    font-family: 'Fraunces', Georgia, serif;
    font-weight: 340;
    font-size: 1.12rem;
  }
  .empty { color: var(--ink-faint); font-style: italic; }

  footer {
    margin-top: 3.5rem;
    padding-top: 1.2rem;
    border-top: 1px solid var(--line);
    color: var(--ink-faint);
    font-size: 0.8rem;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  @keyframes breathe {
    0%, 100% { transform: scale(1); filter: brightness(1); }
    50% { transform: scale(1.012); filter: brightness(1.08); letter-spacing: -0.018em; }
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes drift {
    from { background-position: 0% 0%, 100% 0%, 0 0; }
    to { background-position: 30% 40%, 70% 30%, 0 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    body, .hero, .turn { animation: none; }
    .turn { opacity: 1; }
  }
</style>
</head>
<body>
  <main class="wrap">
    <p class="eyebrow">${escapeHtml(title)}</p>
    <h1 class="hero">${escapeHtml(BRAND)}</h1>
    <p class="fullname">${escapeHtml(BRAND_FULL)}</p>
    <p class="tagline">${escapeHtml(tagline)}</p>
    ${routePill}

    <form class="composer" onsubmit="return false" aria-label="Speak to HOPE">
      <input type="text" placeholder="Say something to HOPE…" aria-label="Your message" />
      <button type="button" class="send">Interpret</button>
    </form>

    <section class="transcript" aria-live="polite">
${turnsHtml}
    </section>

    <footer>
      <span>HOPE interprets and documents. It does not execute or create.</span>
      <span>Rendered ${escapeHtml(generatedAt)}</span>
    </footer>
  </main>
</body>
</html>`;
}

function renderTurn(turn: Turn, index: number): string {
  const who = turn.role === 'user' ? 'You' : BRAND;
  const delay = `style="animation-delay:${(index * 0.08).toFixed(2)}s"`;
  return `      <article class="turn turn--${turn.role}" ${delay}>
        <p class="who">${escapeHtml(who)}</p>
        <div class="line">${escapeHtml(turn.text)}</div>
      </article>`;
}

/** Escape a string for safe interpolation into HTML text / attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

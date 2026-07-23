/**
 * demo/run_hope_ui_demo.ts — HOPE forward-facing console demo.
 *
 * Shows HOPE's console as the UI/UX voice: it accepts utterances, interprets and documents
 * them, replies in HOPE's voice, and renders the conversation to a single self-contained HTML
 * page written to disk. This demo runs in interpretation-only mode — NO `sendViaApex` transport
 * is injected — so HOPE routes nothing, executes nothing, and creates nothing in the system.
 *
 * Run: npm run demo:hope-ui
 */
import { HopeConsole, writeConsoleHtml } from '../hope/ui/index.js';

function hr(title: string): void {
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

function main(): void {
  hr('BIG 5 MATRIX — HOPE CONSOLE DEMO (interpret · document · voice — no execution)');

  // Interpretation-only: no transport injected, so HOPE never routes to APEX.
  const hope = new HopeConsole();
  console.log(`Console mode: ${hope.canRoute ? 'connected to APEX' : 'interpretation-only'}`);

  const utterances = [
    'Simulate how "Project Atlas" could launch, I want to reach 1000 users without spending over $500',
    'Explain how the routing between agents actually works',
    'Please document that we decided to defer the "Beta" rollout until next quarter',
    'urgently run and deploy the whole pipeline right now',
    'hmm, maybe do the thing',
  ];

  for (const utterance of utterances) {
    const turn = hope.say(utterance);
    console.log(`\nYou : ${turn.user.text}`);
    console.log(`HOPE: ${turn.hope.text}`);
    console.log(
      `      [kind=${turn.intent.kind} confidence=${turn.intent.confidence} ` +
        `clarify=${turn.clarificationRequested} routed=${turn.dispatch ? 'yes' : 'no'}]`,
    );
  }

  hr('DOCUMENTATION');
  console.log(`Documented intents: ${hope.documentCount()}`);
  for (const doc of hope.documents()) {
    console.log(`  · ${doc.kind.padEnd(9)} -> ${doc.suggestedDestination.padEnd(6)} "${doc.utterance}"`);
  }

  hr('RENDER');
  const outputPath = process.env.HOPE_CONSOLE_OUT ?? '/tmp/hope-console.html';
  const written = writeConsoleHtml(hope.transcript(), outputPath, { canRoute: hope.canRoute });
  console.log(`Wrote self-contained HTML console to: ${written}`);
  console.log('Open it in a browser to see the HOPE brand hero, input area, and transcript.');

  hr('HOPE CONSOLE DEMO COMPLETE — nothing executed, nothing created; interpretation only.');
}

main();

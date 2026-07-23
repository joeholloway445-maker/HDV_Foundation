/**
 * hope/ui/console.ts — HOPE's forward-facing console.
 *
 * A thin, presentation-layer coordinator around HOPE's existing interpretation stack:
 * IntentInterpreter (parse), HopeDocumenter (record), and HopeVoice (speak). It keeps a
 * turn-by-turn conversation transcript so a renderer can present it as text or HTML.
 *
 * CONSTRAINTS (inherited from HOPE; enforced by construction here):
 *   - HOPE CANNOT execute and CANNOT create. The console interprets, documents, and voices.
 *   - The console imports NO peer agent (no DREAM, no VISION). Its only route to the rest of
 *     the system is an optional, dependency-injected `sendViaApex` callback. When that callback
 *     is absent, the console never routes anything — it only documents and speaks.
 *   - Routing (when a callback IS provided) still goes HOPE -> APEX; APEX (after KNOLL) decides.
 */
import {
  IntentInterpreter,
  HopeDocumenter,
  HopeVoice,
  type StructuredIntent,
  type IntentDocument,
  type SendViaApex,
} from '../index.js';
import type { DispatchResult } from '../../apex/index.js';

/** Who spoke a given line in the transcript. */
export type TurnRole = 'user' | 'hope';

/** A single line in the conversation transcript. */
export interface Turn {
  role: TurnRole;
  text: string;
  at: number;
}

/** The full result of handling one user utterance. */
export interface ConsoleTurn {
  /** The user's line as recorded. */
  user: Turn;
  /** HOPE's reply line as recorded. */
  hope: Turn;
  /** The parsed intent behind HOPE's reply. */
  intent: StructuredIntent;
  /** The documented (persisted) form of the intent. */
  document: IntentDocument;
  /**
   * The APEX dispatch result, present only when a `sendViaApex` callback was injected AND
   * the intent was confident enough to route. Absent in interpretation-only mode.
   */
  dispatch?: DispatchResult;
  /** True when HOPE asked the user to clarify instead of proceeding. */
  clarificationRequested: boolean;
}

export interface HopeConsoleOptions {
  interpreter?: IntentInterpreter;
  documenter?: HopeDocumenter;
  voice?: HopeVoice;
  /**
   * Optional transport to APEX. If provided, confident intents are submitted HOPE -> APEX and
   * the resulting status is voiced. If omitted, the console documents + voices only and never
   * routes — HOPE remains interpretation-only.
   */
  sendViaApex?: SendViaApex;
}

export class HopeConsole {
  private readonly interpreter: IntentInterpreter;
  private readonly documenter: HopeDocumenter;
  private readonly voice: HopeVoice;
  private readonly sendViaApex?: SendViaApex;
  private readonly turns: Turn[] = [];

  constructor(options: HopeConsoleOptions = {}) {
    this.interpreter = options.interpreter ?? new IntentInterpreter();
    this.documenter = options.documenter ?? new HopeDocumenter();
    this.voice = options.voice ?? new HopeVoice();
    this.sendViaApex = options.sendViaApex;
  }

  /** True when this console can route through APEX (a callback was injected). */
  get canRoute(): boolean {
    return this.sendViaApex !== undefined;
  }

  /**
   * Accept a user utterance. HOPE interprets it, documents it, and replies with its voice.
   * When a `sendViaApex` callback is present and the intent is confident, HOPE also submits
   * the intent HOPE -> APEX and voices the returned status. Never executes or creates.
   */
  say(utterance: string): ConsoleTurn {
    const user = this.record('user', utterance);

    const intent = this.interpreter.interpret(utterance);
    const document = this.documenter.document(intent);

    let replyText: string;
    let dispatch: DispatchResult | undefined;
    let clarificationRequested = false;

    if (intent.clarificationNeeded) {
      // Low confidence: HOPE clarifies rather than guessing. Clarifying is interpretation,
      // never execution — so nothing is routed even if a transport is available.
      replyText = this.voice.clarify(intent);
      clarificationRequested = true;
    } else if (this.sendViaApex) {
      // A transport is available and the intent is confident: ask APEX to route (HOPE -> APEX).
      const submitted = this.interpreter.submit(utterance, this.sendViaApex);
      dispatch = submitted.result;
      replyText = dispatch ? this.voice.status(dispatch) : this.voice.acknowledge(intent);
    } else {
      // Interpretation-only mode: acknowledge and reflect the intent, route nothing.
      replyText = this.voice.acknowledge(intent);
    }

    const hope = this.record('hope', replyText);
    return { user, hope, intent, document, dispatch, clarificationRequested };
  }

  /** A read-only snapshot of the conversation transcript. */
  transcript(): readonly Turn[] {
    return this.turns.slice();
  }

  /** All intents documented by this console so far. */
  documents(): IntentDocument[] {
    return this.documenter.all();
  }

  /** Number of documented intents. */
  documentCount(): number {
    return this.documenter.count();
  }

  private record(role: TurnRole, text: string): Turn {
    const turn: Turn = { role, text, at: Date.now() };
    this.turns.push(turn);
    return turn;
  }
}

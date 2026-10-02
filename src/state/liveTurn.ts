// One reply in progress, and what a newer text from the same person does to it.
//
// A person texting in a burst means the whole burst. Nothing of a reply that has not reached their
// screen when their next text lands is ever sent: the burst is answered once, latest text included.
//
// Phases:
//   • waiting   — queued for the chat mouth. A text landing now is folded in when the turn takes the
//                 mouth (the late-arrival drain in index.ts), so there is nothing to replace.
//   • thinking  — folded and writing, nothing real yet. A newer text aborts it: the run goes back in
//                 the queue ahead of that text and the turn's history rows are taken back.
//   • committed — a tool acted (a reminder set, a memory written) but nothing reached their screen.
//   • speaking  — something reached their screen.
// From committed on, a newer text STOPS the reply: whatever has not gone out is dropped, the history
// row is cut to what they saw, and the newer text is the next turn. Every transition is synchronous,
// so a bubble is never both on its way out and dropped.

export class TurnSupersededError extends Error {
  constructor() {
    super('superseded by a newer message');
    this.name = 'TurnSupersededError';
  }
}

/** What `chat()` sees of the live turn. */
export interface TurnSupersede {
  /** Aborted when a newer text replaces the turn; every model call of the turn carries it. */
  readonly signal: AbortSignal;
  /** A tool is about to act on the world. False when the turn was already replaced. */
  commit(): boolean;
  /** A history row this turn wrote, so a replaced or stopped turn can take it back. */
  noteRow(role: 'user' | 'assistant', content: string, at: number): void;
}

export interface TurnRow { role: 'user' | 'assistant'; content: string; at: number }

export class LiveTurn implements TurnSupersede {
  private phase: 'waiting' | 'thinking' | 'committed' | 'speaking' = 'waiting';
  private readonly ctl = new AbortController();
  private stoppedFlag = false;
  readonly rows: TurnRow[] = [];

  constructor(readonly from: string) {}

  get signal(): AbortSignal { return this.ctl.signal; }
  /** A newer text arrived after the turn committed: nothing more of it goes out. */
  get stopped(): boolean { return this.stoppedFlag; }

  /** Everything queued has been folded in and the turn starts writing. */
  arm(): void {
    if (this.phase === 'waiting') this.phase = 'thinking';
  }

  commit(): boolean {
    if (this.ctl.signal.aborted) return false;
    if (this.phase === 'waiting' || this.phase === 'thinking') this.phase = 'committed';
    return true;
  }

  /** The last moment before one thing reaches their screen: false means drop it. */
  show(): boolean {
    if (this.ctl.signal.aborted || this.stoppedFlag) return false;
    this.phase = 'speaking';
    return true;
  }

  noteRow(role: 'user' | 'assistant', content: string, at: number): void {
    this.rows.push({ role, content, at });
  }

  /** A newer text from `from` arrived. */
  supersedeBy(from: string): 'replaced' | 'stopped' | null {
    if (from !== this.from || this.phase === 'waiting') return null;
    if (this.phase === 'thinking') {
      this.ctl.abort(new TurnSupersededError());
      return 'replaced';
    }
    this.stoppedFlag = true;
    return 'stopped';
  }
}

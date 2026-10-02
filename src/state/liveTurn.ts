// One reply in progress, and whether a newer text from the same person may still replace it.
//
// A person texting in a burst means the whole burst. A reply already being written when the next
// text lands answers a version of the conversation they have since moved past, so while nothing of
// it is real yet (no bubble on their screen, no tool run, nothing recorded as said) it is dropped
// and the burst is answered once, latest text included.
//
// Three phases:
//   • waiting   — queued for the chat mouth. A text landing now is folded in when the turn takes the
//                 mouth (the late-arrival drain in index.ts), so there is nothing to replace.
//   • thinking  — folded and writing. A newer text from the same sender aborts it.
//   • committed — something of the reply became real: the first early bubble, or the draft coming
//                 back and being acted on. It finishes, and the newer text is the next turn.
// The commit and the supersede both run synchronously, so there is no window in which a reply is
// both on its way out and aborted.

export class TurnSupersededError extends Error {
  constructor() {
    super('superseded by a newer message');
    this.name = 'TurnSupersededError';
  }
}

/** What `chat()` sees of the live turn: the signal its model calls carry, and the commit point. */
export interface TurnSupersede {
  readonly signal: AbortSignal;
  /** Something of the reply is about to become real. False when the turn was already replaced. */
  commit(): boolean;
}

export class LiveTurn implements TurnSupersede {
  private phase: 'waiting' | 'thinking' | 'committed' = 'waiting';
  private readonly ctl = new AbortController();

  constructor(readonly from: string) {}

  get signal(): AbortSignal { return this.ctl.signal; }

  /** Everything queued has been folded in and the turn starts writing. */
  arm(): void {
    if (this.phase === 'waiting') this.phase = 'thinking';
  }

  commit(): boolean {
    if (this.ctl.signal.aborted) return false;
    this.phase = 'committed';
    return true;
  }

  /** A newer text from `from` arrived. Replaces this reply when it is still only being written. */
  supersedeBy(from: string): boolean {
    if (this.phase !== 'thinking' || from !== this.from) return false;
    this.ctl.abort(new TurnSupersededError());
    return true;
  }
}

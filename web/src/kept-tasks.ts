/**
 * First tasks the bridge couldn't deliver to a just-started agent (e.g. it was still
 * on a startup dialog), kept per pane until they are sent. Pure state, no DOM: app.ts
 * mirrors the pane's composer into it (`edit`), asks it what a rebuilt composer should
 * show (`draft`), and brackets each send with `beginSend` / `finishSend`.
 */

interface Kept {
  /** what the pane's composer should show: the task, as the user has edited it */
  draft: string;
  /** the send in flight, and whether the user edited the composer since it began */
  sending: { token: number; text: string; edited: boolean } | null;
}

/** The task to keep after `POST /api/agents`, or null when it was delivered or there was none. */
export function taskToKeep(
  res: { paneId?: string; taskDelivered?: boolean },
  task: string,
): { paneId: string; text: string } | null {
  return res.taskDelivered === false && task !== '' && res.paneId ? { paneId: res.paneId, text: task } : null;
}

export class KeptTasks {
  private kept = new Map<string, Kept>();
  private nextToken = 1;

  keep(paneId: string, text: string): void {
    this.kept.set(paneId, { draft: text, sending: null });
  }

  /** What a freshly built composer for the pane should show; null when nothing is kept. */
  draft(paneId: string): string | null {
    return this.kept.get(paneId)?.draft ?? null;
  }

  /** The user changed the pane's composer. Ignored for panes with nothing kept. */
  edit(paneId: string, text: string): void {
    const k = this.kept.get(paneId);
    if (!k) return;
    k.draft = text;
    if (k.sending) k.sending.edited = true;
  }

  /**
   * A send of `text` from the pane's composer starts. While it is in flight a reopened
   * composer shows no task, so it can't be sent twice. Returns the token for
   * finishSend, or null when nothing is kept for the pane.
   */
  beginSend(paneId: string, text: string): number | null {
    const k = this.kept.get(paneId);
    if (!k) return null;
    const token = this.nextToken++;
    k.sending = { token, text, edited: false };
    if (k.draft === text) k.draft = '';
    return token;
  }

  /**
   * The send finished. If the user edited the composer meanwhile, their text stays kept
   * as typed. Otherwise a success stops keeping the task, and a failure keeps it again
   * and returns it for the displayed composer to show. Returns null when the composer
   * should be left alone (also for a send that a newer one has superseded).
   */
  finishSend(paneId: string, token: number, ok: boolean): string | null {
    const k = this.kept.get(paneId);
    if (!k?.sending || k.sending.token !== token) return null;
    const { text, edited } = k.sending;
    k.sending = null;
    if (edited) return null;
    if (ok) {
      this.kept.delete(paneId);
      return null;
    }
    k.draft = text;
    return text;
  }
}

/**
 * First tasks the bridge couldn't deliver to a just-started agent (e.g. it was still
 * on a startup dialog), kept per pane until they are sent. Pure state, no DOM: the
 * composer (ui/Pane.tsx) mirrors itself into it (`edit`), asks it what a rebuilt composer should
 * show (`draft`), and brackets each send with `beginSend` / `finishSend`.
 *
 * While a kept task's send is in flight (`sending`), the composer is locked
 * — in every view of the pane, including one reopened meanwhile — so the task can't be
 * edited or sent a second time before the outcome is known.
 */

interface Kept {
  /** what the pane's composer should show: the task, as the user has edited it */
  draft: string;
  /** the text of the send in flight, if any */
  sending: string | null;
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
    if (k) k.draft = text;
  }

  /** Whether a send of the pane's kept task is in flight (its composer stays locked). */
  sending(paneId: string): boolean {
    return this.kept.get(paneId)?.sending != null;
  }

  /**
   * A send of `text` from the pane's composer starts. Returns false (and does nothing)
   * when nothing is kept for the pane; otherwise call finishSend when it completes.
   * Meanwhile a reopened composer shows no task, so it can't be sent twice.
   */
  beginSend(paneId: string, text: string): boolean {
    const k = this.kept.get(paneId);
    if (!k) return false;
    k.sending = text;
    k.draft = '';
    return true;
  }

  /**
   * The send finished. A success stops keeping the task; a failure keeps it again and
   * returns it, for the pane's displayed composer to show. Returns null otherwise.
   */
  finishSend(paneId: string, ok: boolean): string | null {
    const k = this.kept.get(paneId);
    if (k?.sending == null) return null;
    const text = k.sending;
    k.sending = null;
    if (ok) {
      this.kept.delete(paneId);
      return null;
    }
    k.draft = text;
    return text;
  }
}

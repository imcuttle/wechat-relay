import type { ChatMessage } from '@shared/types';

/** After a compaction the window keeps this share of the limits, then grows again until it hits them. */
const KEEP = 0.5;

export interface WindowLimits { limit: number; minutes: number }
export interface WindowResult { history: ChatMessage[]; dropped: number }

/**
 * Per-chat context window whose start only moves in batches (like context compaction).
 *
 * A sliding window drops the oldest message on every new one, which changes the start of the prompt and defeats
 * the model's prefix cache. Here the start stays pinned while the window is within the limits (historyLimit
 * messages, historyMinutes age); once a limit is exceeded, the old part is dropped at once down to KEEP of the
 * limits. Between compactions every run only appends, so the cached prefix keeps being hit. Dropped messages
 * are still readable through the get_chat_history tool.
 */
export class ContextWindows {
  private starts = new Map<string, string>();

  select(chat: string, all: ChatMessage[], incoming: ChatMessage[], { limit, minutes }: WindowLimits, now = Date.now()): WindowResult {
    const n = all.length;
    if (!n) return { history: [], dropped: 0 };
    const maxAge = minutes > 0 ? minutes * 60000 : 0;
    const fits = (i: number) => n - i <= limit && (!maxAge || all[i].at >= now - maxAge);
    /** Earliest start whose window is within `scale` × the limits. */
    const startFor = (scale: number) => {
      let i = Math.max(0, n - Math.max(1, Math.floor(limit * scale)));
      if (maxAge) { const cut = now - maxAge * scale; while (i < n - 1 && all[i].at < cut) i++; }
      return i;
    };

    const prevId = this.starts.get(chat);
    const prev = prevId ? all.findIndex((m) => m.id === prevId) : -1;
    let start = prev;
    let dropped = 0;
    if (prev < 0) start = startFor(1); // first run (or history cleared): the full window
    else if (!fits(prev)) { start = Math.min(n - 1, Math.max(prev + 1, startFor(KEEP))); dropped = start - prev; }
    // The messages being answered are always part of the context.
    const firstIncoming = all.findIndex((m) => incoming.some((x) => x.id === m.id));
    if (firstIncoming >= 0) start = Math.min(start, firstIncoming);
    this.starts.set(chat, all[start].id);
    return { history: all.slice(start), dropped };
  }
}

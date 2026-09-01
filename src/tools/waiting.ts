// "What's waiting on me?" — a pure heuristic over recent messages, so the agent can ask
// one question and get the list, instead of reading every channel and guessing.
//
// A message is waiting on the human when it is addressed to them (mentions a name or
// their npub), replies to something they wrote, or asks a question in a channel they
// are in — and the human has not answered it since. Cheap on purpose: it is a starting
// list for drafts the human will rule on, not a verdict.

import type { ViewMessage } from "./types.ts";

export type WaitingReason = "mention" | "reply-to-you" | "question";

export type WaitingItem = ViewMessage & {
  channelId: string;
  channelName?: string;
  reason: WaitingReason;
};

export type WaitingInput = {
  channelId: string;
  channelName?: string;
  messages: ViewMessage[];
};

export function waitingOnMe(
  channels: WaitingInput[],
  me: { pubkey: string; names: string[] },
  opts: { since?: number; limit?: number } = {},
): WaitingItem[] {
  const names = me.names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3);
  const out: WaitingItem[] = [];
  for (const ch of channels) {
    const sorted = [...ch.messages].sort((a, b) => a.created_at - b.created_at);
    const mine = sorted.filter((m) => m.pubkey === me.pubkey);
    const myIds = new Set(mine.map((m) => m.id));
    for (const m of sorted) {
      if (m.pubkey === me.pubkey) continue;
      if (opts.since && m.created_at < opts.since) continue;
      const text = m.content.toLowerCase();
      let reason: WaitingReason | null = null;
      if (names.some((n) => text.includes(n))) reason = "mention";
      else if ((m.replyTo && myIds.has(m.replyTo)) || (m.rootId && myIds.has(m.rootId))) reason = "reply-to-you";
      else if (/\?/.test(m.content) || /^(does|can|could|would|should|is|are|who|what|when|where|why|how|any(one|body))\b/i.test(m.content.trim())) reason = "question";
      if (!reason) continue;
      const threadRoot = m.rootId ?? m.id;
      const answered = mine.some(
        (r) => r.created_at > m.created_at && (r.replyTo === m.id || r.rootId === threadRoot || r.rootId === m.id),
      );
      if (answered) continue;
      out.push({ ...m, channelId: ch.channelId, channelName: ch.channelName, reason });
    }
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out.slice(0, opts.limit ?? 20);
}

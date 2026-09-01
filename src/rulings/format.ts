// What a proposal looks like when it is posted into the human's private drafts channel,
// and what the receipt looks like once they have ruled. Plain text: Buzz renders it as
// a normal message, and so does any other NIP-29 client.

import type { Proposal } from "../proposals/store.ts";

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function heading(p: Proposal): string {
  const ch = p.channelName ? `#${p.channelName}` : "the channel";
  switch (p.draft.kind) {
    case "message":
      return `Post in ${ch}`;
    case "reply":
      return `Reply in ${ch}`;
    case "reaction":
      return `React ${p.draft.emoji} in ${ch}`;
    case "topic":
      return `Set topic of ${ch}`;
    case "join":
      return `Join ${ch}`;
  }
}

function body(p: Proposal): string {
  switch (p.draft.kind) {
    case "message":
    case "reply":
      return p.draft.content;
    case "reaction":
      return "";
    case "topic":
      return p.draft.topic;
    case "join":
      return p.draft.reason;
  }
}

export function formatDraftPost(p: Proposal, targetAuthor?: string): string {
  const lines: string[] = [`🐝 Proposal #${p.id} · ${heading(p)}`];
  if (p.target) lines.push(`↳ ${targetAuthor ?? p.target.pubkey.slice(0, 8)}: “${oneLine(p.target.content, 120)}”`);
  const text = body(p);
  if (text) lines.push("", text);
  lines.push("");
  const editable = p.draft.kind === "message" || p.draft.kind === "reply";
  lines.push(
    editable
      ? "React ✅ to sign & send · ❌ to reject · or reply here with the text you'd rather send."
      : "React ✅ to sign · ❌ to reject.",
  );
  return lines.join("\n");
}

export type Outcome = { kind: "sent"; eventId: string; edited: boolean } | { kind: "rejected" } | { kind: "failed"; error: string };

export function formatOutcome(p: Proposal, outcome: Outcome): string {
  switch (outcome.kind) {
    case "sent":
      return `✅ Signed & sent${outcome.edited ? " with your edit" : ""} · event ${outcome.eventId.slice(0, 8)}… · #${p.channelName ?? "?"}`;
    case "rejected":
      return "❌ Rejected · nothing was signed";
    case "failed":
      return `⚠️ Could not send: ${outcome.error}`;
  }
}

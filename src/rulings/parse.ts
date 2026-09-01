// Reading a ruling off the wire. A ruling arrives from Buzz as a kind:7 reaction on the
// draft post, or as a reply under it. Deliberately narrow: ✅ signs, ❌ rejects, and
// anything else that is a reaction is ignored — a 👍 is a 👍, not a signature.

export type Verdict = { kind: "sign" } | { kind: "reject" } | { kind: "edit"; content: string } | null;

const SIGN = new Set(["✅", "✔", "☑", "+", ":white_check_mark:", ":heavy_check_mark:", ":ballot_box_with_check:"]);
const REJECT = new Set(["❌", "✖", "🚫", "⛔", "-", ":x:", ":heavy_multiplication_x:", ":no_entry_sign:", ":no_entry:"]);

/** Strip variation selectors and whitespace so "✔️" and "✔" agree. */
export function normalizeReaction(content: string): string {
  return content.replace(/[︎️]/g, "").trim();
}

export function verdictFromReaction(content: string): Verdict {
  const c = normalizeReaction(content);
  if (SIGN.has(c)) return { kind: "sign" };
  if (REJECT.has(c)) return { kind: "reject" };
  return null;
}

/**
 * A reply under the draft. A bare ✅/❌ means the same as the reaction; any other
 * text is "send this instead" — the human edited the draft from Buzz.
 */
export function verdictFromReply(content: string): Verdict {
  const asReaction = verdictFromReaction(content);
  if (asReaction) return asReaction;
  const text = content.trim();
  return text ? { kind: "edit", content: text } : null;
}

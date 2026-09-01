// The Waggles dock's memory. A proposal is a draft with a status; approving
// one is the only path from "an agent said so" to "a signed event exists",
// and it runs through the human's signer exactly once.

import {
  buildJoinRequest,
  buildMessage,
  buildReaction,
  buildReply,
  buildTopic,
} from "../relay/events.ts";
import type { Message, SignedEvent, Signer, UnsignedEvent } from "../relay/types.ts";
import type { Draft, ProposalReceipt } from "../tools/types.ts";

export type ProposalStatus = "pending" | "sent" | "rejected" | "failed";

export type Proposal = {
  id: number;
  draft: Draft;
  summary: string;
  status: ProposalStatus;
  proposedBy: "webmcp";
  createdAt: number;
  eventId?: string;
  error?: string;
  /** For replies and reactions: the message the draft points at, resolved at proposal time. */
  target?: Pick<Message, "id" | "pubkey" | "rootId" | "content">;
  channelName?: string;
};

export type ProposalDeps = {
  sign: Signer;
  publish(event: SignedEvent): Promise<string>;
  resolveMessage(id: string): Message | undefined;
  resolveChannelName(id: string): string | undefined;
  now?: () => number;
};

type Listener = () => void;

export function summarize(draft: Draft, channelName?: string, target?: { content: string }): string {
  const ch = channelName ? `#${channelName}` : "the channel";
  const quote = target ? ` to “${truncate(target.content, 40)}”` : "";
  switch (draft.kind) {
    case "message":
      return `Post in ${ch}: “${truncate(draft.content, 60)}”`;
    case "reply":
      return `Reply${quote} in ${ch}: “${truncate(draft.content, 60)}”`;
    case "reaction":
      return `React ${draft.emoji}${quote} in ${ch}`;
    case "topic":
      return `Set topic of ${ch} to “${truncate(draft.topic, 60)}”`;
    case "join":
      return `Join ${ch}${draft.reason ? ` — “${truncate(draft.reason, 40)}”` : ""}`;
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export class ProposalStore {
  private items: Proposal[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();

  private deps: ProposalDeps;

  constructor(deps: ProposalDeps) {
    this.deps = deps;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stable snapshot for useSyncExternalStore. */
  snapshot(): readonly Proposal[] {
    return this.items;
  }

  pendingCount(): number {
    return this.items.filter((p) => p.status === "pending").length;
  }

  get(id: number): Proposal | undefined {
    return this.items.find((p) => p.id === id);
  }

  propose(draft: Draft): ProposalReceipt {
    const target =
      draft.kind === "reply"
        ? this.deps.resolveMessage(draft.parentId)
        : draft.kind === "reaction"
          ? this.deps.resolveMessage(draft.targetId)
          : undefined;
    const channelName = this.deps.resolveChannelName(draft.channelId);
    const summary = summarize(draft, channelName, target);
    const proposal: Proposal = {
      id: this.nextId++,
      draft,
      summary,
      status: "pending",
      proposedBy: "webmcp",
      createdAt: (this.deps.now ?? Date.now)(),
      channelName,
      ...(target
        ? { target: { id: target.id, pubkey: target.pubkey, rootId: target.rootId, content: target.content } }
        : {}),
    };
    this.items = [proposal, ...this.items];
    this.emit();
    return { proposalId: proposal.id, summary };
  }

  /** The human edited the text on the card. Only pending proposals are editable. */
  edit(id: number, patch: Partial<Record<"content" | "topic" | "emoji" | "reason", string>>): void {
    this.update(id, (p) => {
      if (p.status !== "pending") return p;
      const draft = { ...p.draft, ...pickForKind(p.draft.kind, patch) } as Draft;
      return { ...p, draft, summary: summarize(draft, p.channelName, p.target) };
    });
  }

  reject(id: number): void {
    this.update(id, (p) => (p.status === "pending" ? { ...p, status: "rejected" } : p));
  }

  /**
   * Sign and publish. Builds the event fresh from the (possibly edited)
   * draft, stamps provenance, signs once, publishes once.
   */
  async approve(id: number): Promise<SignedEvent | null> {
    const p = this.get(id);
    if (!p || p.status !== "pending") return null;
    let signed: SignedEvent;
    try {
      const unsigned = this.toEvent(p);
      signed = await this.deps.sign(unsigned);
      const eventId = await this.deps.publish(signed);
      this.update(id, (cur) => ({ ...cur, status: "sent", eventId: eventId || signed.id }));
      return signed;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.update(id, (cur) => ({ ...cur, status: "failed", error }));
      return null;
    }
  }

  /** Retry a failed one by putting it back on the table. */
  retry(id: number): void {
    this.update(id, (p) => (p.status === "failed" ? { ...p, status: "pending", error: undefined } : p));
  }

  toEvent(p: Proposal): UnsignedEvent {
    const prov = { proposalId: p.id };
    const d = p.draft;
    switch (d.kind) {
      case "message":
        return buildMessage(d.channelId, d.content, prov);
      case "reply": {
        const parent = p.target ?? this.deps.resolveMessage(d.parentId);
        if (!parent) throw new Error(`Cannot find the message ${d.parentId} this reply points at.`);
        return buildReply(d.channelId, d.content, parent, prov);
      }
      case "reaction": {
        const target = p.target ?? this.deps.resolveMessage(d.targetId);
        if (!target) throw new Error(`Cannot find the message ${d.targetId} this reaction points at.`);
        return buildReaction(d.channelId, target, d.emoji, prov);
      }
      case "topic":
        return buildTopic(d.channelId, d.topic, prov);
      case "join":
        return buildJoinRequest(d.channelId, d.reason, prov);
    }
  }

  private update(id: number, fn: (p: Proposal) => Proposal): void {
    let changed = false;
    this.items = this.items.map((p) => {
      if (p.id !== id) return p;
      const next = fn(p);
      changed = changed || next !== p;
      return next;
    });
    if (changed) this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

function pickForKind(
  kind: Draft["kind"],
  patch: Partial<Record<"content" | "topic" | "emoji" | "reason", string>>,
): Record<string, string> {
  const allowed: Record<Draft["kind"], (keyof typeof patch)[]> = {
    message: ["content"],
    reply: ["content"],
    reaction: ["emoji"],
    topic: ["topic"],
    join: ["reason"],
  };
  const out: Record<string, string> = {};
  for (const k of allowed[kind]) if (patch[k] !== undefined) out[k] = patch[k] as string;
  return out;
}

// Rule from Buzz. Every pending proposal is also posted into a private drafts channel on
// the relay, under the human's own key. The human rules on it from any Nostr client —
// Buzz desktop, Buzz mobile — with a reaction or a reply; that ruling is itself a signed
// event by them. This tab, wherever it is open, sees the ruling and does the one thing only
// it can do: sign the real message with the key that never left the browser.
//
// The controller is framework-free and talks to narrow deps so it can be tested with a
// fake relay and a fake proposals store.

import type { Proposal, ProposalStore } from "../proposals/store.ts";
import { buildDraftPost, buildGroupCreate, buildOutcomePost, DRAFT_TAG } from "../relay/events.ts";
import type { Message, RelayClient, Signer } from "../relay/types.ts";
import { type Outcome, formatDraftPost, formatOutcome } from "./format.ts";
import { verdictFromReaction, verdictFromReply } from "./parse.ts";

export const DRAFTS_CHANNEL_NAME = "waggle-drafts";
export const DRAFTS_CHANNEL_ABOUT =
  "Your private drafts. Waggle posts every agent proposal here; react ✅ to sign, ❌ to reject, or reply with the text you'd rather send.";

export type RulingsState = {
  enabled: boolean;
  channelId: string | null;
  /**
   * proposalId → the draft post for it. `createdAt` is the proposal's own creation time and
   * must match before the record is trusted: it is what stops a ruling on an old draft
   * from landing on a new proposal that happens to share the id.
   */
  posted: Record<number, { draftId: string; createdAt: number }>;
  /** proposals that were ruled from Buzz rather than from the card */
  ruledFromBuzz: Record<number, "sign" | "reject" | "edit">;
  busy: boolean;
  error: string | null;
};

/** How often to ask the relay for rulings on pending drafts. Live fan-out is not reliable (see relay/types.ts). */
export const POLL_MS = 3000;

export type RulingsDeps = {
  relay: Pick<
    RelayClient,
    "listChannels" | "publish" | "subscribeReactions" | "subscribeChannel" | "readReactionsTo" | "readRepliesTo"
  >;
  sign: Signer;
  myPubkey: () => string;
  proposals: Pick<ProposalStore, "snapshot" | "subscribe" | "get" | "edit" | "reject">;
  /** Sign and publish a pending proposal; resolves to the event id or null on failure. */
  approve: (proposalId: number) => Promise<string | null>;
  authorName?: (pubkey: string) => string | undefined;
  storageKey: string;
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  onChange?: (state: RulingsState) => void;
  now?: () => number;
  pollMs?: number;
};

type Persisted = Pick<RulingsState, "enabled" | "channelId" | "posted" | "ruledFromBuzz">;

export class Rulings {
  state: RulingsState = { enabled: false, channelId: null, posted: {}, ruledFromBuzz: {}, busy: false, error: null };
  private deps: RulingsDeps;
  private unsubs: (() => void)[] = [];
  private seen = new Set<string>();
  private inFlight = new Set<number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(deps: RulingsDeps) {
    this.deps = deps;
    const saved = this.load();
    if (saved) this.state = { ...this.state, ...saved, posted: migratePosted(saved.posted) };
  }

  /** The draft post for this proposal, only if the record provably belongs to it. */
  private draftFor(p: Proposal): string | undefined {
    const rec = this.state.posted[p.id];
    return rec && rec.createdAt === p.createdAt ? rec.draftId : undefined;
  }

  /** Drop records for proposals that no longer exist or do not match. */
  private prunePosted(): void {
    const posted: RulingsState["posted"] = {};
    for (const [pid, rec] of Object.entries(this.state.posted)) {
      const p = this.deps.proposals.get(Number(pid));
      if (p && p.createdAt === rec.createdAt) posted[Number(pid)] = rec;
    }
    if (Object.keys(posted).length !== Object.keys(this.state.posted).length) this.set({ posted });
  }

  /** Re-arm after a reload if the human had it on. */
  async resume(): Promise<void> {
    if (this.state.enabled) await this.enable();
  }

  async enable(): Promise<void> {
    this.set({ busy: true, error: null });
    try {
      // A remembered channel is only trusted if the relay still has it — a relay reset
      // (or pointing at a different relay) leaves a dead id behind, and every draft
      // posted there would fail. Recreate, and forget draft records that died with it.
      let channelId = this.state.channelId;
      if (channelId && !(await this.deps.relay.listChannels()).some((c) => c.id === channelId)) {
        channelId = null;
        this.set({ channelId: null, posted: {} });
      }
      channelId = channelId ?? (await this.findOrCreateChannel());
      this.set({ enabled: true, channelId });
      this.prunePosted();
      this.listen(channelId);
      await this.catchUp();
      await this.postPending();
      this.startPolling();
    } catch (e) {
      this.set({ enabled: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.set({ busy: false });
    }
  }

  disable(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stopPolling();
    this.set({ enabled: false });
  }

  /** Ask the relay for rulings right now — on reconnect, on the tab becoming visible. */
  poke(): void {
    if (this.state.enabled) void this.catchUp();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.catchUp(), (this.deps.pollMs ?? POLL_MS));
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  isDraftsChannel(id: string): boolean {
    return this.state.channelId === id;
  }

  // ---- channel ------------------------------------------------------------

  private async findOrCreateChannel(): Promise<string> {
    const existing = (await this.deps.relay.listChannels()).find((c) => c.name === DRAFTS_CHANNEL_NAME);
    if (existing) return existing.id;
    const signed = await this.deps.sign(buildGroupCreate(DRAFTS_CHANNEL_NAME, DRAFTS_CHANNEL_ABOUT, true));
    await this.deps.relay.publish(signed);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const found = (await this.deps.relay.listChannels()).find((c) => c.name === DRAFTS_CHANNEL_NAME);
      if (found) return found.id;
    }
    throw new Error(`Created #${DRAFTS_CHANNEL_NAME} but the relay has not listed it yet. Try again.`);
  }

  private listen(channelId: string): void {
    for (const u of this.unsubs) u();
    this.unsubs = [
      this.deps.relay.subscribeReactions(channelId, (r) => void this.onReaction(r)),
      this.deps.relay.subscribeChannel(channelId, (m) => void this.onMessage(m)),
      this.deps.proposals.subscribe(() => void this.postPending()),
    ];
  }

  /**
   * Rulings the live subscriptions did not deliver: everything made while this tab was
   * closed, and — because Buzz does not fan out its own `h`-less reactions — everything
   * made from Buzz at all. Queried by `#e` and by the human's own key only.
   */
  private async catchUp(): Promise<void> {
    if (this.polling) return;
    const pendingDraftIds = this.deps.proposals
      .snapshot()
      .filter((p) => p.status === "pending")
      .map((p) => this.draftFor(p))
      .filter((d): d is string => !!d);
    if (pendingDraftIds.length === 0) return;
    this.polling = true;
    try {
      const me = this.deps.myPubkey();
      const [reactions, replies] = await Promise.all([
        this.deps.relay.readReactionsTo(pendingDraftIds, me),
        this.deps.relay.readRepliesTo(pendingDraftIds, me),
      ]);
      for (const r of reactions) await this.onReaction(r);
      for (const m of replies) await this.onMessage(m);
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.polling = false;
    }
  }

  // ---- outbound: drafts -----------------------------------------------------

  private async postPending(): Promise<void> {
    if (!this.state.enabled || !this.state.channelId) return;
    for (const p of this.deps.proposals.snapshot()) {
      if (p.status !== "pending" || this.draftFor(p) || this.inFlight.has(p.id)) continue;
      this.inFlight.add(p.id);
      try {
        await this.postDraft(p, this.state.channelId);
      } catch (e) {
        this.set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.inFlight.delete(p.id);
      }
    }
  }

  private async postDraft(p: Proposal, channelId: string): Promise<void> {
    const author = p.target ? this.deps.authorName?.(p.target.pubkey) : undefined;
    const signed = await this.deps.sign(buildDraftPost(channelId, formatDraftPost(p, author), p.id, this.now()));
    await this.deps.relay.publish(signed);
    this.set({ posted: { ...this.state.posted, [p.id]: { draftId: signed.id, createdAt: p.createdAt } } });
  }

  private async postOutcome(p: Proposal, outcome: Outcome): Promise<void> {
    const channelId = this.state.channelId;
    const draftId = this.draftFor(p);
    if (!channelId || !draftId) return;
    const unsigned = buildOutcomePost(
      channelId,
      formatOutcome(p, outcome),
      { id: draftId, pubkey: this.deps.myPubkey() },
      p.id,
      this.now(),
    );
    const signed = await this.deps.sign(unsigned);
    await this.deps.relay.publish(signed).catch(() => undefined);
  }

  // ---- inbound: rulings -----------------------------------------------------

  private proposalForDraft(draftId: string | undefined): Proposal | undefined {
    if (!draftId) return undefined;
    const hit = Object.entries(this.state.posted).find(([, rec]) => rec.draftId === draftId);
    if (!hit) return undefined;
    const p = this.deps.proposals.get(Number(hit[0]));
    return p && p.createdAt === hit[1].createdAt ? p : undefined;
  }

  private async onReaction(r: Message): Promise<void> {
    if (this.seen.has(r.id)) return;
    this.seen.add(r.id);
    if (r.pubkey !== this.deps.myPubkey()) return; // only the key's owner may rule
    const p = this.proposalForDraft(targetOf(r));
    if (!p || p.status !== "pending") return;
    const verdict = verdictFromReaction(r.content);
    if (!verdict) return;
    await this.rule(p, verdict);
  }

  private async onMessage(m: Message): Promise<void> {
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    if (m.pubkey !== this.deps.myPubkey()) return;
    if (m.tags.some((t) => t[0] === DRAFT_TAG)) return; // our own draft/outcome posts
    const parent = m.rootId ?? m.replyTo;
    if (!parent) return;
    const p = this.proposalForDraft(parent);
    if (!p || p.status !== "pending") return;
    const verdict = verdictFromReply(m.content);
    if (!verdict) return;
    await this.rule(p, verdict);
  }

  private async rule(p: Proposal, verdict: NonNullable<ReturnType<typeof verdictFromReply>>): Promise<void> {
    if (verdict.kind === "reject") {
      this.deps.proposals.reject(p.id);
      this.set({ ruledFromBuzz: { ...this.state.ruledFromBuzz, [p.id]: "reject" } });
      await this.postOutcome(p, { kind: "rejected" });
      return;
    }
    let edited = false;
    if (verdict.kind === "edit") {
      if (p.draft.kind !== "message" && p.draft.kind !== "reply") return; // nothing to edit on a reaction/topic/join
      this.deps.proposals.edit(p.id, { content: verdict.content });
      edited = true;
    }
    const eventId = await this.deps.approve(p.id);
    const after = this.deps.proposals.get(p.id) ?? p;
    this.set({ ruledFromBuzz: { ...this.state.ruledFromBuzz, [p.id]: edited ? "edit" : "sign" } });
    await this.postOutcome(
      after,
      eventId ? { kind: "sent", eventId, edited } : { kind: "failed", error: after.error ?? "unknown error" },
    );
  }

  // ---- state ---------------------------------------------------------------

  private set(patch: Partial<RulingsState>): void {
    this.state = { ...this.state, ...patch };
    this.save();
    this.deps.onChange?.(this.state);
  }

  private now(): number {
    return (this.deps.now ?? (() => Math.floor(Date.now() / 1000)))();
  }

  private load(): Persisted | null {
    try {
      const raw = this.deps.storage?.getItem(this.deps.storageKey);
      return raw ? (JSON.parse(raw) as Persisted) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      const { enabled, channelId, posted, ruledFromBuzz } = this.state;
      this.deps.storage?.setItem(this.deps.storageKey, JSON.stringify({ enabled, channelId, posted, ruledFromBuzz }));
    } catch {
      /* storage unavailable */
    }
  }
}

/** Records written by the first release were bare draft ids; they cannot be verified, so they are dropped. */
function migratePosted(raw: unknown): RulingsState["posted"] {
  const out: RulingsState["posted"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as { draftId?: unknown }).draftId === "string" && typeof (v as { createdAt?: unknown }).createdAt === "number") {
      out[Number(k)] = v as { draftId: string; createdAt: number };
    }
  }
  return out;
}

function targetOf(reaction: Message): string | undefined {
  const eTags = reaction.tags.filter((t) => t[0] === "e" && t[1]);
  return eTags.length ? eTags[eTags.length - 1][1] : undefined;
}

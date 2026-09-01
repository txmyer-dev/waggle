// An in-memory relay so the UI and the WebMCP tools work end to end with
// zero network: `?relay=mock`. Seeded with a small, plausible community so a
// judge (or a demo video) has something to read, reply to, and react to.

import { KIND, firstTag, threadPointers } from "./events.ts";
import type {
  Channel,
  Member,
  Message,
  ReadOptions,
  RelayClient,
  RelayStatus,
  SignedEvent,
  Signer,
} from "./types.ts";

const MEMBERS: (Member & { handle: string })[] = [
  { pubkey: "a1".repeat(32), handle: "mara", name: "Mara Okafor", about: "Runs the relay. Asks the hard questions." },
  { pubkey: "b2".repeat(32), handle: "deniz", name: "Deniz Aydın", about: "Backend. Will bring up Postgres in any conversation." },
  { pubkey: "c3".repeat(32), handle: "priya", name: "Priya Raman", about: "Design. Believes most UI is too loud." },
  { pubkey: "d4".repeat(32), handle: "tomas", name: "Tomás Reyes", about: "Ops. Sleeps with a pager." },
];

const CHANNELS: Channel[] = [
  { id: "general", name: "general", about: "Whole-team chatter.", topic: "Ship week. Be kind to the pager.", isOpen: true },
  { id: "relay-ops", name: "relay-ops", about: "Running the relay: deploys, incidents, on-call.", topic: "v0.6 rollout Thursday", isOpen: true },
  { id: "design", name: "design", about: "Screens, words, and the arguments about them.", topic: "Proposal cards: how loud?", isOpen: true },
];

type Seed = { ch: string; by: string; minutesAgo: number; text: string; replyTo?: string; key?: string };

const SEEDS: Seed[] = [
  { key: "g1", ch: "general", by: "mara", minutesAgo: 1440, text: "Reminder: ship week. If it isn't in the changelog it didn't happen." },
  { key: "g2", ch: "general", by: "deniz", minutesAgo: 1380, text: "Migration for the audit table is up for review. It's boring, which is the point." },
  { key: "g3", ch: "general", by: "priya", minutesAgo: 1300, text: "Can someone who is not me look at the empty state on the channel list? It reads like an error." },
  { key: "g4", ch: "general", by: "tomas", minutesAgo: 1200, text: "Pager was quiet last night. I don't trust it.", },
  { key: "g5", ch: "general", by: "mara", minutesAgo: 600, text: "Standup moved to 10:30 tomorrow. Deniz has a dentist thing." },
  { key: "g6", ch: "general", by: "deniz", minutesAgo: 590, text: "It's a root canal. Please be nice in the changelog.", replyTo: "g5" },
  { key: "g7", ch: "general", by: "priya", minutesAgo: 240, text: "Draft of the proposal-card copy is in #design. Two variants. I have opinions about which." },
  { key: "g8", ch: "general", by: "tomas", minutesAgo: 90, text: "Heads up: rotating the relay signing key Thursday during the v0.6 window. Nothing should notice." },
  { key: "g9", ch: "general", by: "mara", minutesAgo: 45, text: "Who is taking notes at the retro? Volunteers get first pick of next sprint." },
  { key: "r1", ch: "relay-ops", by: "tomas", minutesAgo: 2000, text: "Runbook for a stuck WebSocket fan-out is now in the wiki. Read it before you need it." },
  { key: "r2", ch: "relay-ops", by: "deniz", minutesAgo: 1000, text: "Redis memory crept to 70% overnight. Presence keys aren't expiring on one node." },
  { key: "r3", ch: "relay-ops", by: "tomas", minutesAgo: 980, text: "On it. Suspect the SET EX is getting a string TTL after the config refactor.", replyTo: "r2" },
  { key: "r4", ch: "relay-ops", by: "deniz", minutesAgo: 950, text: "That would do it. Ship a fix before Thursday or we roll v0.6 onto a leaking node.", replyTo: "r2" },
  { key: "r5", ch: "relay-ops", by: "mara", minutesAgo: 300, text: "v0.6 go/no-go is Wednesday 4pm. Bring numbers, not feelings." },
  { key: "r6", ch: "relay-ops", by: "tomas", minutesAgo: 120, text: "Fix for the presence TTL is merged. Memory flat for 6h." },
  { key: "d1", ch: "design", by: "priya", minutesAgo: 700, text: "Variant A: proposal cards are quiet, amber left border, no icon. Variant B: full-width banner. I like A." },
  { key: "d2", ch: "design", by: "mara", minutesAgo: 650, text: "A. The agent is a guest at the table, not the host.", replyTo: "d1" },
  { key: "d3", ch: "design", by: "deniz", minutesAgo: 620, text: "A, but the Sign button needs to look like it does something irreversible.", replyTo: "d1" },
  { key: "d4", ch: "design", by: "priya", minutesAgo: 200, text: "Fine, A. Sign button gets the accent. Reject stays ghost. Shipping the copy tonight." },
  { key: "d5", ch: "design", by: "tomas", minutesAgo: 30, text: "Can the card show *why* the agent proposed it? A one-line reason would save me a click." },
];

function fakeId(seedKey: string): string {
  // Deterministic 64-hex ids so tests and demos can refer to them.
  let h = 0;
  for (const c of seedKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h.toString(16).padStart(8, "0") + seedKey.padEnd(8, "0")).repeat(4).slice(0, 64).replace(/[^0-9a-f]/g, "0");
}

export class MockRelay implements RelayClient {
  readonly url: string;
  status: RelayStatus = "idle";
  lastError: string | null = null;
  private statusListeners = new Set<(s: RelayStatus) => void>();
  private messages: Message[] = [];
  private channels: Channel[] = CHANNELS.map((c) => ({ ...c }));
  private subs = new Map<string, Set<(m: Message) => void>>();
  private profiles = new Map<string, Member>();

  constructor(url = "mock://waggle") {
    this.url = url;
    for (const m of MEMBERS) this.profiles.set(m.pubkey, { pubkey: m.pubkey, name: m.name, about: m.about });
    const now = Math.floor(Date.now() / 1000);
    const byKey = new Map<string, Message>();
    for (const s of SEEDS) {
      const author = MEMBERS.find((m) => m.handle === s.by)!;
      const parent = s.replyTo ? byKey.get(s.replyTo) : undefined;
      const tags: string[][] = [["h", s.ch]];
      if (parent) {
        const root = parent.rootId ?? parent.id;
        tags.push(["e", root, "", "root"]);
        if (root !== parent.id) tags.push(["e", parent.id, "", "reply"]);
        tags.push(["p", parent.pubkey]);
      }
      const msg: Message = {
        id: fakeId(s.key ?? s.text),
        pubkey: author.pubkey,
        content: s.text,
        created_at: now - s.minutesAgo * 60,
        channelId: s.ch,
        kind: KIND.GROUP_MESSAGE,
        tags,
        ...(parent ? { rootId: parent.rootId ?? parent.id, replyTo: parent.id } : {}),
      };
      this.messages.push(msg);
      if (s.key) byKey.set(s.key, msg);
    }
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: RelayStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  async connect(_signer: Signer, pubkey: string): Promise<void> {
    this.setStatus("connecting");
    await new Promise((r) => setTimeout(r, 150));
    if (!this.profiles.has(pubkey)) this.profiles.set(pubkey, { pubkey, name: "you" });
    this.setStatus("connected");
  }

  close(): void {
    this.setStatus("disconnected");
  }

  async listChannels(): Promise<Channel[]> {
    return this.channels.map((c) => ({ ...c }));
  }

  async readChannel(channelId: string, opts: ReadOptions = {}): Promise<Message[]> {
    const limit = opts.limit ?? 50;
    const list = this.messages
      .filter((m) => m.channelId === channelId && m.kind === KIND.GROUP_MESSAGE)
      .filter((m) => (opts.since ? m.created_at > opts.since : true))
      .sort((a, b) => a.created_at - b.created_at);
    return list.slice(-limit);
  }

  subscribeChannel(channelId: string, onMessage: (message: Message) => void): () => void {
    let set = this.subs.get(channelId);
    if (!set) this.subs.set(channelId, (set = new Set()));
    set.add(onMessage);
    return () => set!.delete(onMessage);
  }

  async readThread(rootId: string, channelId: string): Promise<Message[]> {
    return this.messages
      .filter((m) => m.channelId === channelId && (m.id === rootId || m.rootId === rootId))
      .sort((a, b) => a.created_at - b.created_at);
  }

  async searchMessages(query: string, channelId?: string): Promise<Message[]> {
    const q = query.toLowerCase();
    return this.messages
      .filter((m) => m.kind === KIND.GROUP_MESSAGE)
      .filter((m) => (channelId ? m.channelId === channelId : true))
      .filter((m) => m.content.toLowerCase().includes(q))
      .sort((a, b) => b.created_at - a.created_at);
  }

  async getMember(pubkey: string): Promise<Member> {
    return this.profiles.get(pubkey) ?? { pubkey };
  }

  private reactions: Message[] = [];
  private reactionSubs = new Map<string, Set<(m: Message) => void>>();

  async readReactions(channelId: string, since?: number): Promise<Message[]> {
    return this.reactions
      .filter((r) => r.channelId === channelId && (since ? r.created_at > since : true))
      .sort((a, b) => a.created_at - b.created_at);
  }

  subscribeReactions(channelId: string, onReaction: (reaction: Message) => void): () => void {
    let set = this.reactionSubs.get(channelId);
    if (!set) this.reactionSubs.set(channelId, (set = new Set()));
    set.add(onReaction);
    return () => set!.delete(onReaction);
  }

  async publish(event: SignedEvent): Promise<string> {
    await new Promise((r) => setTimeout(r, 120));
    if (event.kind === KIND.GROUP_CREATE) {
      const name = firstTag(event.tags, "name") ?? "untitled";
      const isPrivate = firstTag(event.tags, "visibility") === "private";
      this.channels.push({ id: fakeId(`group:${name}:${event.id}`), name, about: firstTag(event.tags, "about"), isOpen: !isPrivate });
      return event.id;
    }
    const channelId = firstTag(event.tags, "h");
    if (!channelId) throw new Error("mock relay: event has no h tag");
    if (event.kind === KIND.REACTION) {
      const reaction: Message = {
        id: event.id,
        pubkey: event.pubkey,
        content: event.content,
        created_at: event.created_at,
        channelId,
        kind: event.kind,
        tags: event.tags,
      };
      this.reactions.push(reaction);
      for (const l of this.reactionSubs.get(channelId) ?? []) l(reaction);
      return event.id;
    }
    if (event.kind === KIND.GROUP_EDIT_METADATA) {
      const topic = firstTag(event.tags, "topic");
      this.channels = this.channels.map((c) => (c.id === channelId && topic !== undefined ? { ...c, topic } : c));
      return event.id;
    }
    if (event.kind === KIND.GROUP_JOIN_REQUEST) return event.id;
    const { rootId, replyTo } = threadPointers(event.tags);
    const msg: Message = {
      id: event.id,
      pubkey: event.pubkey,
      content: event.content,
      created_at: event.created_at,
      channelId,
      kind: event.kind,
      tags: event.tags,
      ...(rootId ? { rootId, replyTo } : {}),
    };
    this.messages.push(msg);
    for (const l of this.subs.get(channelId) ?? []) l(msg);
    return event.id;
  }
}

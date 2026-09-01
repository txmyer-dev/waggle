// The app's one store: relay, identity, channels, messages, selection, the
// proposals dock, and the WebMCP status chip. React reads it through
// useSyncExternalStore; the WaggleContext handed to the tools reads it
// directly. Nothing here signs anything except through Identity.sign, and
// only ProposalStore.approve and the human's composer ever call that.

import { type Identity, importNsec, loadIdentity, regenerateLocalIdentity } from "../identity/identity.ts";
import { buildMessage, buildReply } from "../relay/events.ts";
import { createRelay, relayUrlFromLocation } from "../relay/index.ts";
import type { Channel, Member, Message, RelayClient, RelayStatus } from "../relay/types.ts";
import { ProposalStore } from "../proposals/store.ts";
import { Rulings, type RulingsState } from "../rulings/controller.ts";
import { registerWaggleTools } from "../tools/register.ts";
import type { ToolDefinition, WaggleContext } from "../tools/types.ts";
import * as nip19 from "nostr-tools/nip19";

export type WebmcpState = { available: boolean; registered: string[]; errors: { name: string; error: string }[] };

export type AppState = {
  relayUrl: string;
  relayStatus: RelayStatus;
  relayError: string | null;
  identity: Identity | null;
  channels: Channel[];
  currentChannelId: string | null;
  messages: Record<string, Message[]>;
  selectedMessageId: string | null;
  threadRootId: string | null;
  members: Record<string, Member>;
  webmcp: WebmcpState;
  tools: ToolDefinition[];
  booting: boolean;
  bootError: string | null;
  flags: { dev: boolean };
  rulings: RulingsState;
};

const RULINGS_IDLE: RulingsState = { enabled: false, channelId: null, posted: {}, ruledFromBuzz: {}, busy: false, error: null };

type Listener = () => void;

export class AppStore {
  state: AppState;
  relay: RelayClient;
  proposals: ProposalStore;
  rulings: Rulings | null = null;
  private listeners = new Set<Listener>();
  private unsubscribeLive: (() => void) | null = null;
  private toolsAbort = new AbortController();

  constructor() {
    const relayUrl = relayUrlFromLocation();
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    this.relay = createRelay(relayUrl);
    this.state = {
      relayUrl,
      relayStatus: "idle",
      relayError: null,
      identity: null,
      channels: [],
      currentChannelId: null,
      messages: {},
      selectedMessageId: null,
      threadRootId: null,
      members: {},
      webmcp: { available: false, registered: [], errors: [] },
      tools: [],
      booting: true,
      bootError: null,
      flags: { dev: params.get("dev") === "1" },
      rulings: RULINGS_IDLE,
    };
    if (this.state.flags.dev) {
      // Dev-only: stand in for Buzz. Publishes a real reaction/reply under the human's key,
      // so the whole ruling path runs except the click in the other client.
      (globalThis as unknown as { waggleDev?: unknown }).waggleDev = {
        simulateBuzzRuling: (proposalId: number, content: string) => this.simulateBuzzRuling(proposalId, content),
      };
    }
    this.proposals = new ProposalStore({
      sign: (t) => {
        const id = this.state.identity;
        if (!id) throw new Error("No identity loaded.");
        return id.sign(t);
      },
      publish: (e) => this.relay.publish(e),
      resolveMessage: (id) => this.findMessage(id),
      resolveChannelName: (id) => this.state.channels.find((c) => c.id === id)?.name,
      storage: globalThis.localStorage,
      storageKey: `waggle:proposals:${relayUrl}`,
    });
    this.proposals.subscribe(() => this.emit());
    this.relay.onStatus((s) => {
      this.set({ relayStatus: s, relayError: this.relay.lastError });
      if (s === "connected") this.rulings?.poke();
    });
    // Agent browsers background the page; ask for rulings the moment it comes back.
    globalThis.document?.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "visible") this.rulings?.poke();
    });
  }

  // ---- subscription plumbing -------------------------------------------

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ---- lifecycle ---------------------------------------------------------

  async boot(): Promise<void> {
    try {
      const identity = await loadIdentity();
      this.set({ identity });
      await this.registerTools();
      await this.connect();
    } catch (e) {
      this.set({ bootError: e instanceof Error ? e.message : String(e), booting: false });
    }
  }

  private async connect(): Promise<void> {
    const identity = this.state.identity!;
    this.set({ booting: true, bootError: null });
    try {
      await this.relay.connect(identity.sign, identity.pubkey);
      const channels = await this.relay.listChannels();
      this.set({ channels, booting: false });
      // Restore where the human was. Agent browsers (ChatGPT's in particular) can reload the
      // page between the human's click and the agent's tool call; the selection must survive that.
      const saved = this.loadView();
      const remembered = saved?.channelId && channels.some((c) => c.id === saved.channelId) ? saved.channelId : null;
      const first = this.state.currentChannelId ?? remembered ?? channels[0]?.id ?? null;
      if (first) await this.openChannel(first, remembered === first ? saved?.selectedMessageId ?? null : null);
      await this.armRulings(identity.pubkey);
    } catch (e) {
      this.set({ bootError: e instanceof Error ? e.message : String(e), booting: false });
    }
  }

  private async registerTools(): Promise<void> {
    this.toolsAbort.abort();
    this.toolsAbort = new AbortController();
    const res = await registerWaggleTools(this.context(), { signal: this.toolsAbort.signal });
    this.set({
      tools: res.tools,
      webmcp: { available: res.webmcpAvailable, registered: res.registered, errors: res.errors },
    });
  }

  // ---- channels & messages ----------------------------------------------

  async openChannel(channelId: string, restoreSelection: string | null = null): Promise<void> {
    this.unsubscribeLive?.();
    this.unsubscribeLive = null;
    this.set({ currentChannelId: channelId, selectedMessageId: null, threadRootId: null });
    this.saveView();
    const list = await this.relay.readChannel(channelId, { limit: 80 });
    this.set({ messages: { ...this.state.messages, [channelId]: list } });
    if (restoreSelection && list.some((m) => m.id === restoreSelection)) {
      this.set({ selectedMessageId: restoreSelection });
    }
    void this.hydrateMembers(list.map((m) => m.pubkey));
    this.unsubscribeLive = this.relay.subscribeChannel(channelId, (m) => this.ingest(m));
  }

  // ---- rule from Buzz -------------------------------------------------------

  private async armRulings(pubkey: string): Promise<void> {
    this.rulings = new Rulings({
      relay: this.relay,
      sign: (t) => {
        const id = this.state.identity;
        if (!id) throw new Error("No identity loaded.");
        return id.sign(t);
      },
      myPubkey: () => pubkey,
      proposals: this.proposals,
      approve: async (id) => {
        await this.approveProposal(id);
        const p = this.proposals.get(id);
        return p?.status === "sent" ? (p.eventId ?? null) : null;
      },
      authorName: (pk) => this.authorName(pk),
      storageKey: `waggle:rulings:${this.state.relayUrl}:${pubkey}`,
      storage: globalThis.localStorage,
      onChange: (rulings) => {
        const gained = rulings.channelId && !this.state.channels.some((c) => c.id === rulings.channelId);
        this.set({ rulings });
        if (gained) void this.refreshChannels();
      },
    });
    this.set({ rulings: this.rulings.state });
    await this.rulings.resume();
  }

  async toggleRulings(): Promise<void> {
    if (!this.rulings) return;
    if (this.rulings.state.enabled) this.rulings.disable();
    else await this.rulings.enable();
  }

  private async refreshChannels(): Promise<void> {
    const channels = await this.relay.listChannels().catch(() => this.state.channels);
    this.set({ channels });
  }

  /** Dev-only stand-in for a ruling made in Buzz: a reaction (✅/❌) or a reply (edited text). */
  async simulateBuzzRuling(proposalId: number, content: string): Promise<string> {
    const identity = this.state.identity;
    const r = this.rulings?.state;
    const draftId = r?.posted[proposalId]?.draftId;
    if (!identity || !r?.channelId || !draftId) throw new Error("No draft post for that proposal (is Rule from Buzz on?)");
    const isMark = /^[✅✔☑❌✖🚫⛔+\-]️?$|^:[a-z_]+:$/u.test(content.trim());
    // Mimic Buzz exactly: its reactions carry only an `e` tag — no `h`, no `p` — which is
    // the shape the relay refuses to fan out live and the shape the poller must catch.
    const unsigned = isMark
      ? { kind: 7, created_at: Math.floor(Date.now() / 1000), tags: [["e", draftId]], content: content.trim() }
      : buildReply(r.channelId, content, { id: draftId, pubkey: identity.pubkey }, null);
    const signed = await identity.sign(unsigned);
    return this.relay.publish(signed);
  }

  // The human's place in the app, persisted per relay so a reload lands them back on the
  // same channel with the same message selected.
  private viewKey(): string {
    return `waggle:view:${this.state.relayUrl}`;
  }
  private saveView(): void {
    try {
      localStorage.setItem(
        this.viewKey(),
        JSON.stringify({ channelId: this.state.currentChannelId, selectedMessageId: this.state.selectedMessageId }),
      );
    } catch {
      /* storage unavailable: selection just won't survive a reload */
    }
  }
  private loadView(): { channelId: string | null; selectedMessageId: string | null } | null {
    try {
      const raw = localStorage.getItem(this.viewKey());
      return raw ? (JSON.parse(raw) as { channelId: string | null; selectedMessageId: string | null }) : null;
    } catch {
      return null;
    }
  }

  private ingest(m: Message): void {
    const list = this.state.messages[m.channelId] ?? [];
    if (list.some((x) => x.id === m.id)) return;
    const next = [...list, m].sort((a, b) => a.created_at - b.created_at);
    this.set({ messages: { ...this.state.messages, [m.channelId]: next } });
    void this.hydrateMembers([m.pubkey]);
  }

  private async hydrateMembers(pubkeys: string[]): Promise<void> {
    const missing = [...new Set(pubkeys)].filter((pk) => !this.state.members[pk]);
    if (missing.length === 0) return;
    const fetched = await Promise.all(missing.map((pk) => this.relay.getMember(pk).catch(() => ({ pubkey: pk }))));
    const members = { ...this.state.members };
    for (const m of fetched) members[m.pubkey] = m;
    this.set({ members });
  }

  selectMessage(id: string | null): void {
    this.set({ selectedMessageId: id });
    this.saveView();
  }

  openThread(rootId: string | null): void {
    this.set({ threadRootId: rootId });
  }

  findMessage(id: string): Message | undefined {
    for (const list of Object.values(this.state.messages)) {
      const hit = list.find((m) => m.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  currentChannel(): Channel | null {
    return this.state.channels.find((c) => c.id === this.state.currentChannelId) ?? null;
  }

  authorName(pubkey: string): string {
    const m = this.state.members[pubkey];
    if (m?.name) return m.name;
    if (this.state.identity?.pubkey === pubkey) return "you";
    return `${pubkey.slice(0, 8)}…`;
  }

  /** The human typed something themselves. Signed, no provenance tag. */
  async sendHuman(content: string, replyToId: string | null): Promise<void> {
    const identity = this.state.identity;
    const channelId = this.state.currentChannelId;
    if (!identity || !channelId || !content.trim()) return;
    const parent = replyToId ? this.findMessage(replyToId) : undefined;
    const unsigned = parent ? buildReply(channelId, content, parent, null) : buildMessage(channelId, content, null);
    const signed = await identity.sign(unsigned);
    await this.relay.publish(signed);
    // Mock relays echo through the subscription; real relays do too, but not
    // always promptly — show our own message immediately either way.
    this.ingest({
      id: signed.id,
      pubkey: signed.pubkey,
      content: signed.content,
      created_at: signed.created_at,
      channelId,
      kind: signed.kind,
      tags: signed.tags,
      ...(parent ? { rootId: parent.rootId ?? parent.id, replyTo: parent.id } : {}),
    });
  }

  /** Approve a proposal, then reflect the resulting event locally. */
  async approveProposal(id: number): Promise<void> {
    const signed = await this.proposals.approve(id);
    const p = this.proposals.get(id);
    if (!signed || !p) return;
    if (p.draft.kind === "message" || p.draft.kind === "reply") {
      const parent = p.target;
      this.ingest({
        id: signed.id,
        pubkey: signed.pubkey,
        content: signed.content,
        created_at: signed.created_at,
        channelId: p.draft.channelId,
        kind: signed.kind,
        tags: signed.tags,
        ...(parent ? { rootId: parent.rootId ?? parent.id, replyTo: parent.id } : {}),
      });
    }
    if (p.draft.kind === "topic") {
      const channels = await this.relay.listChannels().catch(() => this.state.channels);
      this.set({ channels });
    }
  }

  // ---- identity ------------------------------------------------------------

  async replaceIdentity(nsec: string | null): Promise<void> {
    const identity = nsec ? importNsec(nsec) : regenerateLocalIdentity();
    this.relay.close();
    this.relay = createRelay(this.state.relayUrl);
    this.relay.onStatus((s) => this.set({ relayStatus: s, relayError: this.relay.lastError }));
    this.set({ identity, messages: {}, members: {}, selectedMessageId: null, threadRootId: null });
    await this.registerTools();
    await this.connect();
  }

  // ---- the port seam ------------------------------------------------------

  context(): WaggleContext {
    const toView = (m: Message) => ({
      id: m.id,
      pubkey: m.pubkey,
      author: this.authorName(m.pubkey),
      content: m.content,
      created_at: m.created_at,
      ...(m.rootId ? { rootId: m.rootId } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    });
    return {
      getView: () => {
        const ch = this.currentChannel();
        const sel = this.state.selectedMessageId ? this.findMessage(this.state.selectedMessageId) : undefined;
        const me = this.state.identity;
        return {
          relayUrl: this.state.relayUrl,
          channel: ch ? { id: ch.id, name: ch.name, ...(ch.topic ? { topic: ch.topic } : {}) } : null,
          selectedMessage: sel ? toView(sel) : null,
          me: me ? { pubkey: me.pubkey, npub: me.npub } : { pubkey: "", npub: "" },
          pendingProposals: this.proposals.pendingCount(),
        };
      },
      listChannels: async () =>
        (await this.relay.listChannels())
          // The drafts channel is the human's private desk, not a room agents work in.
          .filter((c) => !this.rulings?.isDraftsChannel(c.id))
          .map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.topic ? { topic: c.topic } : {}),
          ...(c.about ? { about: c.about } : {}),
        })),
      readChannel: async (channelId, opts) => {
        const list = await this.relay.readChannel(channelId, opts);
        await this.hydrateMembers(list.map((m) => m.pubkey));
        return list.map(toView);
      },
      readThread: async (rootId) => {
        const root = this.findMessage(rootId);
        const channelId = root?.channelId ?? this.state.currentChannelId;
        if (!channelId) throw new Error("Cannot tell which channel this thread is in.");
        const list = await this.relay.readThread(rootId, channelId);
        await this.hydrateMembers(list.map((m) => m.pubkey));
        return list.map(toView);
      },
      searchMessages: async (query, channelId) => {
        const list = await this.relay.searchMessages(query, channelId);
        await this.hydrateMembers(list.map((m) => m.pubkey));
        return list.map(toView);
      },
      getMember: async (pubkey) => {
        const m = await this.relay.getMember(pubkey);
        return { pubkey, npub: safeNpub(pubkey), ...(m.name ? { name: m.name } : {}), ...(m.about ? { about: m.about } : {}) };
      },
      propose: async (draft) => this.proposals.propose(draft),
    };
  }
}

function safeNpub(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return "";
  }
}

export const store = new AppStore();

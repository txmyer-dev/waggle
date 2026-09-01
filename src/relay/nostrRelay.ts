// The real thing: one NIP-29 relay over one WebSocket, via nostr-tools.
// Handles NIP-42 AUTH with the caller's signer, discovers groups from
// kind:39000, reads kind:9 by `#h`, and publishes whatever signed event it is
// handed. It never builds or signs events itself.

import { Relay } from "nostr-tools/relay";
import type { Event as NostrEvent, EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
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

const EOSE_TIMEOUT_MS = 6000;

export class NostrRelay implements RelayClient {
  readonly url: string;
  status: RelayStatus = "idle";
  lastError: string | null = null;
  private relay: Relay | null = null;
  private statusListeners = new Set<(s: RelayStatus) => void>();
  private profileCache = new Map<string, Member>();
  private channelCache = new Map<string, Channel>();
  private authSettled: Promise<void> = Promise.resolve();

  constructor(url: string) {
    this.url = url;
  }

  onStatus(listener: (status: RelayStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: RelayStatus, error: string | null = null) {
    this.status = s;
    this.lastError = error;
    for (const l of this.statusListeners) l(s);
  }

  async connect(signer: Signer, _pubkey: string): Promise<void> {
    this.setStatus("connecting");
    const relay = new Relay(this.url, { enableReconnect: true, enablePing: true });
    let settle: () => void = () => {};
    this.authSettled = new Promise<void>((r) => (settle = r));
    // Buzz challenges proactively on connect; nostr-tools answers through
    // onauth. We wait for that round-trip before the first REQ, because the
    // relay CLOSEs unauthenticated subscriptions and nostr-tools does not
    // retry them.
    relay.onauth = async (template: EventTemplate) => {
      try {
        const signed = await signer(template as SignedEvent);
        return signed as VerifiedEvent;
      } finally {
        setTimeout(settle, 250);
      }
    };
    relay.onclose = () => {
      if (this.status !== "disconnected") this.setStatus("disconnected");
    };
    relay.onnotice = (msg: string) => console.info("[relay notice]", msg);
    try {
      await relay.connect();
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.setStatus("error", err);
      throw e;
    }
    this.relay = relay;
    // Relays that never challenge (public open relays) should not block.
    await Promise.race([this.authSettled, new Promise((r) => setTimeout(r, 900))]);
    this.setStatus("connected");
  }

  close(): void {
    this.relay?.close();
    this.relay = null;
    this.setStatus("disconnected");
  }

  private need(): Relay {
    if (!this.relay) throw new Error("Not connected to the relay.");
    return this.relay;
  }

  /** One-shot query: collect until EOSE (or timeout), with one retry after an auth CLOSE. */
  private async query(filters: Filter[], attempt = 0): Promise<NostrEvent[]> {
    const relay = this.need();
    const events: NostrEvent[] = [];
    const closedReason = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        sub.close();
        resolve(null);
      }, EOSE_TIMEOUT_MS);
      const sub = relay.subscribe(filters, {
        onevent: (ev) => events.push(ev),
        oneose: () => {
          clearTimeout(timer);
          sub.close();
          resolve(null);
        },
        onclose: (reason) => {
          clearTimeout(timer);
          resolve(reason ?? "closed");
        },
      });
    });
    if (closedReason && /auth-required/i.test(closedReason) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 600));
      return this.query(filters, 1);
    }
    return events;
  }

  async listChannels(): Promise<Channel[]> {
    const events = await this.query([{ kinds: [KIND.GROUP_METADATA], limit: 200 }]);
    const out: Channel[] = [];
    for (const ev of events) {
      const id = firstTag(ev.tags, "d");
      if (!id) continue;
      const hidden = ev.tags.some((t) => t[0] === "hidden");
      if (hidden) continue;
      const ch: Channel = {
        id,
        name: firstTag(ev.tags, "name") ?? id,
        about: firstTag(ev.tags, "about"),
        topic: firstTag(ev.tags, "topic"),
        isOpen: !ev.tags.some((t) => t[0] === "closed"),
      };
      this.channelCache.set(id, ch);
      out.push(ch);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readChannel(channelId: string, opts: ReadOptions = {}): Promise<Message[]> {
    const filter: Filter = { kinds: [KIND.GROUP_MESSAGE], "#h": [channelId], limit: opts.limit ?? 50 };
    if (opts.since) filter.since = opts.since;
    const events = await this.query([filter]);
    return dedupe(events.map(toMessage)).sort((a, b) => a.created_at - b.created_at);
  }

  subscribeChannel(channelId: string, onMessage: (message: Message) => void): () => void {
    const relay = this.need();
    const since = Math.floor(Date.now() / 1000) - 5;
    const sub = relay.subscribe([{ kinds: [KIND.GROUP_MESSAGE], "#h": [channelId], since }], {
      onevent: (ev) => onMessage(toMessage(ev)),
    });
    return () => sub.close();
  }

  async readReactions(channelId: string, since?: number): Promise<Message[]> {
    const filter: Filter = { kinds: [KIND.REACTION], "#h": [channelId], limit: 200 };
    if (since) filter.since = since;
    const events = await this.query([filter]);
    return dedupe(events.map(toMessage)).sort((a, b) => a.created_at - b.created_at);
  }

  subscribeReactions(channelId: string, onReaction: (reaction: Message) => void): () => void {
    const relay = this.need();
    const since = Math.floor(Date.now() / 1000) - 5;
    const sub = relay.subscribe([{ kinds: [KIND.REACTION], "#h": [channelId], since }], {
      onevent: (ev) => onReaction(toMessage(ev)),
    });
    return () => sub.close();
  }

  async readThread(rootId: string, channelId: string): Promise<Message[]> {
    const [roots, replies] = await Promise.all([
      this.query([{ ids: [rootId] }]),
      this.query([{ kinds: [KIND.GROUP_MESSAGE], "#e": [rootId], "#h": [channelId], limit: 200 }]),
    ]);
    return dedupe([...roots, ...replies].map(toMessage)).sort((a, b) => a.created_at - b.created_at);
  }

  async searchMessages(query: string, channelId?: string): Promise<Message[]> {
    const filter: Filter = { search: query, kinds: [KIND.GROUP_MESSAGE], limit: 50 };
    if (channelId) filter["#h"] = [channelId];
    const events = await this.query([filter]);
    return dedupe(events.map(toMessage)).sort((a, b) => b.created_at - a.created_at);
  }

  async getMember(pubkey: string): Promise<Member> {
    const cached = this.profileCache.get(pubkey);
    if (cached) return cached;
    const events = await this.query([{ kinds: [KIND.METADATA], authors: [pubkey], limit: 1 }]);
    let member: Member = { pubkey };
    const ev = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (ev) {
      try {
        const meta = JSON.parse(ev.content) as Record<string, unknown>;
        member = {
          pubkey,
          name: pickString(meta, ["display_name", "name"]),
          about: pickString(meta, ["about"]),
          picture: pickString(meta, ["picture"]),
        };
      } catch {
        // Malformed profile; keep the bare pubkey.
      }
    }
    this.profileCache.set(pubkey, member);
    return member;
  }

  async publish(event: SignedEvent): Promise<string> {
    const relay = this.need();
    await relay.publish(event as NostrEvent);
    return event.id;
  }
}

function toMessage(ev: NostrEvent): Message {
  const { rootId, replyTo } = threadPointers(ev.tags);
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    content: ev.content,
    created_at: ev.created_at,
    channelId: firstTag(ev.tags, "h") ?? "",
    kind: ev.kind,
    tags: ev.tags,
    ...(rootId ? { rootId, replyTo } : {}),
  };
}

function dedupe(list: Message[]): Message[] {
  const seen = new Set<string>();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

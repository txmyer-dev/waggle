// Relay-side vocabulary shared by the real NIP-29 client and the mock.
// Kept free of React and of nostr-tools types so the tools module and the
// tests can import it without pulling in a browser or a crypto stack.

export type Channel = {
  id: string;
  name: string;
  about?: string;
  topic?: string;
  isOpen?: boolean;
};

export type Message = {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  channelId: string;
  kind: number;
  /** NIP-10 root id, when this message is inside a thread. */
  rootId?: string;
  /** NIP-10 direct parent id, when this message is a reply. */
  replyTo?: string;
  tags: string[][];
};

export type Member = {
  pubkey: string;
  name?: string;
  about?: string;
  picture?: string;
};

export type RelayStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export type UnsignedEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedEvent = UnsignedEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

export type Signer = (template: UnsignedEvent) => Promise<SignedEvent>;

export type ReadOptions = { limit?: number; since?: number };

/**
 * The relay port. `NostrRelay` speaks NIP-29 over a WebSocket; `MockRelay`
 * answers from memory. Everything above this line treats them identically.
 */
export interface RelayClient {
  readonly url: string;
  readonly status: RelayStatus;
  readonly lastError: string | null;
  onStatus(listener: (status: RelayStatus) => void): () => void;
  connect(signer: Signer, pubkey: string): Promise<void>;
  close(): void;
  listChannels(): Promise<Channel[]>;
  readChannel(channelId: string, opts?: ReadOptions): Promise<Message[]>;
  subscribeChannel(
    channelId: string,
    onMessage: (message: Message) => void,
  ): () => void;
  readThread(rootId: string, channelId: string): Promise<Message[]>;
  searchMessages(query: string, channelId?: string): Promise<Message[]>;
  getMember(pubkey: string): Promise<Member>;
  publish(event: SignedEvent): Promise<string>;
}

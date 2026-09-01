// The port seam. Everything the WebMCP tools can see or ask for goes through
// this interface, so the same tools module can sit on top of Waggle's little
// client today and a different host's state tomorrow. No React, no relay
// library, no keys: a WaggleContext can read and can *propose*. It cannot sign.

export type ViewChannel = { id: string; name: string; topic?: string };

export type ViewMessage = {
  id: string;
  pubkey: string;
  author?: string;
  content: string;
  created_at: number;
  rootId?: string;
  replyTo?: string;
};

export type View = {
  relayUrl: string;
  channel: ViewChannel | null;
  selectedMessage: ViewMessage | null;
  me: { pubkey: string; npub: string };
  pendingProposals: number;
};

export type ChannelSummary = ViewChannel & {
  about?: string;
  unread?: number;
};

export type MemberSummary = {
  pubkey: string;
  npub: string;
  name?: string;
  about?: string;
};

/** What an agent may put on the table. Each variant is a card the human sees. */
export type Draft =
  | { kind: "message"; channelId: string; content: string }
  | {
      kind: "reply";
      channelId: string;
      parentId: string;
      content: string;
    }
  | { kind: "reaction"; channelId: string; targetId: string; emoji: string }
  | { kind: "topic"; channelId: string; topic: string }
  | { kind: "join"; channelId: string; reason: string };

export type ProposalReceipt = {
  proposalId: number;
  /** One line the human sees on the card; echoed to the agent too. */
  summary: string;
};

export interface WaggleContext {
  getView(): View;
  listChannels(): Promise<ChannelSummary[]>;
  readChannel(
    channelId: string,
    opts?: { limit?: number; since?: number },
  ): Promise<ViewMessage[]>;
  readThread(rootId: string): Promise<ViewMessage[]>;
  searchMessages(query: string, channelId?: string): Promise<ViewMessage[]>;
  getMember(pubkey: string): Promise<MemberSummary>;
  /** Put a draft in front of the human. Resolves as soon as the card exists. */
  propose(draft: Draft): Promise<ProposalReceipt>;
}

/** A JSON-Schema-ish object schema. Kept loose on purpose; WebMCP just wants JSON. */
export type ObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  title?: string;
};

/** The shape `document.modelContext.registerTool()` accepts. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  annotations?: ToolAnnotations;
  execute(
    params: Record<string, unknown>,
    ctx?: { signal?: AbortSignal },
  ): Promise<string> | string;
};

/** The subset of the WebMCP surface we touch. */
export interface ModelContextLike {
  registerTool(
    tool: ToolDefinition,
    options?: { signal?: AbortSignal; exposedTo?: string[] },
  ): Promise<void> | void;
}

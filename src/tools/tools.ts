// The eleven tools. Reads answer from the context; propose_* hand a draft to
// the human and return a receipt that says so in words an agent will not
// misread. Descriptions are written for the model, not for us.

import type {
  ChannelSummary,
  Draft,
  ToolDefinition,
  ViewMessage,
  WaggleContext,
} from "./types.ts";

const READ_ONLY = { readOnlyHint: true } as const;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function need(params: Record<string, unknown>, key: string): string {
  const v = str(params, key);
  if (v === undefined) throw new Error(`Missing required argument "${key}".`);
  return v;
}

/** Fall back to the channel the human is looking at when the agent omits one. */
function channelOrCurrent(ctx: WaggleContext, params: Record<string, unknown>): string {
  const explicit = str(params, "channel_id");
  if (explicit) return explicit;
  const current = ctx.getView().channel;
  if (!current) {
    throw new Error(
      "No channel_id given and the human has no channel open. Call list_channels and pass channel_id.",
    );
  }
  return current.id;
}

function compactMessage(m: ViewMessage) {
  return {
    id: m.id,
    author: m.author ?? m.pubkey.slice(0, 8),
    pubkey: m.pubkey,
    content: m.content,
    created_at: m.created_at,
    ...(m.rootId ? { rootId: m.rootId } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  };
}

function compactChannel(c: ChannelSummary) {
  return { id: c.id, name: c.name, ...(c.topic ? { topic: c.topic } : {}), ...(c.about ? { about: c.about } : {}) };
}

function receiptText(proposalId: number, summary: string): string {
  return (
    `Proposal #${proposalId} is now a card in the human's Waggles dock: ${summary}. ` +
    `It has NOT been sent. Only the human can sign and send it, and they may edit or reject it. ` +
    `Do not tell the user it was posted; tell them it is waiting for their signature.`
  );
}

async function proposeAndReport(ctx: WaggleContext, draft: Draft): Promise<string> {
  const receipt = await ctx.propose(draft);
  return receiptText(receipt.proposalId, receipt.summary);
}

export function buildWaggleTools(ctx: WaggleContext): ToolDefinition[] {
  return [
    {
      name: "get_current_view",
      description:
        "What the human is looking at right now in Waggle: the connected relay, the open channel, " +
        "the message they have selected (if any), their own pubkey, and how many proposals are waiting. " +
        "Call this first. 'this message' or 'that one' in the human's words means selectedMessage.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: () => json(ctx.getView()),
    },
    {
      name: "list_channels",
      description:
        "List the NIP-29 channels (groups) visible on the connected relay, with ids, names, and topics. " +
        "Use the id, not the name, when calling other tools.",
      inputSchema: { type: "object", properties: {} },
      annotations: READ_ONLY,
      execute: async () => json((await ctx.listChannels()).map(compactChannel)),
    },
    {
      name: "read_channel",
      description:
        "Read recent messages in a channel, newest last. Defaults to the channel the human has open. " +
        "Each message has an id you can pass to propose_reply, propose_reaction, or read_thread.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Channel id from list_channels. Omit for the open channel." },
          limit: { type: "number", description: "How many messages, max 200. Default 50." },
          since: { type: "number", description: "Unix seconds; only messages after this time." },
        },
      },
      annotations: READ_ONLY,
      execute: async (params) => {
        const channelId = channelOrCurrent(ctx, params);
        const limit = Math.min(200, Math.max(1, num(params, "limit") ?? 50));
        const messages = await ctx.readChannel(channelId, { limit, since: num(params, "since") });
        return json({ channelId, count: messages.length, messages: messages.map(compactMessage) });
      },
    },
    {
      name: "read_thread",
      description:
        "Read a whole thread: the root message and every reply under it, oldest first. " +
        "Pass the root id, or any message's rootId.",
      inputSchema: {
        type: "object",
        properties: { root_id: { type: "string", description: "Id of the thread root message." } },
        required: ["root_id"],
      },
      annotations: READ_ONLY,
      execute: async (params) => {
        const rootId = need(params, "root_id");
        const messages = await ctx.readThread(rootId);
        return json({ rootId, count: messages.length, messages: messages.map(compactMessage) });
      },
    },
    {
      name: "search_messages",
      description:
        "Full-text search across messages the human can see. Optionally restrict to one channel. " +
        "Returns matches with ids, so you can quote or reply to them.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to search for." },
          channel_id: { type: "string", description: "Restrict to this channel id. Omit to search everywhere." },
        },
        required: ["query"],
      },
      annotations: READ_ONLY,
      execute: async (params) => {
        const query = need(params, "query");
        const messages = await ctx.searchMessages(query, str(params, "channel_id"));
        return json({ query, count: messages.length, messages: messages.map(compactMessage) });
      },
    },
    {
      name: "get_member",
      description:
        "Look up a member's profile (name, about) by pubkey. Useful for turning a pubkey on a message into a person.",
      inputSchema: {
        type: "object",
        properties: { pubkey: { type: "string", description: "64-char hex pubkey from a message." } },
        required: ["pubkey"],
      },
      annotations: READ_ONLY,
      execute: async (params) => json(await ctx.getMember(need(params, "pubkey"))),
    },
    {
      name: "propose_message",
      description:
        "Draft a new message in a channel and place it in front of the human as a proposal card. " +
        "You cannot send: the human reads it, may edit it, and decides whether to sign and send. " +
        "Write it in the human's voice, ready to go as-is. Defaults to the open channel.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The full message text, exactly as it should be sent." },
          channel_id: { type: "string", description: "Channel id. Omit for the open channel." },
        },
        required: ["content"],
      },
      execute: async (params) =>
        proposeAndReport(ctx, {
          kind: "message",
          channelId: channelOrCurrent(ctx, params),
          content: need(params, "content"),
        }),
    },
    {
      name: "propose_reply",
      description:
        "Draft a reply to a specific message and place it in front of the human as a proposal card. " +
        "The human decides whether to sign and send. If the human said 'reply to this', use the " +
        "selectedMessage id from get_current_view as parent_id.",
      inputSchema: {
        type: "object",
        properties: {
          parent_id: { type: "string", description: "Id of the message being replied to." },
          content: { type: "string", description: "The full reply text, exactly as it should be sent." },
          channel_id: { type: "string", description: "Channel id. Omit for the open channel." },
        },
        required: ["parent_id", "content"],
      },
      execute: async (params) =>
        proposeAndReport(ctx, {
          kind: "reply",
          channelId: channelOrCurrent(ctx, params),
          parentId: need(params, "parent_id"),
          content: need(params, "content"),
        }),
    },
    {
      name: "propose_reaction",
      description:
        "Propose an emoji reaction to a message. The human sees the card and decides whether to sign it. " +
        "Use a single emoji such as 👍 or ❤️ or ✅.",
      inputSchema: {
        type: "object",
        properties: {
          target_id: { type: "string", description: "Id of the message to react to." },
          emoji: { type: "string", description: "One emoji." },
          channel_id: { type: "string", description: "Channel id. Omit for the open channel." },
        },
        required: ["target_id", "emoji"],
      },
      execute: async (params) =>
        proposeAndReport(ctx, {
          kind: "reaction",
          channelId: channelOrCurrent(ctx, params),
          targetId: need(params, "target_id"),
          emoji: need(params, "emoji"),
        }),
    },
    {
      name: "propose_channel_topic",
      description:
        "Propose a new topic line for a channel. Changing a topic is a group-metadata edit that the relay " +
        "may restrict to members or admins; the human decides whether to sign it.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "The new topic text." },
          channel_id: { type: "string", description: "Channel id. Omit for the open channel." },
        },
        required: ["topic"],
      },
      execute: async (params) =>
        proposeAndReport(ctx, {
          kind: "topic",
          channelId: channelOrCurrent(ctx, params),
          topic: need(params, "topic"),
        }),
    },
    {
      name: "propose_join_channel",
      description:
        "Propose that the human join a channel they are not yet a member of. The human decides; " +
        "a signed join request is what actually asks the relay.",
      inputSchema: {
        type: "object",
        properties: {
          channel_id: { type: "string", description: "Channel id from list_channels." },
          reason: { type: "string", description: "Optional one-line reason shown to the human and sent with the request." },
        },
        required: ["channel_id"],
      },
      execute: async (params) =>
        proposeAndReport(ctx, {
          kind: "join",
          channelId: need(params, "channel_id"),
          reason: str(params, "reason") ?? "",
        }),
    },
  ];
}

export const WAGGLE_TOOL_NAMES = [
  "get_current_view",
  "list_channels",
  "read_channel",
  "read_thread",
  "search_messages",
  "get_member",
  "propose_message",
  "propose_reply",
  "propose_reaction",
  "propose_channel_topic",
  "propose_join_channel",
] as const;

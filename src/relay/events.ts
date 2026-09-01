// Event builders for the handful of NIP-29 shapes Waggle emits. Pure
// functions: template in, unsigned event out. Signing happens elsewhere,
// on purpose — this is the module that must never see a key.

import type { Message, UnsignedEvent } from "./types.ts";

export const KIND = {
  METADATA: 0,
  REACTION: 7,
  GROUP_MESSAGE: 9,
  GROUP_EDIT_METADATA: 9002,
  GROUP_CREATE: 9007,
  GROUP_JOIN_REQUEST: 9021,
  CLIENT_AUTH: 22242,
  USER_STATUS: 30315,
  GROUP_METADATA: 39000,
  GROUP_ADMINS: 39001,
  GROUP_MEMBERS: 39002,
} as const;

export const CLIENT_TAG: string[] = ["client", "waggle"];

/** Provenance tag stamped on events the human signed from an agent proposal. */
export function proposedByTag(proposalId: number): string[] {
  return ["proposed-by", "webmcp", String(proposalId)];
}

export type Provenance = { proposalId: number } | null;

function base(kind: number, tags: string[][], content: string, now: number): UnsignedEvent {
  return { kind, created_at: now, tags, content };
}

function withProvenance(tags: string[][], provenance: Provenance): string[][] {
  const out = [...tags, CLIENT_TAG];
  if (provenance) out.push(proposedByTag(provenance.proposalId));
  return out;
}

export function buildMessage(
  channelId: string,
  content: string,
  provenance: Provenance,
  now = nowSeconds(),
): UnsignedEvent {
  return base(KIND.GROUP_MESSAGE, withProvenance([["h", channelId]], provenance), content, now);
}

export function buildReply(
  channelId: string,
  content: string,
  parent: Pick<Message, "id" | "pubkey" | "rootId">,
  provenance: Provenance,
  now = nowSeconds(),
): UnsignedEvent {
  const rootId = parent.rootId ?? parent.id;
  const tags: string[][] = [
    ["h", channelId],
    ["e", rootId, "", "root"],
  ];
  if (rootId !== parent.id) tags.push(["e", parent.id, "", "reply"]);
  tags.push(["p", parent.pubkey]);
  return base(KIND.GROUP_MESSAGE, withProvenance(tags, provenance), content, now);
}

export function buildReaction(
  channelId: string,
  target: Pick<Message, "id" | "pubkey">,
  emoji: string,
  provenance: Provenance,
  now = nowSeconds(),
): UnsignedEvent {
  const tags: string[][] = [
    ["e", target.id],
    ["p", target.pubkey],
    ["h", channelId],
  ];
  return base(KIND.REACTION, withProvenance(tags, provenance), emoji, now);
}

export function buildTopic(
  channelId: string,
  topic: string,
  provenance: Provenance,
  now = nowSeconds(),
): UnsignedEvent {
  const tags: string[][] = [
    ["h", channelId],
    ["topic", topic],
  ];
  return base(KIND.GROUP_EDIT_METADATA, withProvenance(tags, provenance), "", now);
}

export function buildJoinRequest(
  channelId: string,
  reason: string,
  provenance: Provenance,
  now = nowSeconds(),
): UnsignedEvent {
  return base(KIND.GROUP_JOIN_REQUEST, withProvenance([["h", channelId]], provenance), reason, now);
}

/** NIP-29 group creation as Buzz accepts it: `name`, optional `about`, `visibility` open|private. */
export function buildGroupCreate(
  name: string,
  about: string,
  isPrivate: boolean,
  now = nowSeconds(),
): UnsignedEvent {
  const tags: string[][] = [
    ["name", name],
    ["about", about],
    ["visibility", isPrivate ? "private" : "open"],
  ];
  return base(KIND.GROUP_CREATE, tags, "", now);
}

/** Tags that mark a message in the drafts channel as Waggle's own bookkeeping. */
export const DRAFT_TAG = "waggle";

/**
 * A proposal, posted into the human's private drafts channel so it can be ruled on
 * from Buzz. Signed by the human (it is their private room), but never carries
 * `proposed-by`: it is not the message, it is the card.
 */
export function buildDraftPost(
  channelId: string,
  content: string,
  proposalId: number,
  now = nowSeconds(),
): UnsignedEvent {
  const tags: string[][] = [["h", channelId], CLIENT_TAG, [DRAFT_TAG, "draft", String(proposalId)]];
  return base(KIND.GROUP_MESSAGE, tags, content, now);
}

/** The ruling's receipt, threaded under the draft post. */
export function buildOutcomePost(
  channelId: string,
  content: string,
  draft: Pick<Message, "id" | "pubkey">,
  proposalId: number,
  now = nowSeconds(),
): UnsignedEvent {
  const tags: string[][] = [
    ["h", channelId],
    ["e", draft.id, "", "root"],
    ["p", draft.pubkey],
    CLIENT_TAG,
    [DRAFT_TAG, "outcome", String(proposalId)],
  ];
  return base(KIND.GROUP_MESSAGE, tags, content, now);
}

/**
 * NIP-38 user status as Buzz renders it: kind 30315, `d`=general, optional `emoji` tag,
 * text in content. Empty text and emoji clear the status.
 */
export function buildUserStatus(text: string, emoji: string, now = nowSeconds()): UnsignedEvent {
  const tags: string[][] = [["d", "general"]];
  if (emoji) tags.push(["emoji", emoji]);
  return base(KIND.USER_STATUS, tags, text, now);
}

export function buildAuth(relayUrl: string, challenge: string, now = nowSeconds()): UnsignedEvent {
  return base(
    KIND.CLIENT_AUTH,
    [
      ["relay", relayUrl],
      ["challenge", challenge],
    ],
    "",
    now,
  );
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Read the NIP-10 thread pointers off a raw event's tags. */
export function threadPointers(tags: string[][]): { rootId?: string; replyTo?: string } {
  let rootId: string | undefined;
  let replyTo: string | undefined;
  const eTags = tags.filter((t) => t[0] === "e" && t[1]);
  for (const t of eTags) {
    if (t[3] === "root") rootId = t[1];
    else if (t[3] === "reply") replyTo = t[1];
  }
  // Deprecated positional form: first e = root, last e = reply.
  if (!rootId && eTags.length > 0) rootId = eTags[0][1];
  if (!replyTo && eTags.length > 1) replyTo = eTags[eTags.length - 1][1];
  if (!replyTo && rootId) replyTo = rootId;
  return { rootId, replyTo };
}

export function firstTag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProposalStore } from "../proposals/store.ts";
import { MockRelay } from "../relay/mockRelay.ts";
import type { SignedEvent, UnsignedEvent } from "../relay/types.ts";
import { DRAFTS_CHANNEL_NAME, Rulings } from "./controller.ts";
import { formatDraftPost } from "./format.ts";
import { verdictFromReaction, verdictFromReply } from "./parse.ts";

test("reactions: ✅ signs, ❌ rejects, 👍 is not a ruling", () => {
  assert.deepEqual(verdictFromReaction("✅"), { kind: "sign" });
  assert.deepEqual(verdictFromReaction("✔️"), { kind: "sign" });
  assert.deepEqual(verdictFromReaction(":white_check_mark:"), { kind: "sign" });
  assert.deepEqual(verdictFromReaction("❌"), { kind: "reject" });
  assert.deepEqual(verdictFromReaction(":x:"), { kind: "reject" });
  assert.equal(verdictFromReaction("👍"), null);
  assert.equal(verdictFromReaction("❤️"), null);
});

test("replies: bare marks rule, anything else is an edit", () => {
  assert.deepEqual(verdictFromReply(" ✅ "), { kind: "sign" });
  assert.deepEqual(verdictFromReply("Actually say: on it, ETA 5pm"), { kind: "edit", content: "Actually say: on it, ETA 5pm" });
  assert.equal(verdictFromReply("   "), null);
});

// A tiny signer: no crypto, deterministic ids, enough for the relay port.
let counter = 0;
const ME = "me".padEnd(64, "0");
const signAs =
  (pubkey: string) =>
  async (t: UnsignedEvent): Promise<SignedEvent> => ({ ...t, id: `ev${++counter}`.padEnd(64, "0"), pubkey, sig: "sig" });

function rig() {
  const relay = new MockRelay();
  const sign = signAs(ME);
  const published: SignedEvent[] = [];
  const proposals = new ProposalStore({
    sign,
    publish: async (e) => {
      published.push(e);
      return relay.publish(e);
    },
    resolveMessage: () => undefined,
    resolveChannelName: () => "general",
  });
  const storage = new Map<string, string>();
  const rulings = new Rulings({
    relay,
    sign,
    myPubkey: () => ME,
    proposals,
    approve: async (id) => {
      const signed = await proposals.approve(id);
      return signed?.id ?? null;
    },
    storageKey: "t",
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  });
  return { relay, sign, proposals, rulings, published };
}

const tick = () => new Promise((r) => setTimeout(r, 400));

test("enabling creates a private drafts channel and posts pending proposals into it", async () => {
  const { relay, proposals, rulings } = rig();
  proposals.propose({ kind: "message", channelId: "general", content: "hello hive" });
  await rulings.enable();
  const drafts = (await relay.listChannels()).find((c) => c.name === DRAFTS_CHANNEL_NAME);
  assert.ok(drafts, "drafts channel exists");
  assert.equal(drafts.isOpen, false, "drafts channel is private");
  await tick();
  const posts = await relay.readChannel(drafts.id);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content, /Proposal #1 · Post in #general/);
  assert.match(posts[0].content, /hello hive/);
  assert.ok(posts[0].tags.some((t) => t[0] === "waggle" && t[1] === "draft"));
  assert.ok(!posts[0].tags.some((t) => t[0] === "proposed-by"), "the draft post is not the message");
});

test("✅ from the owner's key signs the real message; a stranger's ✅ does nothing", async () => {
  const { relay, sign, proposals, rulings, published } = rig();
  await rulings.enable();
  const { proposalId } = proposals.propose({ kind: "message", channelId: "general", content: "ship it" });
  await tick();
  const drafts = (await relay.listChannels()).find((c) => c.name === DRAFTS_CHANNEL_NAME)!;
  const draftPost = (await relay.readChannel(drafts.id))[0];

  const stranger = signAs("stranger".padEnd(64, "0"));
  await relay.publish(await stranger({ kind: 7, created_at: 1, tags: [["e", draftPost.id], ["h", drafts.id]], content: "✅" }));
  await tick();
  assert.equal(proposals.get(proposalId)?.status, "pending", "stranger cannot rule");

  await relay.publish(await sign({ kind: 7, created_at: 2, tags: [["e", draftPost.id], ["h", drafts.id]], content: "✅" }));
  await tick();
  const p = proposals.get(proposalId)!;
  assert.equal(p.status, "sent");
  const real = published.find((e) => e.tags.some((t) => t[0] === "proposed-by"));
  assert.ok(real, "real message carries provenance");
  assert.equal(real.content, "ship it");
  assert.equal(rulings.state.ruledFromBuzz[proposalId], "sign");
  const thread = await relay.readThread(draftPost.id, drafts.id);
  assert.ok(thread.some((m) => /Signed & sent/.test(m.content)), "receipt posted under the draft");
});

test("a reply under the draft edits the text and signs; ❌ rejects", async () => {
  const { relay, sign, proposals, rulings, published } = rig();
  await rulings.enable();
  const a = proposals.propose({ kind: "message", channelId: "general", content: "first draft" }).proposalId;
  const b = proposals.propose({ kind: "message", channelId: "general", content: "doomed" }).proposalId;
  await tick();
  const drafts = (await relay.listChannels()).find((c) => c.name === DRAFTS_CHANNEL_NAME)!;
  const posts = await relay.readChannel(drafts.id);
  const postA = posts.find((m) => m.content.includes("first draft"))!;
  const postB = posts.find((m) => m.content.includes("doomed"))!;

  await relay.publish(
    await sign({ kind: 9, created_at: 3, tags: [["h", drafts.id], ["e", postA.id, "", "root"], ["p", ME]], content: "better draft" }),
  );
  await relay.publish(await sign({ kind: 7, created_at: 4, tags: [["e", postB.id], ["h", drafts.id]], content: "❌" }));
  await tick();
  assert.equal(proposals.get(a)?.status, "sent");
  assert.equal(published.find((e) => e.tags.some((t) => t[0] === "proposed-by"))?.content, "better draft");
  assert.equal(rulings.state.ruledFromBuzz[a], "edit");
  assert.equal(proposals.get(b)?.status, "rejected");
  assert.equal(rulings.state.ruledFromBuzz[b], "reject");
});

test("draft post reads well in a plain client", () => {
  const p = {
    id: 7,
    draft: { kind: "reply" as const, channelId: "c", parentId: "m", content: "On it — ETA 5pm." },
    summary: "",
    status: "pending" as const,
    proposedBy: "webmcp" as const,
    createdAt: 0,
    channelName: "general",
    target: { id: "m", pubkey: "pk", content: "Who owns the release notes?" },
  };
  const text = formatDraftPost(p, "Priya");
  assert.equal(
    text,
    [
      "🐝 Proposal #7 · Reply in #general",
      "↳ Priya: “Who owns the release notes?”",
      "",
      "On it — ETA 5pm.",
      "",
      "React ✅ to sign & send · ❌ to reject · or reply here with the text you'd rather send.",
    ].join("\n"),
  );
});

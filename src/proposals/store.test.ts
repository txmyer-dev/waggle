import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, SignedEvent, UnsignedEvent } from "../relay/types.ts";
import { ProposalStore } from "./store.ts";

const parent: Message = {
  id: "p1",
  pubkey: "pkp",
  content: "the parent",
  created_at: 5,
  channelId: "general",
  kind: 9,
  tags: [["h", "general"]],
};

function harness() {
  const signed: UnsignedEvent[] = [];
  const published: SignedEvent[] = [];
  const store = new ProposalStore({
    sign: async (t) => {
      signed.push(t);
      return { ...t, id: `id${signed.length}`, pubkey: "me", sig: "sig" };
    },
    publish: async (e) => {
      published.push(e);
      return e.id;
    },
    resolveMessage: (id) => (id === "p1" ? parent : undefined),
    resolveChannelName: (id) => (id === "general" ? "general" : undefined),
    now: () => 1000,
  });
  return { store, signed, published };
}

test("approve signs once, publishes once, stamps provenance, marks sent", async () => {
  const { store, signed, published } = harness();
  const r = store.propose({ kind: "message", channelId: "general", content: "hello" });
  assert.equal(r.proposalId, 1);
  assert.match(r.summary, /Post in #general/);

  const ev = await store.approve(1);
  assert.ok(ev);
  assert.equal(signed.length, 1);
  assert.equal(published.length, 1);
  assert.ok(ev!.tags.some((t) => t[0] === "proposed-by" && t[1] === "webmcp" && t[2] === "1"));
  assert.ok(ev!.tags.some((t) => t[0] === "client" && t[1] === "waggle"));
  assert.equal(store.get(1)!.status, "sent");
  assert.equal(store.get(1)!.eventId, "id1");

  // Approving again is a no-op.
  assert.equal(await store.approve(1), null);
  assert.equal(published.length, 1);
});

test("reject never signs or publishes", async () => {
  const { store, signed, published } = harness();
  store.propose({ kind: "reaction", channelId: "general", targetId: "p1", emoji: "👍" });
  store.reject(1);
  assert.equal(store.get(1)!.status, "rejected");
  assert.equal(await store.approve(1), null);
  assert.equal(signed.length, 0);
  assert.equal(published.length, 0);
});

test("edit changes the draft before signing; the event reflects the edit", async () => {
  const { store, published } = harness();
  store.propose({ kind: "reply", channelId: "general", parentId: "p1", content: "draft" });
  store.edit(1, { content: "edited" });
  await store.approve(1);
  assert.equal(published[0].content, "edited");
  assert.ok(published[0].tags.some((t) => t[0] === "e" && t[1] === "p1" && t[3] === "root"));
  assert.ok(published[0].tags.some((t) => t[0] === "p" && t[1] === "pkp"));
});

test("a failing publish marks the proposal failed and allows retry", async () => {
  const { store } = harness();
  let fail = true;
  const failing = new ProposalStore({
    sign: async (t) => ({ ...t, id: "x", pubkey: "me", sig: "s" }),
    publish: async (e) => {
      if (fail) throw new Error("relay said no");
      return e.id;
    },
    resolveMessage: () => undefined,
    resolveChannelName: () => "general",
  });
  failing.propose({ kind: "topic", channelId: "general", topic: "t" });
  assert.equal(await failing.approve(1), null);
  assert.equal(failing.get(1)!.status, "failed");
  assert.match(failing.get(1)!.error!, /relay said no/);
  fail = false;
  failing.retry(1);
  assert.ok(await failing.approve(1));
  assert.equal(failing.get(1)!.status, "sent");
  void store;
});

test("pendingCount and subscribe fire on changes", () => {
  const { store } = harness();
  let fired = 0;
  const off = store.subscribe(() => fired++);
  store.propose({ kind: "join", channelId: "design", reason: "" });
  store.propose({ kind: "message", channelId: "general", content: "a" });
  assert.equal(store.pendingCount(), 2);
  store.reject(2);
  assert.equal(store.pendingCount(), 1);
  assert.equal(fired, 3);
  off();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIND,
  buildAuth,
  buildJoinRequest,
  buildMessage,
  buildReaction,
  buildReply,
  buildTopic,
  threadPointers,
} from "./events.ts";

const has = (tags: string[][], t: string[]) => tags.some((x) => x.length >= t.length && t.every((v, i) => x[i] === v));

test("message: kind 9, h tag, client tag, provenance only when proposed", () => {
  const human = buildMessage("chan", "hi", null, 100);
  assert.equal(human.kind, KIND.GROUP_MESSAGE);
  assert.equal(human.created_at, 100);
  assert.ok(has(human.tags, ["h", "chan"]));
  assert.ok(has(human.tags, ["client", "waggle"]));
  assert.ok(!human.tags.some((t) => t[0] === "proposed-by"));

  const proposed = buildMessage("chan", "hi", { proposalId: 7 }, 100);
  assert.ok(has(proposed.tags, ["proposed-by", "webmcp", "7"]));
});

test("reply: NIP-10 root/reply markers and p tag", () => {
  const toRoot = buildReply("chan", "yes", { id: "root1", pubkey: "pk1" }, null, 1);
  assert.ok(has(toRoot.tags, ["e", "root1", "", "root"]));
  assert.ok(!toRoot.tags.some((t) => t[3] === "reply"));
  assert.ok(has(toRoot.tags, ["p", "pk1"]));

  const nested = buildReply("chan", "yes", { id: "child", pubkey: "pk2", rootId: "root1" }, { proposalId: 2 }, 1);
  assert.ok(has(nested.tags, ["e", "root1", "", "root"]));
  assert.ok(has(nested.tags, ["e", "child", "", "reply"]));
  assert.ok(has(nested.tags, ["proposed-by", "webmcp", "2"]));
});

test("reaction: kind 7 with e, p, h and emoji content", () => {
  const r = buildReaction("chan", { id: "m1", pubkey: "pk" }, "👍", null, 1);
  assert.equal(r.kind, KIND.REACTION);
  assert.equal(r.content, "👍");
  assert.ok(has(r.tags, ["e", "m1"]));
  assert.ok(has(r.tags, ["p", "pk"]));
  assert.ok(has(r.tags, ["h", "chan"]));
});

test("topic: kind 9002 with topic tag; join: kind 9021 with reason as content", () => {
  const t = buildTopic("chan", "new topic", null, 1);
  assert.equal(t.kind, KIND.GROUP_EDIT_METADATA);
  assert.ok(has(t.tags, ["topic", "new topic"]));
  assert.ok(has(t.tags, ["h", "chan"]));

  const j = buildJoinRequest("chan", "please", null, 1);
  assert.equal(j.kind, KIND.GROUP_JOIN_REQUEST);
  assert.equal(j.content, "please");
  assert.ok(has(j.tags, ["h", "chan"]));
});

test("auth: kind 22242 with relay and challenge", () => {
  const a = buildAuth("wss://r.example", "abc", 1);
  assert.equal(a.kind, KIND.CLIENT_AUTH);
  assert.ok(has(a.tags, ["relay", "wss://r.example"]));
  assert.ok(has(a.tags, ["challenge", "abc"]));
});

test("threadPointers reads marked and positional forms", () => {
  assert.deepEqual(threadPointers([["e", "r", "", "root"], ["e", "p", "", "reply"]]), { rootId: "r", replyTo: "p" });
  assert.deepEqual(threadPointers([["e", "r", "", "root"]]), { rootId: "r", replyTo: "r" });
  assert.deepEqual(threadPointers([["e", "a"], ["e", "b"]]), { rootId: "a", replyTo: "b" });
  assert.deepEqual(threadPointers([["h", "x"]]), { rootId: undefined, replyTo: undefined });
});

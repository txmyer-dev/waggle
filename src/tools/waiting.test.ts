import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUserStatus } from "../relay/events.ts";
import { waitingOnMe } from "./waiting.ts";

const ME = "me".padEnd(64, "0");
const SAM = "sam".padEnd(64, "0");
const m = (id: string, pubkey: string, content: string, t: number, extra: Partial<{ rootId: string; replyTo: string }> = {}) => ({
  id,
  pubkey,
  content,
  created_at: t,
  ...extra,
});

test("finds mentions, replies to me, and open questions — and drops what I've answered", () => {
  const items = waitingOnMe(
    [
      {
        channelId: "g",
        channelName: "general",
        messages: [
          m("q1", SAM, "Does anyone know the release date?", 10),
          m("q2", SAM, "Tony, can you look at #412?", 20),
          m("mine1", ME, "Sure, looking.", 25, { rootId: "q2", replyTo: "q2" }),
          m("q3", SAM, "Where is the retro doc?", 30),
          m("r1", SAM, "Thanks for the fix!", 40, { rootId: "mine0", replyTo: "mine0" }),
          m("mine0", ME, "Fixed the pager.", 5),
          m("s1", SAM, "Shipping at noon.", 50),
          m("q4", SAM, "Gift question: does the shop have a leather bag under $200? I need it by Friday.", 60),
        ],
      },
    ],
    { pubkey: ME, names: ["Tony", "npub1tony"] },
  );
  const byId = Object.fromEntries(items.map((i) => [i.id, i.reason]));
  assert.equal(byId.q1, "question");
  assert.equal(byId.q2, undefined, "answered mention is not waiting");
  assert.equal(byId.q3, "question");
  assert.equal(byId.r1, "reply-to-you");
  assert.equal(byId.s1, undefined, "a statement is not waiting");
  assert.equal(byId.q4, "question", "a question mark mid-message still counts");
  assert.equal(items[0].id, "q4", "newest first");
  assert.equal(items[0].channelName, "general");
});

test("since and limit are honoured; short names never match", () => {
  const items = waitingOnMe(
    [{ channelId: "g", messages: [m("a", SAM, "Is it ready?", 10), m("b", SAM, "Is it done?", 20), m("c", SAM, "Hi", 30)] }],
    { pubkey: ME, names: ["Hi"] },
    { since: 15, limit: 1 },
  );
  assert.deepEqual(
    items.map((i) => i.id),
    ["b"],
  );
});

test("Buzz user status event is NIP-38 shaped", () => {
  const ev = buildUserStatus("agent drafting · rulings at 5:00 PM", "🐝", 100);
  assert.equal(ev.kind, 30315);
  assert.deepEqual(ev.tags, [
    ["d", "general"],
    ["emoji", "🐝"],
  ]);
  assert.equal(ev.content, "agent drafting · rulings at 5:00 PM");
  assert.deepEqual(buildUserStatus("", "", 100).tags, [["d", "general"]]);
});

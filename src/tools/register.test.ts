import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWaggleTools } from "./register.ts";
import { WAGGLE_TOOL_NAMES, buildWaggleTools } from "./tools.ts";
import type { Draft, ModelContextLike, ToolDefinition, WaggleContext } from "./types.ts";

function fakeCtx(overrides: Partial<WaggleContext> = {}) {
  const proposed: Draft[] = [];
  const published: unknown[] = [];
  const ctx: WaggleContext & { proposed: Draft[]; published: unknown[]; publish(): void } = {
    proposed,
    published,
    publish: () => published.push("nope"),
    getView: () => ({
      relayUrl: "mock",
      channel: { id: "general", name: "general" },
      selectedMessage: { id: "m1", pubkey: "pk1", content: "hello", created_at: 1 },
      me: { pubkey: "me", npub: "npub1me" },
      pendingProposals: 0,
    }),
    listChannels: async () => [{ id: "general", name: "general", topic: "t" }],
    readChannel: async () => [{ id: "m1", pubkey: "pk1", content: "hello", created_at: 1 }],
    readThread: async () => [],
    searchMessages: async () => [],
    getMember: async (pubkey) => ({ pubkey, npub: "npub1x", name: "X" }),
    propose: async (draft) => {
      proposed.push(draft);
      return { proposalId: proposed.length, summary: "s" };
    },
    ...overrides,
  };
  return ctx;
}

function fakeModelContext() {
  const tools: ToolDefinition[] = [];
  const mc: ModelContextLike & { tools: ToolDefinition[] } = {
    tools,
    registerTool: async (tool) => {
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)) throw new Error("bad name");
      tools.push(tool);
    },
  };
  return mc;
}

test("registers all 11 tools when a model context exists", async () => {
  const mc = fakeModelContext();
  const res = await registerWaggleTools(fakeCtx(), { modelContext: mc });
  assert.equal(res.webmcpAvailable, true);
  assert.deepEqual(res.registered, [...WAGGLE_TOOL_NAMES]);
  assert.equal(mc.tools.length, 11);
  assert.deepEqual(res.errors, []);
});

test("returns definitions but registers nothing when WebMCP is absent", async () => {
  const res = await registerWaggleTools(fakeCtx(), { modelContext: null });
  assert.equal(res.webmcpAvailable, false);
  assert.equal(res.registered.length, 0);
  assert.equal(res.tools.length, 11);
});

test("every tool has an object input schema and a description", () => {
  for (const t of buildWaggleTools(fakeCtx())) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(typeof t.inputSchema.properties, "object", t.name);
    assert.ok(t.description.length > 40, t.name);
    for (const r of t.inputSchema.required ?? []) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
  }
});

test("read tools are annotated read-only; propose tools are not", () => {
  for (const t of buildWaggleTools(fakeCtx())) {
    if (t.name.startsWith("propose_")) assert.equal(t.annotations?.readOnlyHint, undefined, t.name);
    else assert.equal(t.annotations?.readOnlyHint, true, t.name);
  }
});

test("propose_* call ctx.propose with the right draft and never publish", async () => {
  const ctx = fakeCtx();
  const byName = Object.fromEntries(buildWaggleTools(ctx).map((t) => [t.name, t]));

  const out1 = await byName.propose_message.execute({ content: "hi" });
  assert.match(String(out1), /Proposal #1/);
  assert.match(String(out1), /NOT been sent/);
  assert.deepEqual(ctx.proposed[0], { kind: "message", channelId: "general", content: "hi" });

  await byName.propose_reply.execute({ parent_id: "m1", content: "yes", channel_id: "other" });
  assert.deepEqual(ctx.proposed[1], { kind: "reply", channelId: "other", parentId: "m1", content: "yes" });

  await byName.propose_reaction.execute({ target_id: "m1", emoji: "👍" });
  assert.deepEqual(ctx.proposed[2], { kind: "reaction", channelId: "general", targetId: "m1", emoji: "👍" });

  await byName.propose_channel_topic.execute({ topic: "T" });
  assert.deepEqual(ctx.proposed[3], { kind: "topic", channelId: "general", topic: "T" });

  await byName.propose_join_channel.execute({ channel_id: "design" });
  assert.deepEqual(ctx.proposed[4], { kind: "join", channelId: "design", reason: "" });

  assert.equal(ctx.published.length, 0);
});

test("errors come back as text through the registered wrapper", async () => {
  const mc = fakeModelContext();
  await registerWaggleTools(fakeCtx(), { modelContext: mc });
  const reply = mc.tools.find((t) => t.name === "propose_reply")!;
  const out = await reply.execute({});
  assert.match(String(out), /^Error from propose_reply: Missing required argument "content"/);
});

test("propose_reply and propose_reaction default to the message the human selected", async () => {
  const ctx = fakeCtx();
  const byName = Object.fromEntries(buildWaggleTools(ctx).map((t) => [t.name, t]));
  await byName.propose_reply.execute({ content: "on it" });
  assert.deepEqual(ctx.proposed[0], { kind: "reply", channelId: "general", parentId: "m1", content: "on it" });
  await byName.propose_reaction.execute({ emoji: "👍" });
  assert.deepEqual(ctx.proposed[1], { kind: "reaction", channelId: "general", targetId: "m1", emoji: "👍" });
  // An explicit id still wins over the selection.
  await byName.propose_reply.execute({ parent_id: "m9", content: "x" });
  assert.equal((ctx.proposed[2] as { parentId: string }).parentId, "m9");
});

test("without a selection or an id, propose_reply explains how to recover", async () => {
  const ctx = fakeCtx({
    getView: () => ({
      relayUrl: "mock",
      channel: { id: "general", name: "general" },
      selectedMessage: null,
      me: { pubkey: "me", npub: "npub1me" },
      pendingProposals: 0,
    }),
  });
  const reply = buildWaggleTools(ctx).find((t) => t.name === "propose_reply")!;
  await assert.rejects(
    async () => {
      await reply.execute({ content: "hi" });
    },
    (e: unknown) => e instanceof Error && /no message selected[\s\S]*read_channel/.test(e.message),
  );
  assert.equal(ctx.proposed.length, 0);
});

test("read tools flag the selected message and say so in words", async () => {
  const ctx = fakeCtx({
    readChannel: async () => [
      { id: "m0", pubkey: "pk0", content: "earlier", created_at: 0 },
      { id: "m1", pubkey: "pk1", content: "hello", created_at: 1 },
    ],
  });
  const read = buildWaggleTools(ctx).find((t) => t.name === "read_channel")!;
  const out = JSON.parse(String(await read.execute({})));
  assert.equal(out.selectedMessageId, "m1");
  assert.match(out.selectionHint, /selected message m1/);
  assert.equal(out.messages[0].selected, undefined);
  assert.equal(out.messages[1].selected, true);
});

test("read tools fall back to the open channel", async () => {
  const ctx = fakeCtx();
  const read = buildWaggleTools(ctx).find((t) => t.name === "read_channel")!;
  const out = JSON.parse(String(await read.execute({})));
  assert.equal(out.channelId, "general");
  assert.equal(out.messages[0].id, "m1");
});

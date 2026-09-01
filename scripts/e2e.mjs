// End-to-end check through the REAL WebMCP API: launches Chrome with WebMCP enabled, opens Waggle,
// calls the page's tools via `document.modelContext.executeTool`, has the "human" click Sign & send,
// then confirms the event on the relay with an independent key.
//
//   pnpm e2e                          # against http://127.0.0.1:4173 (run `pnpm build && pnpm preview` first)
//   pnpm e2e https://app.waggle.thecrowbarcrew.cc/
//
// Uses your installed Google Chrome (channel "chrome"); set PW_EXE to point at another Chromium build.
// Chrome 149+ is required for `document.modelContext`.
import { chromium } from "playwright";
import { Relay, generateSecretKey, finalizeEvent } from "nostr-tools";

const url = process.argv[2] || "http://127.0.0.1:4173/";
const relayUrl = process.env.WAGGLE_RELAY || "wss://waggle.thecrowbarcrew.cc";
const shots = process.env.SHOTS || null;

const browser = await chromium.launch({
  channel: process.env.PW_EXE ? undefined : "chrome",
  executablePath: process.env.PW_EXE,
  args: ["--enable-features=WebMCP,WebMCPTesting"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".msg", { timeout: 20000 });

const call = (name, args) =>
  page.evaluate(async ({ name, args }) => {
    const tools = await document.modelContext.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    // Chrome hands tools their arguments as a JSON string.
    return document.modelContext.executeTool(tool, JSON.stringify(args));
  }, { name, args });

const names = await page.evaluate(async () => (await document.modelContext.getTools()).map((t) => t.name).sort());
console.log(`getTools(): ${names.length} tools — ${names.join(", ")}`);

await page.locator(".msg").nth(2).click(); // the human selects a message
const view = JSON.parse(await call("get_current_view", {}));
if (!view.selectedMessage) throw new Error("selection did not reach get_current_view");
console.log(`selected: "${view.selectedMessage.content.slice(0, 50)}…" in #${view.channel.name}`);

// read_channel must surface the selection on its own, since agents often skip get_current_view.
const channel = JSON.parse(await call("read_channel", { limit: 20 }));
if (channel.selectedMessageId !== view.selectedMessage.id || !channel.selectionHint) throw new Error("read_channel did not report the selection");
if (!channel.messages.some((m) => m.selected === true)) throw new Error("read_channel did not flag the selected message");
console.log(`read_channel: ${channel.count} messages, selection flagged, hint present`);

// "Reply to this" — no parent_id; the tool must default to the selected message.
const text = `e2e ${new Date().toISOString()}: proposed by the browser agent, signed by the human.`;
const reply = await call("propose_reply", { content: text });
console.log(`propose_reply (no parent_id) -> ${reply.slice(0, 80)}…`);
if (shots) await page.screenshot({ path: `${shots}/proposal.png` });

await page.getByRole("button", { name: /sign & send/i }).first().click();
await page.waitForSelector("text=signed by you", { timeout: 15000 });
if (shots) await page.screenshot({ path: `${shots}/signed.png` });

// The reply must thread under the selected message — check the page's own view of the thread.
const thread = JSON.parse(await call("read_thread", { root_id: view.selectedMessage.id }));
if (!thread.messages.some((m) => m.content === text)) throw new Error("signed reply not in the thread");
console.log(`read_thread: reply present under ${view.selectedMessage.id.slice(0, 12)}`);

// Reload: the selection must survive (agent browsers reload between click and tool call).
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".msg", { timeout: 20000 });
const after = JSON.parse(await call("get_current_view", {}));
if (after.selectedMessage?.id !== view.selectedMessage.id) throw new Error("selection did not survive a reload");
console.log("reload: selection restored");

if (/[?&]relay=mock/.test(url)) {
  await browser.close();
  if (problems.length) { console.log("problems:\n" + problems.join("\n")); process.exit(1); }
  console.log("OK (mock relay) — agent proposed, human signed, thread + selection persistence verified.");
  process.exit(0);
}

const sk = generateSecretKey();
const relay = await Relay.connect(relayUrl);
for (let i = 0; i < 50 && !relay.challenge; i++) await new Promise((r) => setTimeout(r, 100));
await relay.auth((t) => finalizeEvent(t, sk));
const found = [];
await new Promise((res) => relay.subscribe([{ kinds: [9], "#e": [view.selectedMessage.id], limit: 20 }], { onevent: (e) => found.push(e), oneose: res }));
relay.close();
const mine = found.find((e) => e.content === text);
if (!mine) throw new Error("signed reply not found on relay");
const prov = mine.tags.find((t) => t[0] === "proposed-by");
console.log(`relay: found reply ${mine.id.slice(0, 12)} from ${mine.pubkey.slice(0, 12)} tags=${JSON.stringify(mine.tags.filter((t) => ["client", "proposed-by"].includes(t[0])))}`);
if (!prov || prov[1] !== "webmcp") throw new Error("provenance tag missing");

await browser.close();
if (problems.length) { console.log("problems:\n" + problems.join("\n")); process.exit(1); }
console.log("OK — agent proposed, human signed, relay has it, provenance intact.");

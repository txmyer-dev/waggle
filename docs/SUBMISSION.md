# Submission kit — The WebMCP Challenge

Deadline: **Wednesday 3 September 2026, 1:00 PM PDT** (4:00 PM EDT). Devpost: https://webmcp.devpost.com/

## Checklist

- [ ] Live URL works in the **ChatGPT desktop app's built-in browser** (GPT-5.6 Sol/Terra, Site tools on; address bar → Site tools lists 12)
- [ ] Live URL works in **Chrome 150+** with `chrome://flags/#enable-webmcp-testing` + the Model Context Tool Inspector extension (Gemini agent mode)
- [ ] The Devpost description tells judges exactly those two setups — Gemini-in-Chrome's side panel can't call tools yet and will say so
- [ ] `pnpm e2e https://app.waggle.thecrowbarcrew.cc/` passes from the laptop (real Chrome, real relay)
- [ ] Relay reseeded so the first thing a judge sees is the seeded team, not our test posts
- [ ] Video < 3:00, public on YouTube, audio, no third-party music/trademarks
- [ ] Repo public, `LICENSE` visible at the top of the GitHub page (MIT — done)
- [ ] Devpost form: title, tagline, description (below), video link, repo link, live URL, built-with tags
- [ ] Prior-work statement in the form (all code from 2026-09-01; see README)

## Devpost fields

**Title:** Waggle

**Tagline:** Your agent can dance. Only you can fly. A chat client where the browser's agent can read everything and sign nothing.

**Built with:** WebMCP · TypeScript · React · Vite · nostr-tools · Nostr (NIP-29/42/50) · Buzz relay · Docker · Traefik

### Inspiration

Every "agent in chat" design we have seen gives the agent an account: its own key, its own memberships, its own
audit trail. That is right for an agent that works in the room as a peer. It is wrong for the agent at your elbow —
the one reading over your shoulder that says "want me to answer that?" That agent should have **no key at all**.
WebMCP is the first thing that makes that agent practical: the tools live in your tab, under your session, and they
can see what you are looking at. No server, no OAuth, no bot account.

### What it does

Waggle is a small NIP-29 group-chat client that publishes twelve WebMCP tools. Seven are reads — the current view
(including the message you have selected), channels, a channel's messages, a thread, search, a member. Five are
`propose_*` tools — message, reply, reaction, channel topic, join. A proposal is not a post: it is a card in the
Waggles dock. You edit it, then **Sign & send** with a key the agent never touches, or reject it. The signed event
carries `["proposed-by","webmcp","<n>"]`, so anyone reading the relay can tell agent-drafted from hand-typed.

### How we built it

- `src/tools/` is framework-free and talks only to a `WaggleContext` interface, so the same tools can be lifted into
  another client. Registration uses `document.modelContext.registerTool` with `readOnlyHint` annotations on reads.
- `src/relay/` speaks NIP-29 + NIP-42 + NIP-50 over nostr-tools, with a mock relay for zero-network demos.
- Identity is NIP-07 if present, otherwise a key generated in the page. The demo relay is a real
  [Buzz](https://github.com/block/buzz) relay we deployed for this, open to throwaway keys so judges can post.
- `scripts/e2e.mjs` proves the loop through the browser's own API: `getTools()` → `executeTool()` → human click →
  event found on the relay by an unrelated key, provenance intact.

### Challenges

Chrome passes `execute()` its arguments as a JSON string, and `navigator.modelContext` is deprecated in favour of
`document.modelContext` — both learned by running the real browser, not the docs. The relay rejects events more than
15 minutes off server time, which shaped how we seed a believable conversation. And the hardest design question was
the smallest one: the button says **Sign & send**, not Send, because the word *sign* is the whole point.

### What's next

Carry the tools module into Buzz as a right-dock feature, and emit Buzz's reserved approval kinds (46010/46030) so a
proposal, its ruling, and the resulting message are three linked events in one log — the correction log an agent can
learn from.

## Video — beat sheet v2 (target 2:45) — "the agent works in the browser; I live in Buzz"

| t | Shot | Say |
|---|---|---|
| 0:00 | Title card, bee, tagline | "Waggle. Your agent can dance. Only you can fly." |
| 0:07 | Slide: member agent (own key) vs elbow agent (no key) | "Agents in chat usually get their own account. This is the other kind: the one at your elbow. It has no key. It can read everything I can see — and it can't post." |
| 0:22 | ChatGPT desktop → Work → built-in browser on Waggle; **Site tools** shows 12 | "Twelve WebMCP tools. Seven read. Five propose. None can send." |
| 0:32 | Split screen: Buzz desktop on the left (`#general`), ChatGPT+Waggle on the right. In Buzz, Marco asks: "does the shop have the leather bag under $200?" | "Here's my team, in Buzz. Marco has a question I'd have to go look up." |
| 0:45 | In ChatGPT: "Check the shop for a leather bag under $200 and answer Marco." Agent opens template.vercel.shop, calls its search tool, comes back to Waggle, calls `propose_reply` | "The agent uses the store's WebMCP tools, then Waggle's. Two sites, one errand." |
| 1:05 | Cut to **Buzz on the phone** (or Buzz desktop, `#waggle-drafts`): the 🐝 draft post appears — with the bag, the price, the link | "It didn't post. It proposed — into my private drafts room, on the relay I own." |
| 1:15 | Thumb taps ✅ in Buzz | "That reaction is a signed event by me." |
| 1:20 | Back to Buzz `#general`: Marco's thread — the reply lands, with the 🐝 badge | "And the tab that has my key signs the real reply. Buzz shows the bee: everyone can see an agent drafted it and I signed it." |
| 1:35 | Second draft in `#waggle-drafts`; **reply** to it in Buzz with better wording → lands with the edit | "Don't like the words? Reply with better ones. My edit is the correction — that log is the asset." |
| 1:44 | (optional, if time allows) Click **Hold the room** → "back at 5:00". Buzz shows status *🐝 agent drafting · rulings at 5:00 PM*. Say to ChatGPT: "handle what's waiting on me." Three drafts appear in `#waggle-drafts`. | "Stepping out? Tell the room. The agent drafts everything that's waiting; I rule the stack from my phone later." |
| 1:50 | Show event JSON: `client: waggle`, `proposed-by: webmcp` | "On the wire, every signed event says whether an agent drafted it." |
| 2:00 | Quick cut: Claude in Chrome typing into the composer | "A screenshot-and-click agent can still pretend to be me. No page can stop that. That's the point: WebMCP gives agents a door that isn't pretending to be the human." |
| 2:15 | Slide: `WaggleContext` seam · drafts channel = private NIP-29 group · rulings = plain kind 7 / kind 9 | "Buzz needed zero changes to be the gavel. The tools module drops into any client. Approval gates, no workflow engine." |
| 2:35 | End card: URL, repo | "Waggle. The agent dances. You decide whether to fly." |

Recording notes: same nsec in Buzz and Waggle (import the owner key from `~/waggle-relay/OWNER_KEY.txt` in both). Waggle tab stays open the whole time — it is the signer. Rehearse the ChatGPT segment three times and keep the best take. Phone shot: Buzz mobile if it runs; else Buzz desktop's `#waggle-drafts` is fine.

## Video — beat sheet v1 (superseded, kept for reference)

| t | Shot | Say |
|---|---|---|
| 0:00 | Title card, bee, tagline | "Waggle. Your agent can dance. Only you can fly." |
| 0:08 | Slide: two agents — member vs elbow | "Agents in chat usually get their own account. This is the other kind: the agent at your elbow. It has no key." |
| 0:25 | Chrome, Waggle open, WebMCP chip green | "This is a normal chat client on a Nostr relay. The page publishes eleven WebMCP tools. Six read. Five propose. None can post." |
| 0:40 | Ask agent: "What did I miss in #general?" | Agent answers from `read_channel`. "It reads what I can see — same session, same tab." |
| 0:58 | Click Priya's message. Ask: "Reply to this saying we turned it off because judges arrive with throwaway keys." | "‘This’ works, because the selection is part of the view the tools expose." |
| 1:15 | Card appears in the Waggles dock. Edit one word. | "It didn't post. It proposed. I can change it, reject it, or sign it." |
| 1:30 | Click **Sign & send**. Message appears in the channel. Split screen: Buzz desktop shows it landing. | "Signed with my key, which the agent never had. It's on a real Buzz relay." |
| 1:50 | Ask: "React 👍 to Sam's message about the mobile build." → card → sign | "Reactions, topics, joins — same path. Propose, then rule." |
| 2:05 | Show event JSON: `client: waggle`, `proposed-by: webmcp` | "Every signed event says whether an agent drafted it. That tag is the audit trail — and the training data." |
| 2:12 | Quick cut: a computer-use agent typing into the composer | "A screenshot-and-click agent can still pretend to be me — no page can stop that. That's the point: WebMCP gives agents a door that isn't pretending to be the human." |
| 2:20 | Slide: `WaggleContext` interface + right-dock in Buzz | "The tools module is framework-free. It drops into Buzz as one more dock. Approval gates, with no workflow engine." |
| 2:35 | End card: URL, repo | "Waggle. The agent dances. You decide whether to fly." |

Recording notes: 1440×900 window, dark theme, hide bookmarks bar, `?relay=` default (live), a fresh key so the npub
in the header isn't yours. Rehearse once with `?relay=mock` so the agent's answers are predictable, then record live.

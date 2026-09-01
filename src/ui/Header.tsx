import { useState } from "react";
import { store } from "../app/store.ts";
import { hasNip07, shortNpub } from "../identity/identity.ts";
import { useAppState, useProposals } from "./useStore.ts";

export function Header() {
  const s = useAppState();
  const proposals = useProposals();
  const pending = proposals.filter((p) => p.status === "pending").length;
  const [open, setOpen] = useState<null | "identity" | "webmcp" | "rulings" | "away">(null);
  const away = s.away;
  const rulings = s.rulings;
  const rulingsDot = rulings.enabled ? "ok" : rulings.error ? "bad" : "muted";

  const relayLabel = s.relayUrl === "mock" ? "mock relay" : s.relayUrl.replace(/^wss?:\/\//, "");
  const relayDot =
    s.relayStatus === "connected" ? "ok" : s.relayStatus === "connecting" ? "warn" : s.relayStatus === "idle" ? "muted" : "bad";
  const toolCount = s.webmcp.registered.length;

  return (
    <header className="header">
      <div className="brand">
        <span className="bee" aria-hidden>
          🐝
        </span>
        <span className="brand-name">Waggle</span>
        <span className="tagline">Your agent can dance. Only you can fly.</span>
      </div>
      <div className="chips">
        <span className={`chip dot-${relayDot}`} title={s.relayError ?? s.relayStatus}>
          <i className="dot" /> {relayLabel}
        </span>
        <button className={`chip chip-btn ${s.webmcp.available ? "dot-ok" : "dot-muted"}`} onClick={() => setOpen(open === "webmcp" ? null : "webmcp")}>
          <i className="dot" /> WebMCP {s.webmcp.available ? `· ${toolCount} tools` : "· off"}
        </button>
        <button
          className={`chip chip-btn dot-${rulingsDot}`}
          title="Rule on proposals from Buzz (or any Nostr client) with a ✅ / ❌ reaction"
          onClick={() => setOpen(open === "rulings" ? null : "rulings")}
        >
          <i className="dot" /> Rule from Buzz {rulings.busy ? "· …" : rulings.enabled ? "· on" : "· off"}
        </button>
        <button
          className={`chip chip-btn ${away ? "chip-accent" : ""}`}
          title="Hold the room: tell Buzz you're away, let the agent draft, rule later"
          onClick={() => setOpen(open === "away" ? null : "away")}
        >
          {away ? `🐝 Away until ${fmtTime(away.until)}` : "Hold the room"}
        </button>
        <button className="chip chip-btn" onClick={() => setOpen(open === "identity" ? null : "identity")}>
          🔑 {s.identity ? shortNpub(s.identity.npub) : "…"}
          <span className="muted"> · {s.identity?.source === "nip07" ? "extension" : "local key"}</span>
        </button>
        {pending > 0 ? <span className="chip chip-accent">{pending} waiting</span> : null}
      </div>
      {open === "webmcp" ? <WebmcpPopover onClose={() => setOpen(null)} /> : null}
      {open === "rulings" ? <RulingsPopover onClose={() => setOpen(null)} /> : null}
      {open === "away" ? <AwayPopover onClose={() => setOpen(null)} /> : null}
      {open === "identity" ? <IdentityPopover onClose={() => setOpen(null)} /> : null}
    </header>
  );
}

function fmtTime(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function toLocalInput(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AwayPopover({ onClose }: { onClose: () => void }) {
  const s = useAppState();
  const [until, setUntil] = useState(() => toLocalInput(s.away?.until ?? Math.floor(Date.now() / 1000) + 2 * 3600));
  const [note, setNote] = useState(s.away?.note ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <div className="popover">
      <div className="popover-head">
        <strong>Hold the room</strong>
        <button className="btn btn-ghost" onClick={onClose}>
          ×
        </button>
      </div>
      <p>
        Step away and let the agent hold the room. Buzz shows your status as <strong>🐝 agent drafting · rulings at
        {" "}{fmtTime(Math.floor(new Date(until).getTime() / 1000) || 0)}</strong>, so the team can tell the difference between you
        and your agent. The agent sees you're away, drafts a reply for everything waiting on you (<code>find_waiting_on_me</code>),
        and the drafts pile up in <code>#waggle-drafts</code> for you to rule from your phone.
      </p>
      <div className="row">
        <label className="small muted">
          Back at{" "}
          <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row">
        {s.away ? (
          <button
            className="btn btn-accent"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await store.clearAway();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            I'm back
          </button>
        ) : null}
        <button
          className={`btn ${s.away ? "btn-ghost" : "btn-accent"}`}
          disabled={busy || !until}
          onClick={async () => {
            setBusy(true);
            try {
              await store.setAway(Math.floor(new Date(until).getTime() / 1000), note);
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {s.away ? "Update" : "I'm away"}
        </button>
      </div>
    </div>
  );
}

function RulingsPopover({ onClose }: { onClose: () => void }) {
  const s = useAppState();
  const r = s.rulings;
  const channel = r.channelId ? s.channels.find((c) => c.id === r.channelId) : undefined;
  return (
    <div className="popover">
      <div className="popover-head">
        <strong>Rule from Buzz</strong>
        <button className="btn btn-ghost" onClick={onClose}>
          ×
        </button>
      </div>
      <p>
        When this is on, every proposal is also posted — under your key — into a <strong>private</strong> channel on this relay,
        {channel ? <code> #{channel.name}</code> : <code> #waggle-drafts</code>}. Open that channel in Buzz on your desktop or phone and
        rule there: react <strong>✅</strong> to sign &amp; send, <strong>❌</strong> to reject, or <strong>reply with the text you'd rather
        send</strong>. Your reaction is a signed event; this tab sees it and signs the real message. Keep this tab open — it is
        your signer.
      </p>
      <p className="muted small">
        Use the same key here and in Buzz (import your nsec from the 🔑 chip). Only reactions from this key count; a 👍 is just a
        👍.
      </p>
      {r.error ? <p className="error small">{r.error}</p> : null}
      <div className="row">
        <button className={`btn ${r.enabled ? "btn-ghost" : "btn-accent"}`} disabled={r.busy} onClick={() => void store.toggleRulings()}>
          {r.busy ? "Working…" : r.enabled ? "Turn off" : "Turn on"}
        </button>
        {r.enabled && channel ? (
          <button className="btn btn-ghost" onClick={() => void store.openChannel(channel.id)}>
            Open #{channel.name} here
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WebmcpPopover({ onClose }: { onClose: () => void }) {
  const s = useAppState();
  return (
    <div className="popover">
      <div className="popover-head">
        <strong>WebMCP</strong>
        <button className="btn btn-ghost" onClick={onClose}>
          ×
        </button>
      </div>
      {s.webmcp.available ? (
        <>
          <p>
            This page has published <strong>{s.webmcp.registered.length}</strong> tools into <code>document.modelContext</code>. Your
            browser's agent can call the read tools freely; the <code>propose_*</code> tools only put cards in the Waggles dock.
          </p>
          <ul className="tool-list">
            {s.webmcp.registered.map((n) => (
              <li key={n}>
                <code>{n}</code>
              </li>
            ))}
          </ul>
          {s.webmcp.errors.length ? <p className="muted">Failed: {s.webmcp.errors.map((e) => `${e.name} (${e.error})`).join(", ")}</p> : null}
        </>
      ) : (
        <>
          <p>
            <code>document.modelContext</code> is not available in this browser, so the tools are defined but not published.
          </p>
          <ol>
            <li>
              In Chrome 149+, open <code>chrome://flags/#enable-webmcp-testing</code>, set it to <em>Enabled</em>, relaunch.
            </li>
            <li>Or open this page inside ChatGPT's in-app browser, which speaks WebMCP natively.</li>
            <li>
              To poke the tools by hand without an agent, add <code>?dev=1</code> to the URL.
            </li>
          </ol>
        </>
      )}
    </div>
  );
}

function IdentityPopover({ onClose }: { onClose: () => void }) {
  const s = useAppState();
  const [nsec, setNsec] = useState("");
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = s.identity;
  if (!id) return null;
  const exported = id.exportNsec();
  return (
    <div className="popover">
      <div className="popover-head">
        <strong>Your key</strong>
        <button className="btn btn-ghost" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="mono small">{id.npub}</p>
      <p className="muted">
        {id.source === "nip07"
          ? "Signing through your NIP-07 extension. The key never enters this page."
          : hasNip07()
            ? "Using a local key even though an extension is present. Reload to use the extension."
            : "A key generated in this browser and kept in localStorage. Nothing left this tab."}
      </p>
      {exported ? (
        <div className="row">
          <button className="btn btn-ghost" onClick={() => setReveal(!reveal)}>
            {reveal ? "Hide nsec" : "Show nsec"}
          </button>
          {reveal ? <code className="mono small break">{exported}</code> : null}
        </div>
      ) : null}
      <div className="row">
        <input className="input" placeholder="nsec1… to import" value={nsec} onChange={(e) => setNsec(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            try {
              setErr(null);
              await store.replaceIdentity(nsec);
              setNsec("");
              onClose();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Import
        </button>
        <button className="btn btn-ghost" onClick={() => store.replaceIdentity(null)}>
          New key
        </button>
      </div>
      {err ? <p className="error">{err}</p> : null}
    </div>
  );
}

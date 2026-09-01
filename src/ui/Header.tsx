import { useState } from "react";
import { store } from "../app/store.ts";
import { hasNip07, shortNpub } from "../identity/identity.ts";
import { useAppState, useProposals } from "./useStore.ts";

export function Header() {
  const s = useAppState();
  const proposals = useProposals();
  const pending = proposals.filter((p) => p.status === "pending").length;
  const [open, setOpen] = useState<null | "identity" | "webmcp">(null);

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
        <button className="chip chip-btn" onClick={() => setOpen(open === "identity" ? null : "identity")}>
          🔑 {s.identity ? shortNpub(s.identity.npub) : "…"}
          <span className="muted"> · {s.identity?.source === "nip07" ? "extension" : "local key"}</span>
        </button>
        {pending > 0 ? <span className="chip chip-accent">{pending} waiting</span> : null}
      </div>
      {open === "webmcp" ? <WebmcpPopover onClose={() => setOpen(null)} /> : null}
      {open === "identity" ? <IdentityPopover onClose={() => setOpen(null)} /> : null}
    </header>
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

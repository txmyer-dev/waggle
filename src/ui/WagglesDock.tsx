import { useState } from "react";
import { store } from "../app/store.ts";
import type { Proposal } from "../proposals/store.ts";
import { shortId, timeAgo } from "./format.ts";
import { useProposals } from "./useStore.ts";

export function WagglesDock() {
  const proposals = useProposals();
  const pending = proposals.filter((p) => p.status === "pending");
  const done = proposals.filter((p) => p.status !== "pending");
  return (
    <aside className="col col-dock">
      <div className="col-head">
        Waggles
        <span className="muted"> · what your agent proposes</span>
      </div>
      {proposals.length === 0 ? (
        <div className="pad muted dock-empty">
          <p>
            Nothing on the table. When your browser's agent calls a <code>propose_*</code> tool, the draft lands here for you to
            edit, sign, or reject.
          </p>
          <p>Try asking it: “What did I miss in this channel? Draft a reply to the selected message.”</p>
        </div>
      ) : null}
      <div className="cards">
        {pending.map((p) => (
          <Card key={p.id} p={p} />
        ))}
        {done.length ? <div className="muted small pad-x">Earlier</div> : null}
        {done.map((p) => (
          <Card key={p.id} p={p} />
        ))}
      </div>
    </aside>
  );
}

function editableField(p: Proposal): { key: "content" | "topic" | "emoji" | "reason"; value: string; label: string } | null {
  switch (p.draft.kind) {
    case "message":
    case "reply":
      return { key: "content", value: p.draft.content, label: "Message" };
    case "topic":
      return { key: "topic", value: p.draft.topic, label: "Topic" };
    case "reaction":
      return { key: "emoji", value: p.draft.emoji, label: "Reaction" };
    case "join":
      return { key: "reason", value: p.draft.reason, label: "Reason" };
  }
}

const KIND_LABEL: Record<Proposal["draft"]["kind"], string> = {
  message: "New message",
  reply: "Reply",
  reaction: "Reaction",
  topic: "Channel topic",
  join: "Join channel",
};

function Card({ p }: { p: Proposal }) {
  const field = editableField(p);
  const [busy, setBusy] = useState(false);
  const pending = p.status === "pending";
  return (
    <article className={`card status-${p.status}`}>
      <div className="card-head">
        <span className="card-kind">
          🐝 #{p.id} · {KIND_LABEL[p.draft.kind]}
          {p.channelName ? <span className="muted"> in #{p.channelName}</span> : null}
        </span>
        <span className="muted small">{timeAgo(Math.floor(p.createdAt / 1000))}</span>
      </div>
      {p.target ? (
        <blockquote className="card-target">
          <span className="muted small">{store.authorName(p.target.pubkey)}: </span>
          {p.target.content}
        </blockquote>
      ) : null}
      {field ? (
        pending ? (
          <textarea
            className="card-edit"
            rows={field.key === "content" ? 3 : 1}
            value={field.value}
            onChange={(e) => store.proposals.edit(p.id, { [field.key]: e.target.value })}
            aria-label={field.label}
          />
        ) : (
          <div className="card-text">{field.value || <span className="muted">(empty)</span>}</div>
        )
      ) : null}
      <div className="card-foot">
        {pending ? (
          <>
            <button
              className="btn btn-accent"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await store.approveProposal(p.id);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Signing…" : "Sign & send"}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => store.proposals.reject(p.id)}>
              Reject
            </button>
            <span className="muted small">drafted by agent · unsigned</span>
          </>
        ) : p.status === "sent" ? (
          <span className="small">
            ✅ signed by you · event <code className="mono">{shortId(p.eventId ?? "")}</code>
          </span>
        ) : p.status === "failed" ? (
          <>
            <span className="error small">✗ {p.error}</span>
            <button className="btn btn-ghost small" onClick={() => store.proposals.retry(p.id)}>
              Retry
            </button>
          </>
        ) : (
          <span className="muted small">rejected · nothing was signed</span>
        )}
      </div>
    </article>
  );
}

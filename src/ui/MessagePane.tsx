import { useEffect, useRef, useState } from "react";
import { store } from "../app/store.ts";
import type { Message } from "../relay/types.ts";
import { shortId, timeAgo } from "./format.ts";
import { useAppState } from "./useStore.ts";

export function MessagePane() {
  const s = useAppState();
  const ch = s.channels.find((c) => c.id === s.currentChannelId) ?? null;
  const all = ch ? (s.messages[ch.id] ?? []) : [];
  const inThread = s.threadRootId;
  const list = inThread ? all.filter((m) => m.id === inThread || m.rootId === inThread) : all.filter((m) => !m.rootId);
  const replyCounts = new Map<string, number>();
  for (const m of all) if (m.rootId) replyCounts.set(m.rootId, (replyCounts.get(m.rootId) ?? 0) + 1);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [list.length, ch?.id, inThread]);

  return (
    <section className="col col-messages">
      <div className="col-head">
        {ch ? (
          <>
            <span className="hash">#</span>
            <strong>{ch.name}</strong>
            {inThread ? (
              <>
                <span className="muted"> › thread</span>
                <button className="btn btn-ghost small" onClick={() => store.openThread(null)}>
                  back to channel
                </button>
              </>
            ) : ch.topic ? (
              <span className="topic">{ch.topic}</span>
            ) : null}
          </>
        ) : (
          <span className="muted">Pick a channel</span>
        )}
      </div>
      <div className="messages">
        {list.length === 0 && ch && !s.booting ? <div className="muted pad">Nothing here yet. Say something, or ask your agent what it sees.</div> : null}
        {list.map((m) => (
          <MessageRow key={m.id} m={m} selected={m.id === s.selectedMessageId} replies={replyCounts.get(m.id) ?? 0} inThread={!!inThread} />
        ))}
        <div ref={endRef} />
      </div>
      <Composer />
    </section>
  );
}

function MessageRow({ m, selected, replies, inThread }: { m: Message; selected: boolean; replies: number; inThread: boolean }) {
  const proposed = m.tags.find((t) => t[0] === "proposed-by");
  const mine = store.state.identity?.pubkey === m.pubkey;
  return (
    <article
      className={`msg ${selected ? "selected" : ""} ${mine ? "mine" : ""} ${inThread && m.rootId ? "reply" : ""}`}
      onClick={() => store.selectMessage(selected ? null : m.id)}
      onDoubleClick={() => store.openThread(m.rootId ?? m.id)}
      title={`id ${shortId(m.id)} — click to select, double-click for thread`}
    >
      <div className="msg-meta">
        <span className="author">{store.authorName(m.pubkey)}</span>
        <span className="muted">{timeAgo(m.created_at)}</span>
        {proposed ? (
          <span className="tag-prov" title={`Drafted by the agent as proposal #${proposed[2]}, signed by the human`}>
            🐝 signed from #{proposed[2]}
          </span>
        ) : null}
        {selected ? <span className="tag-sel">selected · agents see this as “this message”</span> : null}
      </div>
      <div className="msg-body">{m.content}</div>
      <div className="msg-actions">
        {!inThread && replies > 0 ? (
          <button
            className="btn btn-ghost small"
            onClick={(e) => {
              e.stopPropagation();
              store.openThread(m.id);
            }}
          >
            {replies} {replies === 1 ? "reply" : "replies"}
          </button>
        ) : null}
        {!inThread && replies === 0 ? (
          <button
            className="btn btn-ghost small"
            onClick={(e) => {
              e.stopPropagation();
              store.openThread(m.id);
            }}
          >
            thread
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Composer() {
  const s = useAppState();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const replyTo = s.threadRootId;
  const disabled = !s.currentChannelId || s.relayStatus !== "connected" || busy;
  async function send() {
    if (!text.trim() || disabled) return;
    setBusy(true);
    try {
      await store.sendHuman(text, replyTo);
      setText("");
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input
        className="input"
        placeholder={replyTo ? "Reply in thread as yourself…" : "Say something as yourself…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />
      <button className="btn" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}

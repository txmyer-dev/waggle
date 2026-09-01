import { store } from "../app/store.ts";
import { useAppState } from "./useStore.ts";

export function ChannelList() {
  const s = useAppState();
  return (
    <aside className="col col-channels">
      <div className="col-head">Channels</div>
      {s.booting && s.channels.length === 0 ? <div className="muted pad">Connecting…</div> : null}
      {!s.booting && s.channels.length === 0 ? (
        <div className="muted pad">No channels visible on this relay yet.</div>
      ) : null}
      <ul className="channel-list">
        {s.channels.map((c) => (
          <li key={c.id}>
            <button className={`channel ${c.id === s.currentChannelId ? "active" : ""}`} onClick={() => store.openChannel(c.id)}>
              <span className="hash">#</span>
              {c.name}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

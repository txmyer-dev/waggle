import { store } from "../app/store.ts";
import { ChannelList } from "./ChannelList.tsx";
import { DevPanel } from "./DevPanel.tsx";
import { Header } from "./Header.tsx";
import { MessagePane } from "./MessagePane.tsx";
import { WagglesDock } from "./WagglesDock.tsx";
import { useAppState } from "./useStore.ts";

export function App() {
  const s = useAppState();
  return (
    <div className="app">
      <Header />
      {s.bootError ? (
        <div className="banner banner-error">
          <strong>Could not reach the relay.</strong> {s.bootError}{" "}
          <button className="btn btn-ghost" onClick={() => store.boot()}>
            Retry
          </button>{" "}
          <a className="link" href="?relay=mock">
            Use the built-in mock relay
          </a>
        </div>
      ) : null}
      <main className="columns">
        <ChannelList />
        <MessagePane />
        <WagglesDock />
      </main>
      {s.flags.dev ? <DevPanel /> : null}
    </div>
  );
}

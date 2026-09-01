import { useState } from "react";
import { useAppState } from "./useStore.ts";

/** `?dev=1`: call any tool by hand. Same definitions the agent gets. */
export function DevPanel() {
  const s = useAppState();
  const [name, setName] = useState(s.tools[0]?.name ?? "");
  const [args, setArgs] = useState("{}");
  const [out, setOut] = useState("");
  const tool = s.tools.find((t) => t.name === name) ?? s.tools[0];
  return (
    <div className="devpanel">
      <div className="row">
        <strong>Tool bench</strong>
        <select className="input" value={tool?.name ?? ""} onChange={(e) => setName(e.target.value)}>
          {s.tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <input className="input mono grow" value={args} onChange={(e) => setArgs(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            if (!tool) return;
            try {
              const parsed = args.trim() ? JSON.parse(args) : {};
              const res = await tool.execute(parsed);
              setOut(typeof res === "string" ? res : JSON.stringify(res));
            } catch (e) {
              setOut(`Error: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          Run
        </button>
      </div>
      {tool ? <div className="muted small">{tool.description}</div> : null}
      <pre className="devout">{out}</pre>
    </div>
  );
}

// Publish the tools into the page's model context. Verified 2026-09-01
// against the WebMCP explainer (webmachinelearning/webmcp) and Chrome's
// demos (GoogleChromeLabs/webmcp-tools): the global is
// `document.modelContext`, registration is `registerTool(tool, { signal })`,
// and Chrome's own demos return a plain string from `execute`. We follow the
// demos. Feature-detect, never assume.

import { buildWaggleTools } from "./tools.ts";
import type { ModelContextLike, ToolDefinition, WaggleContext } from "./types.ts";

export type RegisterResult = {
  webmcpAvailable: boolean;
  tools: ToolDefinition[];
  registered: string[];
  errors: { name: string; error: string }[];
};

export function detectModelContext(doc: unknown = globalThis.document): ModelContextLike | null {
  const d = doc as { modelContext?: ModelContextLike } | undefined;
  const mc = d?.modelContext;
  return mc && typeof mc.registerTool === "function" ? mc : null;
}

/**
 * Register every Waggle tool with the page's model context. Returns the
 * definitions either way so a host can drive them by hand (Waggle's `?dev=1`
 * panel does exactly that) when WebMCP is not present.
 */
export async function registerWaggleTools(
  ctx: WaggleContext,
  opts: { signal?: AbortSignal; modelContext?: ModelContextLike | null } = {},
): Promise<RegisterResult> {
  const tools = buildWaggleTools(ctx);
  const mc = opts.modelContext === undefined ? detectModelContext() : opts.modelContext;
  if (!mc) return { webmcpAvailable: false, tools, registered: [], errors: [] };

  const registered: string[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const tool of tools) {
    try {
      await mc.registerTool(wrapExecute(tool), { signal: opts.signal });
      registered.push(tool.name);
    } catch (e) {
      errors.push({ name: tool.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { webmcpAvailable: true, tools, registered, errors };
}

/**
 * Agents read tool output as text, so an exception should come back as a
 * sentence, not a rejected promise the browser turns into a generic failure.
 */
function wrapExecute(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    execute: async (params, execCtx) => {
      try {
        const out = await tool.execute(params ?? {}, execCtx);
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `Error from ${tool.name}: ${msg}`;
      }
    },
  };
}

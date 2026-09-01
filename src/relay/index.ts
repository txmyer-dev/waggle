import { MockRelay } from "./mockRelay.ts";
import { NostrRelay } from "./nostrRelay.ts";
import type { RelayClient } from "./types.ts";

export const DEFAULT_RELAY_URL = "wss://waggle.thecrowbarcrew.cc";

/** `?relay=mock` for the in-memory relay, `?relay=wss://…` to point elsewhere. */
export function relayUrlFromLocation(search: string = globalThis.location?.search ?? ""): string {
  const param = new URLSearchParams(search).get("relay");
  if (!param) return DEFAULT_RELAY_URL;
  if (param === "mock") return "mock";
  if (/^wss?:\/\//.test(param)) return param;
  return `wss://${param}`;
}

export function createRelay(url: string): RelayClient {
  return url === "mock" ? new MockRelay() : new NostrRelay(url);
}

export type * from "./types.ts";

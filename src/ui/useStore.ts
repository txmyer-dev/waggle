import { useSyncExternalStore } from "react";
import { store } from "../app/store.ts";
import type { Proposal } from "../proposals/store.ts";

export function useAppState() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useProposals(): readonly Proposal[] {
  return useSyncExternalStore(
    (l) => store.proposals.subscribe(l),
    () => store.proposals.snapshot(),
    () => store.proposals.snapshot(),
  );
}

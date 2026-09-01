// Who is signing. Either a NIP-07 extension (the key never enters this page)
// or a key we generated and keep in localStorage. Either way, this is the
// only module that can produce a signature, and nothing in src/tools imports it.

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";
import type { SignedEvent, Signer, UnsignedEvent } from "../relay/types.ts";

export type IdentitySource = "nip07" | "local";

export type Identity = {
  pubkey: string;
  npub: string;
  source: IdentitySource;
  sign: Signer;
  /** nsec for a local key; null for NIP-07, which never exposes it. */
  exportNsec(): string | null;
};

type Nip07 = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent & { pubkey?: string }): Promise<SignedEvent>;
};

const STORAGE_KEY = "waggle.nsec";

function nip07(): Nip07 | null {
  const w = globalThis as unknown as { nostr?: Nip07 };
  return w.nostr && typeof w.nostr.signEvent === "function" ? w.nostr : null;
}

export function hasNip07(): boolean {
  return nip07() !== null;
}

function readStoredSecret(): Uint8Array | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const decoded = nip19.decode(raw);
    return decoded.type === "nsec" ? decoded.data : null;
  } catch {
    return null;
  }
}

function storeSecret(secret: Uint8Array): void {
  try {
    localStorage.setItem(STORAGE_KEY, nip19.nsecEncode(secret));
  } catch {
    // Private mode or blocked storage: the key lives for this tab only.
  }
}

export function localIdentityFromSecret(secret: Uint8Array): Identity {
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    source: "local",
    sign: async (template) => finalizeEvent(template, secret) as SignedEvent,
    exportNsec: () => nip19.nsecEncode(secret),
  };
}

async function nip07Identity(ext: Nip07): Promise<Identity> {
  const pubkey = await ext.getPublicKey();
  return {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    source: "nip07",
    sign: async (template) => ext.signEvent({ ...template, pubkey }),
    exportNsec: () => null,
  };
}

/**
 * Resolve the identity for this session: NIP-07 if the user has an
 * extension and it answers, else a stored local key, else a fresh one.
 */
export async function loadIdentity(opts: { preferLocal?: boolean } = {}): Promise<Identity> {
  const ext = nip07();
  if (ext && !opts.preferLocal) {
    try {
      return await nip07Identity(ext);
    } catch {
      // Extension declined; fall through to a local key.
    }
  }
  const stored = readStoredSecret();
  if (stored) return localIdentityFromSecret(stored);
  const fresh = generateSecretKey();
  storeSecret(fresh);
  return localIdentityFromSecret(fresh);
}

export function importNsec(nsec: string): Identity {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("That is not an nsec.");
  storeSecret(decoded.data);
  return localIdentityFromSecret(decoded.data);
}

export function regenerateLocalIdentity(): Identity {
  const fresh = generateSecretKey();
  storeSecret(fresh);
  return localIdentityFromSecret(fresh);
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

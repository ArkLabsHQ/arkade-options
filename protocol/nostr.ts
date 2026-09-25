import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";
import { SimplePool } from "nostr-tools/pool";

import { RFQ_KIND } from "./constants.ts";
import { parseWire, type Wire } from "./messages.ts";

type Sealed = {
  id: string;
  pubkey: string;
  content: string;
  kind: number;
  tags: string[][];
  created_at: number;
  sig: string;
};

export function nostrPubkey(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

export function seal(secretKey: Uint8Array, recipientPubkey: string, payload: Wire, now = Math.floor(Date.now() / 1000)): Sealed {
  const conversationKey = getConversationKey(secretKey, recipientPubkey);
  return finalizeEvent({
    kind: RFQ_KIND,
    created_at: now,
    tags: [["p", recipientPubkey]],
    content: encrypt(JSON.stringify(payload), conversationKey),
  }, secretKey);
}

export function openSealed(secretKey: Uint8Array, event: { pubkey: string; content: string }): Wire | null {
  try {
    const conversationKey = getConversationKey(secretKey, event.pubkey);
    const text = decrypt(event.content, conversationKey);
    return parseWire(JSON.parse(text));
  } catch {
    return null;
  }
}

export type Incoming = {
  from: string;
  message: Wire;
};

export type Transport = {
  publish(recipientPubkey: string, payload: Wire): Promise<void>;
  close(): void;
};

/**
 * One live subscription for kind 24859 events p-tagged to this key.
 * The pool reconnects the socket. If every relay drops the subscription, it is opened again.
 */
export function connectTransport(opts: {
  relays: string[];
  secretKey: Uint8Array;
  onMessage: (incoming: Incoming) => void;
}): Transport {
  if (opts.relays.length === 0) throw new Error("no relays");
  const pool = new SimplePool({ enableReconnect: true });
  const pubkey = nostrPubkey(opts.secretKey);
  const seen = new Set<string>();
  let stopped = false;
  let sub: { close: (reason?: string) => void } | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const listen = () => {
    if (stopped) return;
    sub = pool.subscribeMany(opts.relays, { kinds: [RFQ_KIND], "#p": [pubkey] }, {
      onevent(event) {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        const message = openSealed(opts.secretKey, event);
        if (message) opts.onMessage({ from: event.pubkey, message });
      },
      onclose() {
        if (stopped) return;
        retry = setTimeout(listen, 2000);
      },
    });
  };
  listen();

  return {
    async publish(recipientPubkey, payload) {
      const event = seal(opts.secretKey, recipientPubkey, payload);
      const results = pool.publish(opts.relays, event);
      await Promise.any(results);
    },
    close() {
      stopped = true;
      if (retry) clearTimeout(retry);
      sub?.close("desk stopped");
      pool.close(opts.relays);
    },
  };
}

/**
 * Subscribe, wait until a relay has finished its stored-event dump, publish, collect replies.
 * Kind 24859 is ephemeral, so the subscription has to be up before the request is sent.
 */
export async function collectReplies(opts: {
  relays: string[];
  secretKey: Uint8Array;
  recipients: string[];
  payload: Wire;
  timeoutMs: number;
  accept?: (incoming: Incoming) => boolean;
}): Promise<Incoming[]> {
  if (opts.relays.length === 0) throw new Error("no relays");
  const pool = new SimplePool({ enableReconnect: true });
  const pubkey = nostrPubkey(opts.secretKey);
  const found: Incoming[] = [];
  const seen = new Set<string>();
  let sub: { close: (reason?: string) => void } | undefined;
  try {
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(resolve, 1500);
      sub = pool.subscribeMany(opts.relays, { kinds: [RFQ_KIND], "#p": [pubkey] }, {
        onevent(event) {
          if (seen.has(event.id)) return;
          seen.add(event.id);
          const message = openSealed(opts.secretKey, event);
          if (!message) return;
          const incoming = { from: event.pubkey, message };
          if (opts.accept && !opts.accept(incoming)) return;
          found.push(incoming);
        },
        oneose() {
          clearTimeout(giveUp);
          resolve();
        },
      });
    });
    await Promise.all(opts.recipients.map(async (recipient) => {
      const event = seal(opts.secretKey, recipient, opts.payload);
      await Promise.any(pool.publish(opts.relays, event));
    }));
    await new Promise((resolve) => setTimeout(resolve, opts.timeoutMs));
    return found;
  } finally {
    sub?.close("request finished");
    pool.close(opts.relays);
  }
}

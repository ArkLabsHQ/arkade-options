/** Relays the page uses when a desk is pinned. */
export const RELAYS = [
  "wss://nostr.arkade.sh",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty prices the page from the
 * Deribit mark directly, until an operator pins a desk.
 */
export const PINNED_DESKS = [];

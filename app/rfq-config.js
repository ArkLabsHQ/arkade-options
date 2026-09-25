/** Relays the page uses when a desk is pinned. */
export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty keeps the simulated desks,
 * so the published page still quotes before an operator pins one.
 */
export const PINNED_DESKS = [];

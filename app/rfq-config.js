/** The page asks for quotes on this relay only. */
export const RELAYS = ["wss://nostr.arkade.sh"];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty prices the page from the
 * Deribit mark directly. The page only submits intents on the relay.
 */
export const PINNED_DESKS = [
  {
    name: "Mutinynet",
    pubkey: "eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9",
  },
];

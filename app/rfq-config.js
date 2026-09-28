/** The page asks for quotes on this relay only. */
export const RELAYS = ["wss://nostr.arkade.sh"];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty prices the page from the
 * Deribit mark directly.
 *
 * Temporary Mutinynet desk. Its pubkey is `GET /` on
 * https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/
 */
export const DESK_STATUS = "https://arkadeoptions-desk-jxdh3j-37969b-138-199-218-130.traefik.me/status";

export const PINNED_DESKS = [
  {
    name: "Mutinynet",
    pubkey: "eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9",
  },
];

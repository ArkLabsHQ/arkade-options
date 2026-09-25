/** The page asks for quotes on this relay only. */
export const RELAYS = ["wss://nostr.arkade.sh"];

/**
 * Nostr pubkeys of desks that quote arkade:BTC->arkade:BTC-OPTION.
 * The pubkey is the desk's x-only key. Empty prices the page from the
 * Deribit mark directly.
 *
 * Temporary Mutinynet desk. Its pubkey is `GET /` on
 * https://prod-mutinynet-optionsdesk-gk1vzy-1e84a5-138-199-218-130.traefik.me/
 */
export const PINNED_DESKS = [
  {
    name: "Mutinynet",
    pubkey: "688e2b847d04fea9e7ba817104ab3f2c590cfe486965a309a087e025172094c9",
  },
];

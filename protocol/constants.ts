export const PAIR = "arkade:BTC->arkade:BTC-OPTION";
/** Sealed RFQ. Kind 20000–29999 is ephemeral, and the payload is NIP-44 to one recipient. */
export const RFQ_KIND = 24859;
/** NIP-78 app data. One replaceable event per filled vault, tagged `arkade-option`. */
export const POSITION_KIND = 30078;
export const POSITION_TAG = "arkade-option";
// Mutinynet's unilateralExitDelay. Arkd refuses to cosign a vtxo whose shortest
// exit leaf is below this, and BIP68 seconds must be a multiple of 512.
export const EXIT = 2048n;
export const DUST_SATS = 330n;
export const QUOTE_TTL_S = 30;
export const LOCK_S = 180;
export const ARK_URL = "https://mutinynet.arkade.sh";
export const EMULATOR_URL = "https://emulator.mutinynet.arkade.sh";
export const Q_MIN = 10_000n;
export const Q_MAX = 1_000_000_000n;
export const PRICE_MAX = 1_000_000_000n;

export const DEFAULT_RELAYS = ["wss://nostr.arkade.sh"];

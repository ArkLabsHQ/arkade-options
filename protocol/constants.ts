export const PAIR = "arkade:BTC->arkade:BTC-OPTION";
export const RFQ_KIND = 24859;
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

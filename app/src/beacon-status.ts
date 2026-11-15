/**
 * Public constructor the page settles against. The oracle certificate is not
 * trusted by the browser, so this is a copy of GET /api/status on the
 * Mutinynet oracle. Replace it when that beacon changes.
 */
export const LIVE_BEACON_STATUS = {
  pubkeys: ["e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe"],
  assetId: "58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c20000",
  issueTxid: "58db69a7a8a64cd1b16fa7ec4dba2c49a62815d88d0f7a660e216c0206e975c2",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf849c8k9fmuplslxvex94jqct8d58l229c0jh2seve4ky0n3xy0rjwr978pd",
  args: {
    ctrlTxid: "c275e906026c210e667a0f8dd81528a6492cba4deca76fb1d14ca6a8a769db58",
    signersN: 1,
    threshold: 1,
    domain: "4254435553442d464958",
    expiryLag: 60,
    readFee: 1000,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
};

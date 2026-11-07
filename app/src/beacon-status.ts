/**
 * Public constructor the page settles against. The oracle certificate is not
 * trusted by the browser, so this is a copy of GET /api/status on the
 * Mutinynet oracle. Replace it when that beacon changes.
 */
export const LIVE_BEACON_STATUS = {
  pubkeys: ["e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe"],
  assetId: "71ae6a54fdd6c809e2d1fdfe4ae2d6ec56a136d16b5aae124e32d781fe6b28020000",
  issueTxid: "71ae6a54fdd6c809e2d1fdfe4ae2d6ec56a136d16b5aae124e32d781fe6b2802",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf842vvcuzurwzgn0w5kqh3wpucnyv6tmts77sju77aptxlef3c4fw65ynewu",
  args: {
    ctrlTxid: "02286bfe81d7324e12ae5a6bd136a156ecd6e24afefdd1e209c8d6fd546aae71",
    signersN: 1,
    threshold: 1,
    domain: "4254435553442d464958",
    expiryLag: 60,
    readFee: 1000,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
};

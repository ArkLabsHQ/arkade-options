/**
 * Public constructor the page settles against. The oracle certificate is not
 * trusted by the browser, so this is a copy of GET /api/status. Replace it
 * after the one-key beacon is issued. The previous committee coin is a
 * different script.
 */
export const LIVE_BEACON_STATUS = {
  pubkeys: ["e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe"],
  assetId: "76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da890000",
  issueTxid: "76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da89",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85kzzx3q8kt4h9krw7w36wz6yxucn2pzrts4c0tty5nzgth9nj39y2v8p8v",
  args: {
    ctrlTxid: "89da61e71871b60055380685fb3cd368af6e2b6fc33a6a695fe601767029ba76",
    signersN: 1,
    threshold: 1,
    domain: "4254435553442d464958",
    keyLag: 60,
    readFee: 1000,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
};

/**
 * Public constructor of the live Mutinynet beacon. The oracle serves the same
 * JSON, but its certificate is not trusted by the browser, so the page keeps a copy.
 * `issueTxid` is BEACON_TXID and must stay this coin.
 */
export const LIVE_BEACON_STATUS = {
  pubkeys: [
    "8b839812711b1e8c0f3599d198cf0b1b1156a8632a992523a6f136ec1e31a8d7",
    "40f855e05bb2f95ca83757f8b48016725181385851abbf4b2142ad12ba60fb0b",
    "afd2ad5556dbb7a3485218d4acd86c5ed4a3e5f3c1cbdd7ecf1e26e34c0aa164",
    "07fc9faaf31b49549b3bab719c3837987cd5aec026f93a017bdf8816705963bb",
    "1c37841579dc5cecfe9fdcf43ed2c701b3d634e953a840aadb1a4804ac915e5c",
  ],
  assetId: "76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da890000",
  issueTxid: "76ba29707601e65f696a3ac36f2b6eaf68d33cfb8506385500b67118e761da89",
  address: "tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf85kzzx3q8kt4h9krw7w36wz6yxucn2pzrts4c0tty5nzgth9nj39y2v8p8v",
  args: {
    ctrlTxid: "89da61e71871b60055380685fb3cd368af6e2b6fc33a6a695fe601767029ba76",
    threshold: 3,
    domain: "4254435553442d464958",
    keyLag: 60,
    readFee: 100,
    adminPk: "e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe",
    exit: 2048,
  },
};

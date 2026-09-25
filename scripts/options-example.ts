import { depositAddress } from "../app/src/fund.ts";
import { SingleKey } from "@arkade-os/sdk";

const writer = SingleKey.fromHex("0000000000000000000000000000000000000000000000000000000000000007");
const deposit = await depositAddress({
  kind: 0,
  strike: 9_000_000n,
  collateral: 10_000_000n,
  premium: 50_000n,
  expiry: 1_900_000_000n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
  writerHex: await writer.toHex(),
});
console.log(deposit);

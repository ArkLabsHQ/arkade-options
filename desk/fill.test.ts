import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hexToBytes } from "../protocol/hex.ts";
import { recoverFilled } from "./fill.ts";

const writer = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";
const intentScript = "51205327a5c6693c7f8f932418d934b5517509f3d01cc5a3a8f9e509503c15bcf5bd";
const fillB64 = readFileSync(fileURLToPath(new URL("../protocol/testdata/fill.b64", import.meta.url)), "utf8").trim();
const fillId = "ab".repeat(32);

test("recoverFilled classifies a spent intent via indexer history and fill.b64", async () => {
  const client = {
    indexer: {
      async getVtxos(filter: { scripts?: string[]; spentOnly?: boolean }) {
        assert.equal(filter.spentOnly, true);
        assert.deepEqual(filter.scripts, [intentScript]);
        return {
          vtxos: [{
            value: 20_000,
            arkTxId: fillId,
            spentBy: fillId,
          }],
        };
      },
      async getVirtualTxs(ids: string[]) {
        assert.deepEqual(ids, [fillId]);
        return { txs: [fillB64] };
      },
    },
  };

  const txid = await recoverFilled(client as never, hexToBytes(writer), intentScript, {
    collateral: 20_000n,
    premium: 414n,
    now: 1_790_380_800,
    deadline: 1_790_380_900,
  });
  assert.equal(txid, fillId);
});

import assert from "node:assert/strict";
import test from "node:test";

import { classifyIntent, psbtOutputs } from "./intent-state.ts";

const writer = "5120806de010d4f26b83a7d2b0cc29973a7ffc3b17d163651bfc4de55aec4cc8d44b";
const intent = "5120b81cbe74a0c932b6bf2424d28f867cab9fe09cc6eae887050be13dbd1b63d292";

test("a live intent coin after the deadline is refundable, not paid", () => {
  const seen = classifyIntent({
    coins: [{ value: 20_000n, spent: false, spentBy: "" }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.deepEqual(seen, { phase: "expired", refundable: true });
});

test("a live intent coin inside the window is waiting for payout", () => {
  const seen = classifyIntent({
    coins: [{ value: 20_000n, spent: false, spentBy: "" }],
    spends: {},
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 500,
    deadline: 1_000,
  });
  assert.equal(seen.phase, "funded");
  assert.equal(seen.refundable, false);
});

test("premium on the writer script is paid out, and the full coin back is a refund", () => {
  const paid = classifyIntent({
    coins: [{ value: 20_000n, spent: true, spentBy: "aa" }],
    spends: { aa: [{ amount: 383n, script: writer }, { amount: 20_000n, script: "5120" + "ab".repeat(32) }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.equal(paid.phase, "filled");
  const refunded = classifyIntent({
    coins: [{ value: 20_000n, spent: true, spentBy: "bb" }],
    spends: { bb: [{ amount: 20_000n, script: writer }] },
    collateral: 20_000n,
    premium: 383n,
    writerScript: writer,
    now: 2_000,
    deadline: 1_000,
  });
  assert.equal(refunded.phase, "refunded");
});

test("the deposit transaction pays the intent, not the writer", () => {
  const outputs = psbtOutputs("cHNidP8BAJYDAAAAASvbZaMpCvgryeO0CYwtsKTnI7xx4reCIs1RKMnNb9pQAAAAAAD/////AyBOAAAAAAAAIlEguBy+dKDJMra/JCTSj4Z8q5/gnMbq6IcFC+E9vRtj0pKsFgEAAAAAACJRIIBt4BDU8muDp9KwzCmXOn/8OxfRY2Ub/E3lWuxMyNRLAAAAAAAAAAAEUQJOcwAAAAAAAQErzGQBAAAAAAAiUSDo2O2v+0SQZj35FALDvPA1w3SED3TuSSRKNVQocKHQx0EU+7mvX5PiQjSBNbwc7tq9HvaunJqq1AzepanFFd1I6sivE6Y4c9EukYOeJEtIRGdY0EfEgUKxpQA5jYk+vd7gVEB1hkURCtBVH/DExnmHKc4vfC6bQ08LcJn9MizhzAqUrkWtHxmfq9ROyRioAJeLmdumpPlNq8Uk67SVvcrqGZtBQRQwEHiAjk97wNrf4p40sd+OrwEI7waxciJ0B168EHoSeq8Tpjhz0S6Rg54kS0hEZ1jQR8SBQrGlADmNiT693uBUQCdSreMKuLPJQ/+Q69t/EbqYgRQzZDxzN7wK3j9Ax583mq9vqDTTe8YbfCnicl8nnEXMPLnIPYCRydO7ct3cD6tCFcFQkpt0waBJVLeLS2A16XpeB4paDyjsltVHv+6azoA6wBD7N2PgKGU9Lbx0z8XVHNlk3GjWVtIdRhhQ0XnDqLKvRSD7ua9fk+JCNIE1vBzu2r0e9q6cmqrUDN6lqcUV3UjqyK0gMBB4gI5Pe8Da3+KeNLHfjq8BCO8GsXIidAdevBB6EnqswAjedGFwdHJlZXIBwCgDCABAsnUg38rsVYx+eM8+OLiYuopDz7Vycma64yxcWzrrMsVYqgusAcBEIPu5r1+T4kI0gTW8HO7avR72rpyaqtQM3qWpxRXdSOrIrSAwEHiAjk97wNrf4p40sd+OrwEI7waxciJ0B168EHoSeqwAAAAA");
  assert.equal(outputs[0]?.amount, 20_000n);
  assert.equal(outputs[0]?.script, intent);
  assert.equal(outputs[1]?.amount, 71_340n);
  assert.equal(outputs[1]?.script, writer);
});

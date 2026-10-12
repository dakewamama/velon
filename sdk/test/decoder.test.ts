import { expect, test } from "bun:test";
import { decodeEvent } from "../src/decoder.ts";
import { EVENT_IX_TAG } from "../src/constants.ts";

test("decodes SubscriptionCreated from known wire bytes", () => {
  const buf = new Uint8Array(9 + 32 + 32 + 32 + 8);
  buf.set(EVENT_IX_TAG, 0);
  buf[8] = 0; // SubscriptionCreated discriminator
  buf.fill(1, 9, 41);   // plan
  buf.fill(2, 41, 73);  // subscriber
  buf.fill(3, 73, 105); // mint
  new DataView(buf.buffer).setBigInt64(105, 42n, true); // created_ts

  const event = decodeEvent(buf);
  expect(event?.type).toBe("SubscriptionCreated");
  if (event?.type === "SubscriptionCreated") {
    expect(event.createdTs).toBe(42n);
  }
});

test("decodes SubscriptionTransfer with correct offsets for amount and timestamps", () => {
  const p = new Uint8Array(32 * 4 + 8 * 4 + 32);
  p.fill(1, 0, 32);
  p.fill(2, 32, 64);
  p.fill(3, 64, 96);
  p.fill(4, 96, 128);
  new DataView(p.buffer).setBigUint64(128, 1_000_000n, true);
  new DataView(p.buffer).setBigInt64(136, 1_700_000_000n, true);
  new DataView(p.buffer).setBigInt64(144, 1_700_003_600n, true);
  new DataView(p.buffer).setBigUint64(152, 1_000_000n, true);
  p.fill(5, 160, 192);

  const buf = new Uint8Array(9 + p.length);
  buf.set(EVENT_IX_TAG, 0);
  buf[8] = 2;
  buf.set(p, 9);

  const event = decodeEvent(buf);
  expect(event?.type).toBe("SubscriptionTransfer");
  if (event?.type === "SubscriptionTransfer") {
    expect(event.amount).toBe(1_000_000n);
    expect(event.periodStartTs).toBe(1_700_000_000n);
    expect(event.periodEndTs).toBe(1_700_003_600n);
    expect(event.amountPulledInPeriod).toBe(1_000_000n);
  }
});

test("returns null when EVENT_IX_TAG does not match", () => {
  const buf = new Uint8Array(20);
  const event = decodeEvent(buf);
  expect(event).toBeNull();
});
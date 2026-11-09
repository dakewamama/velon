import { expect, test } from "bun:test";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import { base58, delegation, event, EVENT_TAG, plan } from "../scripts/subscriptions.ts";

// Accounts written field by field in the program's own order, so offsets are checked, not assumed.
const keyOf = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const writer = () => {
  const parts: Uint8Array[] = [];
  const self = {
    byte: (value: number) => (parts.push(Uint8Array.of(value)), self),
    key: (byte: number) => (
      parts.push(Uint8Array.from(getAddressEncoder().encode(keyOf(byte) as Address))),
      self
    ),
    u64: (value: bigint) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, value, true);
      return (parts.push(bytes), self);
    },
    i64: (value: bigint) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, value, true);
      return (parts.push(bytes), self);
    },
    zeros: (length: number) => (parts.push(new Uint8Array(length)), self),
    done: () => Uint8Array.from(parts.flatMap((part) => [...part])),
  };
  return self;
};
// discriminator, version, bump, delegator, delegatee, payer, init_id
const header = (kind: number) => writer().byte(kind).byte(1).byte(255).key(1).key(2).key(3).i64(7n);

test("a fixed delegation names its delegatee, mint and remaining amount", () => {
  const data = header(2).key(4).key(5).u64(25_000_000n).i64(1_900_000_000n).done();
  expect(data.length).toBe(187);
  expect(delegation(data)).toEqual({
    kind: "fixed",
    delegator: keyOf(1),
    delegatee: keyOf(2),
    payer: keyOf(3),
    mint: keyOf(5),
    amount: 25_000_000n,
    expiry: 1_900_000_000n,
  });
});

test("a recurring delegation reads its per-period cap and period", () => {
  const data = header(3).key(4).key(5).i64(100n).u64(1_209_600n).i64(0n).u64(500_000_000n).u64(1n).done();
  expect(data.length).toBe(211);
  expect(delegation(data)).toMatchObject({
    kind: "recurring",
    mint: keyOf(5),
    periodSeconds: 1_209_600n,
    amount: 500_000_000n,
  });
});

test("a subscription's delegatee is its plan, with the terms it locked in", () => {
  const data = header(4).u64(49_000_000n).u64(720n).i64(1n).u64(0n).i64(2n).i64(0n).done();
  expect(data.length).toBe(155);
  expect(delegation(data)).toMatchObject({
    kind: "subscription",
    plan: keyOf(2),
    amount: 49_000_000n,
    periodHours: 720n,
    expiresAt: 0n,
  });
});

test("any other kind, version or length is not read", () => {
  const fixed = header(2).key(4).key(5).u64(1n).i64(1n).done();
  expect(delegation(fixed.slice(0, 186))).toBeUndefined();
  expect(delegation(Uint8Array.of(4, 1))).toBeUndefined();
  expect(delegation(Uint8Array.of(2, 1, 0))).toBeUndefined();
  expect(delegation(Uint8Array.from([...fixed, 0]))).toBeUndefined();
  expect(delegation(Uint8Array.from(fixed, (byte, index) => (index === 1 ? 2 : byte)))).toBeUndefined();
  expect(delegation(Uint8Array.from(fixed, (byte, index) => (index === 0 ? 5 : byte)))).toBeUndefined();
});

test("a plan lists its owner, status, terms, destinations, pullers and the merchant's link", () => {
  const uri = new TextEncoder().encode("https://example.com/plan");
  const data = writer()
    .byte(1)
    .key(9)
    .byte(254)
    .byte(1)
    .u64(3n)
    .key(5)
    .u64(49_000_000n)
    .u64(720n)
    .i64(1n)
    .i64(1_900_000_000n)
    .key(8)
    .zeros(96)
    .key(6)
    .zeros(32)
    .key(7)
    .zeros(32)
    .done();
  const full = Uint8Array.from([...data, ...uri, ...new Uint8Array(128 - uri.length)]);
  expect(full.length).toBe(491);
  expect(plan(full)).toEqual({
    owner: keyOf(9),
    open: true,
    mint: keyOf(5),
    amount: 49_000_000n,
    periodHours: 720n,
    endTs: 1_900_000_000n,
    destinations: [keyOf(8)],
    pullers: [keyOf(6), keyOf(7)],
    metadataUri: "https://example.com/plan",
  });
  // A sunset plan reads as closed; an unknown status is not read.
  expect(plan(Uint8Array.from(full, (byte, index) => (index === 34 ? 0 : byte)))?.open).toBe(false);
  expect(plan(Uint8Array.from(full, (byte, index) => (index === 34 ? 2 : byte)))).toBeUndefined();
});

const tagged = (kind: number, body: Uint8Array) => Uint8Array.from([...EVENT_TAG, kind, ...body]);

test("a subscription pull names its receiver account and the puller that signed", () => {
  const body = writer()
    .key(1)
    .key(2)
    .key(3)
    .key(4)
    .u64(1_000_000_000n)
    .i64(10n)
    .i64(20n)
    .u64(1_000_000_000n)
    .key(5)
    .key(6)
    .key(7)
    .done();
  expect(body.length).toBe(256);
  expect(event(tagged(2, body))).toEqual({
    kind: "pull",
    delegation: keyOf(1),
    delegator: keyOf(3),
    mint: keyOf(4),
    amount: 1_000_000_000n,
    receiver: keyOf(5),
    receiverTokenAccount: keyOf(6),
    puller: keyOf(7),
  });
  // The layout from before those fields existed leaves them absent.
  expect(event(tagged(2, body.subarray(0, 192)))).toMatchObject({
    receiverTokenAccount: undefined,
    puller: undefined,
  });
});

test("a fixed pull is signed by its delegatee and pays the receiver after the remaining amount", () => {
  const body = writer().key(1).key(2).key(3).key(4).u64(10n).u64(90n).key(5).key(6).done();
  expect(body.length).toBe(208);
  expect(event(tagged(3, body))).toMatchObject({
    delegation: keyOf(1),
    delegator: keyOf(2),
    puller: keyOf(3),
    amount: 10n,
    receiver: keyOf(5),
    receiverTokenAccount: keyOf(6),
  });
});

test("lifecycle events and unknown lengths", () => {
  const created = writer().key(1).key(2).key(3).i64(42n).key(4).done();
  expect(event(tagged(0, created))).toEqual({
    kind: "created",
    plan: keyOf(1),
    subscriber: keyOf(2),
    at: 42n,
    payer: keyOf(4),
  });
  expect(event(tagged(1, writer().key(1).key(2).i64(9n).done()))).toMatchObject({
    kind: "cancelled",
    expiresAt: 9n,
  });
  expect(event(tagged(2, new Uint8Array(255)))).toBeUndefined();
  expect(event(tagged(6, new Uint8Array(201)))).toBeUndefined();
  expect(event(Uint8Array.from([0, ...created]))).toBeUndefined();
});

test("base58 reads what the address encoder writes, leading zeros included", () => {
  for (const byte of [0, 1, 5, 255])
    expect(base58(keyOf(byte))).toEqual(Uint8Array.from(getAddressEncoder().encode(keyOf(byte) as Address)));
  expect(base58("11")).toEqual(new Uint8Array(2));
  expect(base58("0OIl")).toBeUndefined();
});

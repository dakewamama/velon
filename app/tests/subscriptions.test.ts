import { expect, test } from "bun:test";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import { delegation, plan } from "../scripts/subscriptions.ts";

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
  expect(delegation(Uint8Array.from([...fixed, 0]))).toBeUndefined();
  expect(delegation(Uint8Array.from(fixed, (byte, index) => (index === 1 ? 2 : byte)))).toBeUndefined();
  expect(delegation(Uint8Array.from(fixed, (byte, index) => (index === 0 ? 5 : byte)))).toBeUndefined();
});

test("a plan lists its owner, terms and only the pullers in use", () => {
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
    .i64(0n)
    .zeros(128)
    .key(6)
    .zeros(32)
    .key(7)
    .zeros(32)
    .zeros(128)
    .done();
  expect(data.length).toBe(491);
  expect(plan(data)).toEqual({
    owner: keyOf(9),
    mint: keyOf(5),
    amount: 49_000_000n,
    periodHours: 720n,
    pullers: [keyOf(6), keyOf(7)],
  });
});

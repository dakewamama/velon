import { getAddressDecoder, type Address } from "@solana/addresses";

// Solana Subscriptions account layouts, as program-v0.5.0 (mainnet) and the devnet build store them.
// Only the exact version-1 lengths are read; anything else is left for the runtime to refuse.

const address = getAddressDecoder();
const key = (data: Uint8Array, offset: number) => address.decode(data, offset) as Address;
const u64 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
const i64 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset + offset, 8).getBigInt64(0, true);

/// Where every delegation keeps its delegator; a wallet's delegations are found by this offset.
export const DELEGATOR_OFFSET = 3;
export const NONE = "11111111111111111111111111111111";

type Header = { delegator: Address; delegatee: Address; payer: Address };
export type Delegation =
  | (Header & { kind: "fixed"; mint: Address; amount: bigint; expiry: bigint })
  | (Header & { kind: "recurring"; mint: Address; amount: bigint; periodSeconds: bigint; expiry: bigint })
  | (Header & {
      kind: "subscription";
      plan: Address;
      amount: bigint;
      periodHours: bigint;
      expiresAt: bigint;
    });

/// A delegation account's header and terms. A subscription's delegatee is its plan.
export function delegation(data: Uint8Array): Delegation | undefined {
  if (data[1] !== 1) return undefined;
  const header = { delegator: key(data, 3), delegatee: key(data, 35), payer: key(data, 67) };
  if (data[0] === 2 && data.length === 187)
    return { ...header, kind: "fixed", mint: key(data, 139), amount: u64(data, 171), expiry: i64(data, 179) };
  if (data[0] === 3 && data.length === 211)
    return {
      ...header,
      kind: "recurring",
      mint: key(data, 139),
      periodSeconds: u64(data, 179),
      expiry: i64(data, 187),
      amount: u64(data, 195),
    };
  if (data[0] === 4 && data.length === 155)
    return {
      ...header,
      kind: "subscription",
      plan: header.delegatee,
      amount: u64(data, 107),
      periodHours: u64(data, 115),
      expiresAt: i64(data, 147),
    };
  return undefined;
}

export type Plan = { owner: Address; mint: Address; amount: bigint; periodHours: bigint; pullers: Address[] };

/// A merchant's plan: who owns it, the token and terms, and the pullers allowed to charge.
export function plan(data: Uint8Array): Plan | undefined {
  if (data[0] !== 1 || data.length !== 491) return undefined;
  return {
    owner: key(data, 1),
    mint: key(data, 43),
    amount: u64(data, 75),
    periodHours: u64(data, 83),
    pullers: [0, 1, 2, 3].map((index) => key(data, 235 + index * 32)).filter((puller) => puller !== NONE),
  };
}

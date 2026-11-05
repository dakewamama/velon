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

/// The self-CPI tag every Subscriptions event starts with, then one byte for its kind.
export const EVENT_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type Event =
  | { kind: "created"; plan: Address; subscriber: Address; at: bigint; payer?: Address }
  | { kind: "cancelled"; plan: Address; subscriber: Address; expiresAt: bigint }
  | { kind: "resumed"; plan: Address; subscriber: Address; at: bigint }
  | {
      kind: "pull";
      delegation: Address;
      delegator: Address;
      mint: Address;
      amount: bigint;
      receiver: Address;
      /// Absent from events emitted before subscriptions@2d7b45b, never guessed.
      receiverTokenAccount?: Address;
      /// The plan puller that signed, or the delegatee, which signs every fixed and recurring pull.
      puller?: Address;
    };

// Each event's payload length as the pinned builds emit it, and the shorter one from before
// subscriptions@2d7b45b; any other length is not read.
const LENGTHS: Record<number, [number, number?]> = {
  0: [32 * 4 + 8, 32 * 3 + 8],
  1: [32 * 2 + 8],
  2: [32 * 7 + 8 * 4, 32 * 5 + 8 * 4],
  3: [32 * 6 + 8 * 2, 32 * 5 + 8 * 2],
  4: [32 * 6 + 8 * 4, 32 * 5 + 8 * 4],
  5: [32 * 2 + 8],
};

/// One emitted event, read from an inner instruction's data.
export function event(raw: Uint8Array): Event | undefined {
  if (raw.length < 9 || EVENT_TAG.some((byte, index) => raw[index] !== byte)) return undefined;
  const kind = raw[8]!;
  const p = raw.subarray(9);
  const [current, earlier] = LENGTHS[kind] ?? [];
  if (current === undefined || (p.length !== current && p.length !== earlier)) return undefined;
  const newer = (offset: number) => (p.length === current ? key(p, offset) : undefined);
  switch (kind) {
    case 0:
      return { kind: "created", plan: key(p, 0), subscriber: key(p, 32), at: i64(p, 96), payer: newer(104) };
    case 1:
      return { kind: "cancelled", plan: key(p, 0), subscriber: key(p, 32), expiresAt: i64(p, 64) };
    case 5:
      return { kind: "resumed", plan: key(p, 0), subscriber: key(p, 32), at: i64(p, 64) };
    case 2:
      return {
        kind: "pull",
        delegation: key(p, 0),
        delegator: key(p, 64),
        mint: key(p, 96),
        amount: u64(p, 128),
        receiver: key(p, 160),
        receiverTokenAccount: newer(192),
        puller: newer(224),
      };
    default:
      // Fixed (3) and recurring (4) pulls share their head; the receiver follows the amounts.
      return {
        kind: "pull",
        delegation: key(p, 0),
        delegator: key(p, 32),
        mint: key(p, 96),
        amount: u64(p, 128),
        receiver: key(p, kind === 3 ? 144 : 160),
        receiverTokenAccount: newer(kind === 3 ? 176 : 192),
        puller: key(p, 64),
      };
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Inner instruction data as RPC JSON encodes it; anything that isn't base58 is not read.
export function base58(text: string): Uint8Array | undefined {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 255n));
  const zeros = text.length - text.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

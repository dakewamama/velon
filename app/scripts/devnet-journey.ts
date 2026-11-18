import { getAddressEncoder, type Address } from "@solana/addresses";

export function fixtureMode(value: string | undefined): "expired" | "active-charge" {
  if (value === undefined || value === "expired") return "expired";
  if (value === "active-charge") return value;
  throw new Error("DEVNET_FIXTURE_MODE must be expired or active-charge.");
}

export function requireDisposableFunding(balance: bigint): void {
  // Two 0.05 SOL fixture wallets, plus the funder's transaction fees. Never request an airdrop here.
  if (balance < 110_000_000n)
    throw new Error("Disposable devnet funder needs at least 0.11 devnet SOL; no fixture was funded.");
}

// subscriptions 0.5.0 TransferSubscription / TransferData. Account order is the official
// generated client's order; the bytes and roles are checked against native execution fixtures.
export function subscriptionCharge(input: {
  subscription: Address;
  plan: Address;
  authority: Address;
  source: Address;
  receiver: Address;
  puller: Address;
  mint: Address;
  owner: Address;
  tokenProgram: Address;
  eventAuthority: Address;
  program: Address;
  amount: bigint;
}) {
  if (input.amount <= 0n || input.amount > 0xffff_ffff_ffff_ffffn)
    throw new Error("Charge must be a positive u64 amount.");
  const data = new Uint8Array(73);
  data[0] = 10;
  new DataView(data.buffer).setBigUint64(1, input.amount, true);
  const encoder = getAddressEncoder();
  data.set(encoder.encode(input.owner), 9);
  data.set(encoder.encode(input.mint), 41);
  const keys = [
    input.subscription,
    input.plan,
    input.authority,
    input.source,
    input.receiver,
    input.puller,
    input.mint,
    input.tokenProgram,
    input.eventAuthority,
    input.program,
  ];
  const roles = [1, 0, 0, 1, 1, 2, 0, 0, 0, 0] as const;
  return { accounts: keys.map((address, index) => ({ address, role: roles[index]! })), data };
}

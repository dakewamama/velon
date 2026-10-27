import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/addresses";
import { blockhash } from "@solana/rpc-types";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import {
  compileTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  signTransaction,
} from "@solana/transactions";
import { array, integer, object, readJson, text, type Json } from "../src/wire.ts";
import { DEVNET_GENESIS } from "../src/control.ts";

// Layouts follow the generated client of subscriptions 0.5.0.
const SUBSCRIPTIONS = address("De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const INIT_SUBSCRIPTION_AUTHORITY = 0;
const CREATE_PLAN = 7;
const SUBSCRIBE = 11;
const CANCEL_SUBSCRIPTION_NOW = 17;
const PLAN_ID = 0n;
const AMOUNT = 100n;
const PERIOD_HOURS = 1n;
const FUNDING = "0.05";

const root = resolve(import.meta.dir, "..");
const dir = `${root}/.data/devnet`;
const url = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const funder = process.env.DEVNET_FUNDER ?? `${homedir()}/.config/solana/id.json`;
const bin = (name: string) => (process.env.AGAVE_BIN ? `${process.env.AGAVE_BIN}/${name}` : name);
const encoder = getAddressEncoder();

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args.slice(0, 2).join(" ")}`);
  return result.stdout.toString().trim();
}

async function rpc(method: string, params: Json[] = []): Promise<Json> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const reply = object(readJson(await response.text()));
  if (reply.result === undefined) throw new Error(`RPC ${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function finalizedAccount(key: Address): Promise<{ owner: string; data: Buffer }> {
  const { value } = object(
    await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "finalized" }]),
  );
  const account = object(value);
  return { owner: text(account.owner), data: Buffer.from(text(array(account.data)[0]), "base64") };
}

async function keyPair(path: string): Promise<CryptoKeyPair> {
  const bytes = Uint8Array.from(array(readJson(await Bun.file(path).text())).map(Number));
  if (bytes.length !== 64) throw new Error(`Malformed keypair ${path}.`);
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    bytes.subarray(0, 32),
  ]);
  return {
    privateKey: await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]),
    publicKey: await crypto.subtle.importKey("raw", bytes.subarray(32), "Ed25519", true, ["verify"]),
  };
}

type Meta = { address: Address; role: 0 | 1 | 2 | 3 };
const readonly = (key: Address): Meta => ({ address: key, role: 0 });
const writable = (key: Address): Meta => ({ address: key, role: 1 });
const signer = (key: Address): Meta => ({ address: key, role: 2 });
const writableSigner = (key: Address): Meta => ({ address: key, role: 3 });

// Preflight runs against finalized state, and the result counts only once it is finalized.
async function send(
  payer: Address,
  signers: CryptoKeyPair[],
  accounts: Meta[],
  data: Uint8Array,
): Promise<string> {
  const { value: latest } = object(await rpc("getLatestBlockhash", [{ commitment: "finalized" }]));
  const lifetime = object(latest);
  const lastValidBlockHeight = integer(lifetime.lastValidBlockHeight);
  const message = appendTransactionMessageInstruction(
    { programAddress: SUBSCRIPTIONS, accounts, data },
    setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: blockhash(text(lifetime.blockhash)), lastValidBlockHeight },
      setTransactionMessageFeePayer(payer, createTransactionMessage({ version: "legacy" })),
    ),
  );
  const transaction = await signTransaction(signers, compileTransaction(message));
  const signature = getSignatureFromTransaction(transaction);
  const sent = text(
    await rpc("sendTransaction", [
      getBase64EncodedWireTransaction(transaction),
      { encoding: "base64", preflightCommitment: "finalized" },
    ]),
  );
  if (sent !== signature) throw new Error(`Unexpected signature ${sent}.`);
  for (;;) {
    const status = array(object(await rpc("getSignatureStatuses", [[signature]])).value)[0];
    if (status !== null) {
      const { err, confirmationStatus } = object(status);
      if (err !== null) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(err)}`);
      if (confirmationStatus === "finalized") return signature;
    } else if (integer(await rpc("getBlockHeight", [{ commitment: "finalized" }])) > lastValidBlockHeight)
      throw new Error(`Transaction ${signature} expired before landing.`);
    await Bun.sleep(1000);
  }
}

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function i64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value, true);
  return bytes;
}

const concat = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));

// Fixtures are created on devnet only, never on any other cluster.
if (text(await rpc("getGenesisHash")) !== DEVNET_GENESIS) throw new Error(`${url} is not devnet.`);
const program = object(
  object(await rpc("getAccountInfo", [SUBSCRIPTIONS, { encoding: "base64", commitment: "finalized" }])).value,
);
if (program.executable !== true || program.owner !== "BPFLoaderUpgradeab1e11111111111111111111111")
  throw new Error("The subscriptions program is not deployed on devnet.");
if (await Bun.file(`${dir}/subscriber.json`).exists())
  throw new Error(`${dir} already holds a fixture. Move it aside to create a new one.`);
await mkdir(dir, { recursive: true });

for (const name of ["subscriber", "merchant", "mint"])
  run([bin("solana-keygen"), "new", "--no-bip39-passphrase", "--silent", "--outfile", `${dir}/${name}.json`]);
const pubkey = (name: string) => address(run([bin("solana-keygen"), "pubkey", `${dir}/${name}.json`]));
const [subscriber, merchant, mint] = ["subscriber", "merchant", "mint"].map(pubkey) as [
  Address,
  Address,
  Address,
];
for (const recipient of [subscriber, merchant])
  run([
    bin("solana"),
    "transfer",
    recipient,
    FUNDING,
    "--allow-unfunded-recipient",
    "--keypair",
    funder,
    "--commitment",
    "finalized",
    "--url",
    url,
  ]);

const [ata] = await getProgramDerivedAddress({
  programAddress: ASSOCIATED_TOKEN_PROGRAM,
  seeds: [encoder.encode(subscriber), encoder.encode(TOKEN_PROGRAM), encoder.encode(mint)],
});
const token = (args: string[]) =>
  run([
    bin("spl-token"),
    ...args,
    "--program-id",
    TOKEN_PROGRAM,
    "--fee-payer",
    `${dir}/subscriber.json`,
    "--url",
    url,
  ]);
token(["create-token", `${dir}/mint.json`, "--decimals", "0", "--mint-authority", subscriber]);
token(["create-account", mint, "--owner", subscriber]);
token(["mint", mint, "1000", ata, "--mint-authority", `${dir}/subscriber.json`]);
const minted = integer(await rpc("getSlot", [{ commitment: "confirmed" }]));
while (integer(await rpc("getSlot", [{ commitment: "finalized" }])) <= minted) await Bun.sleep(1000);
if ((await finalizedAccount(ata)).owner !== TOKEN_PROGRAM) throw new Error("Token account unavailable.");

const [authority] = await getProgramDerivedAddress({
  programAddress: SUBSCRIPTIONS,
  seeds: ["SubscriptionAuthority", encoder.encode(subscriber), encoder.encode(mint)],
});
const [plan, planBump] = await getProgramDerivedAddress({
  programAddress: SUBSCRIPTIONS,
  seeds: ["plan", encoder.encode(merchant), u64(PLAN_ID)],
});
const [subscription] = await getProgramDerivedAddress({
  programAddress: SUBSCRIPTIONS,
  seeds: ["subscription", encoder.encode(plan), encoder.encode(subscriber)],
});
const [eventAuthority] = await getProgramDerivedAddress({
  programAddress: SUBSCRIPTIONS,
  seeds: ["event_authority"],
});
const subscriberKeys = await keyPair(`${dir}/subscriber.json`);
const merchantKeys = await keyPair(`${dir}/merchant.json`);
const signatures: [string, string][] = [];

signatures.push([
  "InitSubscriptionAuthority",
  await send(
    subscriber,
    [subscriberKeys],
    [
      writableSigner(subscriber),
      writable(authority),
      readonly(mint),
      writable(ata),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    Uint8Array.of(INIT_SUBSCRIPTION_AUTHORITY),
  ),
]);

// PlanData: plan_id, mint, terms {amount, period_hours, created_at}, end_ts, destinations, pullers, metadata_uri.
// created_at is set by the program; end_ts 0, empty destinations and pullers leave the plan unrestricted.
const planData = concat(
  Uint8Array.of(CREATE_PLAN),
  u64(PLAN_ID),
  encoder.encode(mint),
  u64(AMOUNT),
  u64(PERIOD_HOURS),
  i64(0n),
  i64(0n),
  new Uint8Array(4 * 32 + 4 * 32 + 128),
);
if (planData.length !== 457) throw new Error("Malformed CreatePlan data.");
signatures.push([
  "CreatePlan",
  await send(
    merchant,
    [merchantKeys],
    [
      writableSigner(merchant),
      writable(plan),
      readonly(mint),
      readonly(SYSTEM_PROGRAM),
      readonly(TOKEN_PROGRAM),
    ],
    planData,
  ),
]);

const authorityAccount = await finalizedAccount(authority);
const planAccount = await finalizedAccount(plan);
if (
  authorityAccount.owner !== SUBSCRIPTIONS ||
  authorityAccount.data.length !== 106 ||
  authorityAccount.data[0] !== 0
)
  throw new Error("Unexpected SubscriptionAuthority account.");
if (planAccount.owner !== SUBSCRIPTIONS || planAccount.data.length !== 491 || planAccount.data[0] !== 1)
  throw new Error("Unexpected Plan account.");
const initId = authorityAccount.data.readBigInt64LE(98);
const createdAt = planAccount.data.readBigInt64LE(91);

// SubscribeData: plan_id, plan_bump, expected mint, amount, period_hours, created_at, authority init_id.
const subscribeData = concat(
  Uint8Array.of(SUBSCRIBE),
  u64(PLAN_ID),
  Uint8Array.of(planBump),
  encoder.encode(mint),
  u64(AMOUNT),
  u64(PERIOD_HOURS),
  i64(createdAt),
  i64(initId),
);
if (subscribeData.length !== 74) throw new Error("Malformed Subscribe data.");
signatures.push([
  "Subscribe",
  await send(
    subscriber,
    [subscriberKeys],
    [
      writableSigner(subscriber),
      readonly(merchant),
      readonly(plan),
      writable(subscription),
      readonly(authority),
      readonly(SYSTEM_PROGRAM),
      readonly(eventAuthority),
      readonly(SUBSCRIPTIONS),
    ],
    subscribeData,
  ),
]);

const subscribed = (await finalizedAccount(subscription)).data;
if (subscribed.length !== 155 || subscribed[0] !== 4)
  throw new Error("Unexpected SubscriptionDelegation account.");
signatures.push([
  "CancelSubscriptionNow",
  await send(
    subscriber,
    [subscriberKeys, merchantKeys],
    [
      signer(subscriber),
      signer(merchant),
      readonly(plan),
      writable(subscription),
      readonly(eventAuthority),
      readonly(SUBSCRIPTIONS),
    ],
    concat(Uint8Array.of(CANCEL_SUBSCRIPTION_NOW), i64(subscribed.readBigInt64LE(139))),
  ),
]);

// A Revoke is valid only once the cancelled delegation has expired.
const cancelled = await finalizedAccount(subscription);
const delegation = cancelled.data;
const expiresAt = delegation.readBigInt64LE(147);
const now = BigInt(Math.floor(Date.now() / 1000));
if (
  cancelled.owner !== SUBSCRIPTIONS ||
  delegation.length !== 155 ||
  delegation[0] !== 4 ||
  !delegation.subarray(3, 35).equals(Buffer.from(encoder.encode(subscriber))) ||
  !delegation.subarray(67, 99).equals(Buffer.from(encoder.encode(subscriber))) ||
  expiresAt === 0n ||
  expiresAt > now
)
  throw new Error("The subscription is not cancelled and expired at finalized commitment.");

console.log(`Devnet RPC                 ${url}
Subscriber                 ${subscriber}
Subscriber keypair         ${dir}/subscriber.json
Merchant                   ${merchant}
Merchant keypair           ${dir}/merchant.json
Mint                       ${mint}
Token account              ${ata}
SubscriptionAuthority      ${authority}
Plan                       ${plan}
Subscription               ${subscription}
Expires at                 ${expiresAt}
${signatures.map(([name, signature]) => `${name.padEnd(27)}${signature}`).join("\n")}

LIVE_SOURCE=${subscription}`);

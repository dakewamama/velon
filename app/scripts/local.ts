import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddressEncoder, type Address } from "@solana/addresses";
import { array, integer, object, readJson, text, writeJson, type Json } from "../src/wire.ts";

// Agave 3.1.10 is the loader revision Cataloger interprets executables with.
const AGAVE_REVISION = "7bc9c805218ca06769956e2cb61601329f5a0f6c";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PROGRAM_DATA = "3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2";
const DEPLOYMENT_SLOT = 419472000;
const PROGRAM_HASH = "8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697";
const RESPONSE_HASH = "68ffbb2b01685f3bdadf174780681fb4dac9355b58282a09d145ff8f5acd1b0e";
// https://verify.osec.io/status/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const TOKEN_SOURCE = "a94dd19750dc3b2409f73e15bb74754935b2a489";
const ALLOWANCE = "25";

const root = resolve(import.meta.dir, "..");
const cataloger = resolve(process.env.CATALOGER_DIR ?? `${root}/../cataloger`);
const tools = process.env.AGAVE_BIN;
if (!tools) throw new Error("Set AGAVE_BIN to an Agave 3.1.10 release bin directory.");
const dir = `${root}/.data/local`;
const port = Number(process.env.LOCAL_RPC_PORT ?? 8899);
const url = `http://127.0.0.1:${port}`;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function run(args: string[], cwd = root): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "inherit" });
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
  if (reply.result === undefined) throw new Error(`RPC ${method} failed.`);
  return reply.result;
}

const release = run([`${tools}/solana-test-validator`, "--version"]);
if (!release.includes(`3.1.10 (src:${AGAVE_REVISION.slice(0, 8)};`))
  throw new Error(`Runtime evidence requires Agave 3.1.10 at ${AGAVE_REVISION}; found ${release}.`);

// The token program is the retained finalized mainnet capture, byte for byte.
const fixtures = `${cataloger}/services/catalyst-indexer/tests/fixtures`;
const raw = await Bun.file(`${fixtures}/mainnet-spl-response.json`).text();
if (sha256(raw) !== RESPONSE_HASH) throw new Error("Unexpected mainnet capture.");
const keys = array(object(readJson(await Bun.file(`${fixtures}/mainnet-spl-capture.json`).text())).keys);
const values = array(object(object(readJson(raw)).result).value);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
for (const pubkey of [TOKEN_PROGRAM, PROGRAM_DATA]) {
  const account = object(values[keys.indexOf(pubkey)]);
  const { space: _, ...native } = account;
  await Bun.write(`${dir}/${pubkey}.json`, writeJson({ pubkey, account: native }));
}
const programData = Buffer.from(text(array(object(values[keys.indexOf(PROGRAM_DATA)]).data)[0]), "base64");
const elf = programData.subarray(45);
if (sha256(elf) !== PROGRAM_HASH) throw new Error("Unexpected token program payload.");
await Bun.write(`${dir}/token.so`, elf);

const validator = Bun.spawn(
  [
    `${tools}/solana-test-validator`,
    "--reset",
    "--quiet",
    "--ledger",
    `${dir}/ledger`,
    "--rpc-port",
    String(port),
    "--faucet-port",
    String(port + 1000),
    // Loader-v3 code is live only after its deployment slot.
    "--warp-slot",
    String(DEPLOYMENT_SLOT + 1),
    "--account",
    TOKEN_PROGRAM,
    `${dir}/${TOKEN_PROGRAM}.json`,
    "--account",
    PROGRAM_DATA,
    `${dir}/${PROGRAM_DATA}.json`,
  ],
  { stdout: "ignore", stderr: "inherit" },
);
async function stop() {
  validator.kill("SIGINT");
  await validator.exited;
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  for (let attempt = 0; ; attempt++) {
    if (validator.exitCode !== null || attempt === 150)
      throw new Error("Validator did not start. Check that no other validator holds these ports.");
    try {
      if ((await rpc("getHealth")) === "ok") break;
    } catch {
      /* The validator may still be binding its socket. */
    }
    await Bun.sleep(200);
  }
  const version = object(await rpc("getVersion"));
  if (version["solana-core"] !== "3.1.10") throw new Error("Validator is not Agave 3.1.10.");
  const cluster = text(await rpc("getGenesisHash"));
  // The program cache serves the warped deployment only once a root has passed it.
  while (integer(await rpc("getSlot", [{ commitment: "finalized" }])) <= DEPLOYMENT_SLOT + 1)
    await Bun.sleep(500);

  const cli = (bin: string, args: string[]) =>
    run([`${tools}/${bin}`, ...args, "--url", url, "--fee-payer", `${dir}/owner.json`]);
  for (const name of ["owner", "delegate", "mint"])
    run([
      `${tools}/solana-keygen`,
      "new",
      "--no-bip39-passphrase",
      "--silent",
      "--outfile",
      `${dir}/${name}.json`,
    ]);
  const address = (name: string) => run([`${tools}/solana-keygen`, "pubkey", `${dir}/${name}.json`]);
  const [owner, delegate, mint] = ["owner", "delegate", "mint"].map(address) as [string, string, string];
  run([`${tools}/solana`, "airdrop", "10", owner, "--url", url]);
  const token = (args: string[]) => cli("spl-token", [...args, "--program-id", TOKEN_PROGRAM]);
  token(["create-token", `${dir}/mint.json`, "--decimals", "0", "--mint-authority", owner]);
  token(["create-account", mint, "--owner", owner]);
  const source = token(["address", "--token", mint, "--owner", owner, "--verbose"])
    .split("\n")
    .find((line) => line.startsWith("Associated token address:"))
    ?.split(":")[1]
    ?.trim();
  if (!source) throw new Error("Token account address unavailable.");
  token(["mint", mint, "100", source, "--mint-authority", `${dir}/owner.json`]);
  token(["approve", source, ALLOWANCE, delegate, "--owner", `${dir}/owner.json`]);

  // Finalized evidence must postdate the approval before anything can be observed.
  const approved = integer(await rpc("getSlot", [{ commitment: "confirmed" }]));
  while (integer(await rpc("getSlot", [{ commitment: "finalized" }])) <= approved) await Bun.sleep(500);
  const observed = Number(integer(await rpc("getSlot", [{ commitment: "finalized" }])));

  const identity = object(
    readJson(
      run(
        [
          "cargo",
          "run",
          "--quiet",
          "--release",
          "--locked",
          "-p",
          "catalyst-indexer",
          "--bin",
          "authorization-api",
          "--",
          "inspect-executable",
          `${dir}/token.so`,
        ],
        cataloger,
      ),
    ),
  );
  const bytes = (key: string) => Array.from(getAddressEncoder().encode(key as Address));
  const revision = run(["git", "rev-parse", "HEAD"], cataloger);
  const sdk = /catalyst-sdk"?, rev = "([a-f0-9]{40})"/.exec(
    await Bun.file(`${cataloger}/services/catalyst-indexer/Cargo.toml`).text(),
  )?.[1];
  if (!sdk) throw new Error("Cataloger SDK revision unavailable.");
  const catalog = [
    {
      cluster,
      program_id: bytes(TOKEN_PROGRAM),
      deployment: `solana:loader-v3:${PROGRAM_DATA}:${DEPLOYMENT_SLOT}`,
      version: `sha256:${PROGRAM_HASH}`,
      supported_from_slot: DEPLOYMENT_SLOT + 1,
      // This ledger is disposable; the interval only needs to outlive one session.
      supported_until_slot_exclusive: observed + 10_000_000,
      schema: { uri: "https://docs.rs/spl-token-interface/3.0.0", revision: "3.0.0" },
      adapter: {
        protocol: "spl-token",
        version: "0.1",
        source: `https://github.com/dakewamama/catalyst-sdk/blob/${sdk}/src/spl.rs`,
      },
      provenance: {
        source: `https://github.com/dakewamama/cataloger/blob/${revision}/services/catalyst-indexer/tests/fixtures/mainnet-spl-response.json`,
        revision: `sha256:${RESPONSE_HASH}`,
        evidence_reference: `rpc:mainnet-spl-response.json:sha256:${RESPONSE_HASH}`,
      },
      executable: {
        programdata_address: bytes(PROGRAM_DATA),
        observed_slot: observed,
        source_revision: `solana-program/token@${TOKEN_SOURCE}`,
        build_toolchain: `solana-verify; https://verify.osec.io/status/${TOKEN_PROGRAM}`,
        identity,
        runtime: {
          revision: AGAVE_REVISION,
          environment_hash: text(identity.environment_hash),
          evidence_reference: `local-validator:${release};genesis:${cluster}`,
        },
      },
    },
  ];
  await Bun.write(`${dir}/catalog.json`, writeJson(catalog, 2));

  console.log(`Local validator   ${url} (${release})
Genesis           ${cluster}
Owner             ${owner}
Owner keypair     ${dir}/owner.json
Token account     ${source}
Delegate          ${delegate}
Delegated amount  ${ALLOWANCE} base units

Run the demo in another terminal:

RPC_URL=${url} PUBLIC_RPC_URL=${url} LIVE_NETWORK=localnet \\
LIVE_CATALOG=${dir}/catalog.json LIVE_SOURCE=${source} \\
LIVE_TEST_BENCH=1 AGAVE_BIN=${tools} \\
CATALOGER_DIR=${cataloger} bun run demo

This validator keeps running until interrupted. \`bun run local:reset\` approves the
delegate again on this ledger; rerunning this script starts a new one.`);
  process.exitCode = await validator.exited;
} catch (error) {
  await stop();
  throw error;
}

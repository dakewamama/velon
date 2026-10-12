import { resolve } from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { getAddressEncoder, isAddress, type Address } from "@solana/addresses";
import { array, grants, object, publicKey, readJson, text, type Json } from "../src/wire.ts";
import { DEVNET_GENESIS, type Control } from "../src/control.ts";
import type { Live } from "../src/server.ts";

const CATALOGER_REVISION = "3ececf3f1a88542f07af2fc770683a43c6caaa69";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const root = resolve(import.meta.dir, "..");
const cataloger = resolve(process.env.CATALOGER_DIR ?? `${root}/../cataloger`);
const dataDir = `${root}/.data`;
await mkdir(dataDir, { recursive: true });
if (!(await Bun.file(`${cataloger}/Cargo.toml`).exists()))
  throw new Error("Cataloger checkout not found. Set CATALOGER_DIR as described in README.");

function command(args: string[], env = process.env): string {
  const result = Bun.spawnSync(args, { cwd: cataloger, env, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args[0]} ${args[1]}`);
  return result.stdout.toString();
}

if (command(["git", "rev-parse", "HEAD"]).trim() !== CATALOGER_REVISION)
  throw new Error(`Cataloger must be checked out at ${CATALOGER_REVISION}. See README.`);
command(["git", "diff", "--quiet", "HEAD"]);
// Observation and simulation must share one 400ms bank; a debug build verifies too slowly.
command(["cargo", "build", "--release", "--locked", "-p", "catalyst-indexer", "--bin", "authorization-api"]);
const binary = `${resolve(cataloger, process.env.CARGO_TARGET_DIR ?? "target")}/release/authorization-api`;
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? `sqlite://${dataDir}/observations-${CATALOGER_REVISION}.db`,
};
const fixtures = `${cataloger}/services/catalyst-indexer/tests/fixtures`;
const definitions = [
  { name: "Subscriptions", files: ["owner-pull-60.json", "revoke-cancelled-after.json"] },
  { name: "SPL delegate", files: ["spl-snapshot.json"] },
];
const scenarios = definitions.map(({ name, files }) => {
  const records = files.map((file) =>
    object(readJson(command([binary, "import", `${fixtures}/catalog.json`, `${fixtures}/${file}`], env))),
  );
  for (const record of records) command([binary, "replay", text(record.id)], env);
  const latest = object(readJson(command([binary, "latest", text(records.at(-1)!.id)], env)));
  const first = records[0]!;
  const permissions = grants(first.projection);
  const target = object(array(object(first.snapshot).targets)[0]);
  const source = publicKey(target.source);
  const direct = permissions.find(
    (grant) => object(grant.resource).id === source && object(grant.subject).kind === "identity",
  );
  if (!direct) throw new Error("Native fixture has no observed source owner.");
  const owner = text(object(direct.subject).value);
  const derived = permissions.find((grant) => object(grant.authority_kind).kind === "derived");
  const merchant = derived ? text(object(array(object(derived.principal).value)[0]).value) : null;
  const examples = [
    { label: "Source account", address: source },
    { label: "Owner", address: owner },
  ];
  if (merchant) examples.push({ label: "Merchant", address: merchant });
  const snapshots = records.map((record) => ({
    id: text(record.id),
    slot: String(object(object(record.snapshot).observation).slot),
  }));
  return { name, scope: text(latest.scope_id), live: false, snapshots, examples };
});

async function rpc(method: string, params: Json[] = []): Promise<Json> {
  const response = await fetch(process.env.RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const reply = object(readJson(await response.text()));
  if (reply.result === undefined) throw new Error(`RPC ${method} failed.`);
  return reply.result;
}

async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: cataloger, env, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${args[1]}`);
  return output;
}

let control: Control | null = null;
let live: Live | undefined;
if (process.env.RPC_URL) {
  if (!process.env.PUBLIC_RPC_URL || !process.env.LIVE_CATALOG)
    throw new Error("Live control requires RPC_URL, PUBLIC_RPC_URL and LIVE_CATALOG.");
  const network = process.env.LIVE_NETWORK ?? "devnet";
  if (network !== "devnet" && network !== "localnet") throw new Error("Unsupported live network.");
  const rpcUrl = new URL(process.env.PUBLIC_RPC_URL);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password)
    throw new Error("PUBLIC_RPC_URL must be a browser-safe HTTP endpoint.");
  const cluster = text(await rpc("getGenesisHash"));
  if (cluster === MAINNET_GENESIS || (network === "devnet") !== (cluster === DEVNET_GENESIS))
    throw new Error(`LIVE_NETWORK=${network} does not describe the cluster behind RPC_URL (${cluster}).`);
  const catalog = resolve(process.env.LIVE_CATALOG);
  const verified = array(readJson(await Bun.file(catalog).text()))
    .map(object)
    .some(
      (version) =>
        version.cluster === cluster &&
        object(version.adapter).protocol === "spl-token" &&
        version.executable != null &&
        object(version.executable).runtime != null,
    );
  if (!verified)
    throw new Error(`LIVE_CATALOG has no SPL Token deployment with runtime evidence for cluster ${cluster}.`);
  control = { rpcUrl: rpcUrl.href, network, cluster };
  const bytes = (address: string) => Array.from(getAddressEncoder().encode(address as Address));
  const observe: Live["observe"] = async (source) => {
    try {
      // Discovery only names witness accounts; Cataloger reads and decodes the finalized batch itself.
      const info = object(
        await rpc("getAccountInfo", [source, { encoding: "jsonParsed", commitment: "finalized" }]),
      );
      const witnesses: string[] = [];
      const data = info.value === null ? null : object(info.value).data;
      if (data !== null && !Array.isArray(data) && object(data).program === "spl-token") {
        const token = object(object(object(data).parsed).info);
        for (const key of [token.owner, token.delegate])
          if (typeof key === "string" && isAddress(key)) witnesses.push(key);
      }
      const scope = `${dataDir}/scope-${crypto.randomUUID()}.json`;
      await Bun.write(
        scope,
        JSON.stringify({
          cluster,
          accounts: witnesses.map(bytes),
          targets: [{ kind: "spl_delegate", source: bytes(source) }],
          min_context_slot: null,
        }),
      );
      // A node occasionally answers with mismatched bank data; the collector refuses it, so ask again.
      let record: string | undefined;
      try {
        for (let attempt = 0; record === undefined; attempt++)
          record = await run([binary, "observe", catalog, scope]).catch((error) => {
            if (attempt === 2) throw error;
            return undefined;
          });
      } finally {
        await unlink(scope);
      }
      return new Response(await run([binary, "latest", text(object(readJson(record)).id)]), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return Response.json({ error: "Live observation failed. Check the token account." }, { status: 502 });
    }
  };
  live = { observe };
  // Enumerating a program's accounts is only reasonable on a ledger we started ourselves.
  if (network === "localnet") {
    const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const delegated = { memcmp: { offset: 72, bytes: "AQAAAA==", encoding: "base64" } };
    live.discover = async () => {
      try {
        const found = array(
          await rpc("getProgramAccounts", [
            token,
            { encoding: "jsonParsed", commitment: "finalized", filters: [{ dataSize: 165 }, delegated] },
          ]),
        ).map((entry) => {
          const info = object(object(object(object(object(entry).account).data).parsed).info);
          return {
            source: text(object(entry).pubkey),
            owner: text(info.owner),
            delegate: text(info.delegate),
            mint: text(info.mint),
            amount: text(object(info.delegatedAmount).amount),
          };
        });
        return Response.json(found, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "Live discovery is unavailable." }, { status: 502 });
      }
    };
    if (process.env.LIVE_TEST_BENCH === "1") {
      if (!process.env.AGAVE_BIN) throw new Error("LIVE_TEST_BENCH requires AGAVE_BIN.");
      control.testBench = true;
      let busy = false;
      // A visitor's wallet gets SOL for fees and a token account holding test tokens.
      // The address is returned at once; the transactions land behind the reply.
      const tools = process.env.AGAVE_BIN;
      const keys = `${root}/.data/local`;
      const token = [
        "--program-id",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "--url",
        process.env.RPC_URL!,
      ];
      const cli = async (args: string[]) => {
        const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
        const output = await new Response(child.stdout).text();
        return (await child.exited) === 0 ? output : undefined;
      };
      const mint = (await cli([`${tools}/solana-keygen`, "pubkey", `${keys}/mint.json`]))?.trim();
      const spender = (await cli([`${tools}/solana-keygen`, "pubkey", `${keys}/delegate.json`]))?.trim();
      if (!mint || !spender)
        throw new Error("LIVE_TEST_BENCH requires the keys written by scripts/local.ts.");
      const funding = new Set<string>();
      // Each call makes a new token account for the wallet. One account holds one delegate,
      // so separate accounts are what let a wallet hold several permissions at once.
      live.fund = async (owner) => {
        if (funding.has(owner))
          return Response.json({ error: "A test account is already on its way." }, { status: 409 });
        const key = `${dataDir}/account-${crypto.randomUUID()}.json`;
        await cli([`${tools}/solana-keygen`, "new", "--no-bip39-passphrase", "--silent", "--outfile", key]);
        const source = (await cli([`${tools}/solana-keygen`, "pubkey", key]))?.trim();
        if (!source)
          return Response.json({ error: "The test account could not be created." }, { status: 502 });
        funding.add(owner);
        const payer = ["--fee-payer", `${keys}/owner.json`];
        void (async () => {
          await cli([`${tools}/solana`, "airdrop", "1", owner, "--url", process.env.RPC_URL!]);
          await cli([
            `${tools}/spl-token`,
            "create-account",
            mint,
            key,
            "--owner",
            owner,
            ...payer,
            ...token,
          ]);
          await cli([
            `${tools}/spl-token`,
            ...["mint", mint, "1000", source, "--mint-authority", `${keys}/owner.json`],
            ...payer,
            ...token,
          ]);
          await unlink(key).catch(() => {});
          funding.delete(owner);
        })();
        return Response.json({ source, mint, delegate: spender }, { status: 202 });
      };
      // Finality outlasts the server's idle timeout, so the approval runs behind the reply;
      // the feed reports it once the chain does.
      live.approve = async () => {
        if (busy) return Response.json({ error: "A test approval is already in flight." }, { status: 409 });
        busy = true;
        const allowance = String(1 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 500));
        const child = Bun.spawn(["bun", `${root}/scripts/reset.ts`], {
          env: { ...process.env, ALLOWANCE: allowance },
          stdout: "ignore",
          stderr: "inherit",
        });
        void child.exited.then(() => (busy = false));
        return Response.json({ allowance }, { status: 202 });
      };
    }
  }
  const example = process.env.LIVE_SOURCE;
  if (example && !isAddress(example)) throw new Error("LIVE_SOURCE must be a token account address.");
  scenarios.push({
    name: network === "devnet" ? "Devnet SPL token account" : "Local validator SPL token account",
    scope: "",
    live: true,
    snapshots: [],
    examples: example ? [{ label: "Demo token account", address: example }] : [],
  });
}

// Optional read-only feeds: the newest token delegations on a public cluster, as its RPC reports them.
// They are shown as reported, never as verified permissions; this runtime has no evidence for those clusters.
function publicFeed(endpoint: string): () => Response {
  type Seen = {
    source: string;
    owner: string;
    delegate: string;
    mint: string;
    amount: string;
    ui: string;
    slot: number;
  };
  let seen: Seen[] = [];
  let scanned = 0;
  async function mainnet(method: string, params: unknown[]): Promise<any> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const reply = (await response.json()) as { result?: unknown };
    if (reply.result === undefined) throw new Error(`mainnet ${method} failed`);
    return reply.result;
  }
  async function refresh() {
    const tip: number = await mainnet("getSlot", [{ commitment: "finalized" }]);
    const sources: [string, number][] = [];
    // Bootstrap walks back a few blocks; afterwards only the newest ones are read.
    // Quiet clusters have small blocks, so the walk is bounded by work done as well as by attempts.
    let weighed = 0;
    for (
      let slot = tip, read = 0;
      slot > scanned && read < (scanned ? 10 : 40) && weighed < (scanned ? 2000 : 8000) && sources.length < 8;
      slot--
    ) {
      let block;
      // Every attempt counts, so a failing provider cannot stretch the walk past its limit.
      read++;
      try {
        block = await mainnet("getBlock", [
          slot,
          {
            encoding: "jsonParsed",
            transactionDetails: "full",
            rewards: false,
            maxSupportedTransactionVersion: 1,
          },
        ]);
      } catch {
        continue;
      }
      weighed += block.transactions.length;
      for (const transaction of block.transactions) {
        if (transaction.meta?.err) continue;
        const inner = (transaction.meta?.innerInstructions ?? []).flatMap((group: any) => group.instructions);
        for (const instruction of [...transaction.transaction.message.instructions, ...inner])
          if (
            instruction.program === "spl-token" &&
            /^approve(Checked)?$/.test(instruction.parsed?.type ?? "")
          )
            sources.push([instruction.parsed.info.source, slot]);
      }
    }
    scanned = tip;
    const candidates = [
      ...new Map([...sources, ...seen.map((entry) => [entry.source, entry.slot] as const)]),
    ];
    if (!candidates.length) return;
    const accounts = await mainnet("getMultipleAccounts", [
      candidates.map(([source]) => source).slice(0, 100),
      { encoding: "jsonParsed", commitment: "finalized" },
    ]);
    // Only delegations still in force at the latest finalized state are listed.
    seen = candidates
      .slice(0, 100)
      .flatMap(([source, slot], index): Seen[] => {
        const info = accounts.value[index]?.data?.parsed?.info;
        if (!info?.delegate || info.delegatedAmount?.amount === "0") return [];
        return [
          {
            source,
            owner: String(info.owner),
            delegate: String(info.delegate),
            mint: String(info.mint),
            amount: String(info.delegatedAmount.amount),
            ui: String(info.delegatedAmount.uiAmountString),
            slot,
          },
        ];
      })
      .filter((entry) =>
        [entry.source, entry.owner, entry.delegate, entry.mint].every((key) => isAddress(key)),
      )
      .sort((a, b) => b.slot - a.slot)
      .filter((entry, index, all) => all.findIndex((other) => other.owner === entry.owner) === index)
      .slice(0, 5);
  }
  void (async () => {
    for (;;) {
      await refresh().catch(() => {});
      await Bun.sleep(20000);
    }
  })();
  return () => Response.json(seen, { headers: { "Cache-Control": "no-store" } });
}
if (process.env.DEVNET_RPC_URL) live = { ...live, devnet: publicFeed(process.env.DEVNET_RPC_URL) };
if (process.env.MAINNET_RPC_URL) live = { ...live, mainnet: publicFeed(process.env.MAINNET_RPC_URL) };

const runtimePort = Number(process.env.RUNTIME_PORT ?? 8890);
const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
const runtime = Bun.spawn([binary, "serve", `127.0.0.1:${runtimePort}`], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
let server: ReturnType<typeof Bun.serve> | undefined;
async function shutdown() {
  server?.stop(true);
  runtime.kill("SIGINT");
  await runtime.exited;
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (runtime.exitCode !== null) throw new Error("Observation API exited before startup.");
    try {
      ready = (await fetch(`${runtimeUrl}/scopes/${scenarios[0]!.scope}`)).ok;
      if (ready) break;
    } catch {
      /* The API may still be binding its socket. */
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Observation API did not start.");
  // Bun's generated HTML manifest resolves asset paths from the working directory.
  if (process.argv.includes("--production")) process.chdir(`${root}/dist`);
  const { createServer } = await import(
    process.argv.includes("--production") ? "../dist/server.js" : "../src/server.ts"
  );
  server = createServer(
    runtimeUrl,
    scenarios,
    Number(process.env.PORT ?? 3000),
    process.env.HOST ?? "127.0.0.1",
    control,
    live,
  );
  console.log(`Catalyst demo: ${server!.url}`);
  const exitCode = await runtime.exited;
  server?.stop(true);
  process.exitCode = exitCode;
} catch (error) {
  await shutdown();
  throw error;
}

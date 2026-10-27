import { resolve } from "node:path";
import { mkdir, rename, unlink } from "node:fs/promises";
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  type Address,
} from "@solana/addresses";
import {
  array,
  grants,
  integer,
  object,
  publicKey,
  readJson,
  text,
  writeJson,
  type Json,
} from "../src/wire.ts";
import { DEVNET_GENESIS, MAINNET_GENESIS, type Control } from "../src/control.ts";
import { SUBSCRIPTIONS_PROGRAM, TOKEN_PROGRAM, tokenCatalog, tokenCatalogAsync } from "./catalog.ts";
import type { Live } from "../src/server.ts";

const root = resolve(import.meta.dir, "..");
const cataloger = resolve(process.env.CATALOGER_DIR ?? `${root}/../runtime`);
const dataDir = `${root}/.data`;
await mkdir(dataDir, { recursive: true });
if (!(await Bun.file(`${cataloger}/Cargo.toml`).exists()))
  throw new Error("Runtime not found. Set CATALOGER_DIR as described in README.");

function command(args: string[], env = process.env): string {
  const result = Bun.spawnSync(args, { cwd: cataloger, env, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args[0]} ${args[1]}`);
  return result.stdout.toString();
}

// Evidence names the commit it was built from, so the runtime must match that commit exactly.
// A host runs a prebuilt, checksummed binary instead and states the commit it was built from.
const prebuilt = process.env.AUTHZ_BIN;
if (prebuilt && !/^[0-9a-f]{40}$/.test(process.env.CATALOGER_REVISION ?? ""))
  throw new Error("AUTHZ_BIN requires CATALOGER_REVISION, the 40-character commit it was built from.");
const CATALOGER_REVISION = prebuilt
  ? process.env.CATALOGER_REVISION!
  : command(["git", "rev-parse", "HEAD"]).trim();
if (!prebuilt && command(["git", "status", "--porcelain", "--", "."]).trim())
  throw new Error("The runtime has uncommitted changes. Commit them before running the demo.");
// Release keeps observe, execute and simulate well inside a provider's request timeouts.
if (!prebuilt)
  command([
    "cargo",
    "build",
    "--release",
    "--locked",
    "-p",
    "catalyst-indexer",
    "--bin",
    "authorization-api",
  ]);
const binary =
  prebuilt ?? `${resolve(cataloger, process.env.CARGO_TARGET_DIR ?? "target")}/release/authorization-api`;
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
  if (!process.env.PUBLIC_RPC_URL) throw new Error("Live control requires RPC_URL and PUBLIC_RPC_URL.");
  const network = process.env.LIVE_NETWORK ?? "devnet";
  if (network !== "mainnet" && network !== "devnet" && network !== "localnet")
    throw new Error("Unsupported live network.");
  const rpcUrl = new URL(process.env.PUBLIC_RPC_URL);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password)
    throw new Error("PUBLIC_RPC_URL must be a browser-safe HTTP endpoint.");
  const cluster = text(await rpc("getGenesisHash"));
  if (
    (network === "mainnet") !== (cluster === MAINNET_GENESIS) ||
    (network === "devnet") !== (cluster === DEVNET_GENESIS)
  )
    throw new Error(`LIVE_NETWORK=${network} does not describe the cluster behind RPC_URL (${cluster}).`);
  // Public clusters are captured at launch: their own finalized code and activated features.
  let catalog = process.env.LIVE_CATALOG && resolve(process.env.LIVE_CATALOG);
  if (!catalog) {
    if (network === "localnet") throw new Error("Localnet needs LIVE_CATALOG from scripts/local.ts.");
    catalog = `${dataDir}/catalog-${network}-${CATALOGER_REVISION}.json`;
    await Bun.write(
      catalog,
      writeJson(tokenCatalog(binary, cataloger, process.env.RPC_URL, CATALOGER_REVISION), 2),
    );
    // A record is valid for one epoch, and a feature activating at an epoch boundary retires it
    // early, so it is captured again every hour.
    // The file is replaced whole; a failed capture keeps the last good record and is retried.
    const path = catalog;
    setInterval(
      () =>
        void tokenCatalogAsync(binary, cataloger, process.env.RPC_URL!, CATALOGER_REVISION)
          .then(async (fresh) => {
            await Bun.write(`${path}.next`, writeJson(fresh, 2));
            await rename(`${path}.next`, path);
          })
          .catch((error) =>
            console.error(`Catalog refresh failed: ${error instanceof Error ? error.message : error}`),
          ),
      60 * 60 * 1000,
    ).unref();
  }
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
  const encoder = getAddressEncoder();
  const decoder = getAddressDecoder();
  const bytes = (address: string) => Array.from(encoder.encode(address as Address));
  const ASSOCIATED_TOKEN = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const NONE = "11111111111111111111111111111111";
  // Subscriptions accounts have no RPC parser, so jsonParsed returns their bytes in base64.
  const subscriptionData = (info: Json | undefined) => {
    if (info == null) return undefined;
    const { owner, data } = object(info);
    return owner === SUBSCRIPTIONS_PROGRAM && Array.isArray(data) && data[1] === "base64"
      ? Uint8Array.from(atob(text(data[0])), (c) => c.charCodeAt(0))
      : undefined;
  };
  // A batch of accounts is one observation: the runtime starts and checks the program once.
  const observe: Live["observe"] = async (sources) => {
    try {
      // Discovery only names witness accounts; Cataloger reads and decodes the finalized batch itself.
      const parsedAccounts = async (keys: string[]) =>
        array(
          object(
            await rpc("getMultipleAccounts", [keys, { encoding: "jsonParsed", commitment: "finalized" }]),
          ).value,
        );
      const infos = await parsedAccounts(sources);
      const witnesses: string[] = [];
      const targets: Json[] = [];
      const mints = new Set<string>();
      // A SubscriptionDelegation is discriminator 4, version 1 and bump, then delegator, plan and payer.
      const delegations = new Map<string, { delegator: Address; plan: Address; payer: Address }>();
      sources.forEach((source, index) => {
        const data = subscriptionData(infos[index]);
        if (data?.length === 155 && data[0] === 4 && data[1] === 1)
          delegations.set(source, {
            delegator: decoder.decode(data, 3),
            plan: decoder.decode(data, 35),
            payer: decoder.decode(data, 67),
          });
      });
      // Its plan names the mint, the merchant and the pullers. Anything else stays a plain target,
      // which the runtime refuses rather than guesses.
      const subscriptions = new Map<string, Json>();
      if (delegations.size) {
        const plans = [...new Set([...delegations.values()].map(({ plan }) => plan))];
        const accounts = await parsedAccounts(plans);
        for (const [delegation, { delegator, plan, payer }] of delegations) {
          const data = subscriptionData(accounts[plans.indexOf(plan)]);
          // A Plan is discriminator 1, owner, bump, status, then plan_id, mint, terms, end,
          // four destinations and four pullers.
          if (data?.length !== 491 || data[0] !== 1) continue;
          const mint = decoder.decode(data, 43);
          const pullers = [0, 1, 2, 3].map((index) => decoder.decode(data, 235 + index * 32));
          const [[authority], [source]] = await Promise.all([
            getProgramDerivedAddress({
              programAddress: SUBSCRIPTIONS_PROGRAM as Address,
              seeds: ["SubscriptionAuthority", encoder.encode(delegator), encoder.encode(mint)],
            }),
            getProgramDerivedAddress({
              programAddress: ASSOCIATED_TOKEN as Address,
              seeds: [
                encoder.encode(delegator),
                encoder.encode(TOKEN_PROGRAM as Address),
                encoder.encode(mint),
              ],
            }),
          ]);
          subscriptions.set(delegation, {
            kind: "subscription",
            delegation: bytes(delegation),
            authority: bytes(authority),
            source: bytes(source),
            mint: bytes(mint),
            plan: bytes(plan),
          });
          witnesses.push(delegator, payer, decoder.decode(data, 1), ...pullers.filter((key) => key !== NONE));
        }
      }
      sources.forEach((source, index) => {
        const info = infos[index] ?? null;
        const data = info === null ? null : object(info).data;
        const program = data !== null && !Array.isArray(data) ? object(data).program : undefined;
        let target: Json = subscriptions.get(source) ?? { kind: "spl_delegate", source: bytes(source) };
        if (program === "spl-token" || program === "spl-token-2022") {
          const token = object(object(object(data!).parsed).info);
          for (const key of [token.owner, token.delegate])
            if (typeof key === "string" && isAddress(key)) witnesses.push(key);
          if (program === "spl-token-2022" && typeof token.mint === "string" && isAddress(token.mint)) {
            target = { kind: "token2022_delegate", source: bytes(source), mint: bytes(token.mint) };
            mints.add(token.mint);
          }
        }
        targets.push(target);
      });
      // A mint's permanent delegate can spend from every account, so it is observed too.
      if (mints.size) {
        const keys = [...mints];
        for (const mint of await parsedAccounts(keys)) {
          const parsed = mint === null ? undefined : object(object(mint).data).parsed;
          for (const extension of parsed ? array(object(object(parsed).info).extensions ?? []) : []) {
            const entry = object(extension);
            const delegate =
              entry.extension === "permanentDelegate" ? object(entry.state).delegate : undefined;
            if (typeof delegate === "string" && isAddress(delegate)) witnesses.push(delegate);
          }
        }
      }
      const scope = `${dataDir}/scope-${crypto.randomUUID()}.json`;
      await Bun.write(
        scope,
        JSON.stringify({
          cluster,
          accounts: [...new Set(witnesses)].map(bytes),
          targets,
          min_context_slot: null,
        }),
      );
      // A load-balanced provider occasionally answers from mismatched banks; the collector refuses
      // that, so ask again after a short pause. Each answer is still checked exactly.
      let record: string | undefined;
      try {
        for (let attempt = 0; record === undefined; attempt++) {
          if (attempt) await Bun.sleep(300 * attempt);
          record = await run([binary, "observe", catalog, scope]).catch((error) => {
            if (attempt === 5) throw error;
            return undefined;
          });
        }
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
  // A wallet's own token accounts, as the RPC's index reports them; each is then observed natively.
  type TokenEntry = {
    program: "spl-token" | "spl-token-2022";
    source: string;
    owner: string;
    mint: string;
    amount: string;
    decimals: number;
    delegate: string | null;
    delegated: string;
    ui: string;
  };
  // One wallet paste asks for the owner's accounts more than once; a short cache answers them all.
  const recent = new Map<string, { at: number; read: Promise<{ entries: TokenEntry[]; skipped: number }> }>();
  const tokenAccounts = (owner: string) => {
    const now = Date.now();
    for (const [key, value] of recent) if (now - value.at > 15000) recent.delete(key);
    const cached = recent.get(owner);
    if (cached) return cached.read;
    const read = (async () => {
      let skipped = 0;
      const lists = await Promise.all(
        (
          [
            ["spl-token", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"],
            ["spl-token-2022", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"],
          ] as const
        ).map(async ([program, id]) => {
          const value = array(
            object(
              await rpc("getTokenAccountsByOwner", [
                owner,
                { programId: id },
                { encoding: "jsonParsed", commitment: "finalized" },
              ]),
            ).value,
          );
          return value.flatMap((entry): TokenEntry[] => {
            // An account the RPC could not parse is counted, not allowed to hide the others.
            try {
              const info = object(object(object(object(object(entry).account).data).parsed).info);
              const balance = object(info.tokenAmount);
              const delegated = info.delegatedAmount ? object(info.delegatedAmount) : undefined;
              return [
                {
                  program,
                  source: text(object(entry).pubkey),
                  owner: text(info.owner),
                  mint: text(info.mint),
                  amount: text(balance.amount),
                  decimals: Number(balance.decimals),
                  delegate: typeof info.delegate === "string" ? info.delegate : null,
                  delegated: delegated ? text(delegated.amount) : "0",
                  ui: delegated ? text(delegated.uiAmountString) : "0",
                },
              ];
            } catch {
              skipped++;
              return [];
            }
          });
        }),
      );
      return { entries: lists.flat(), skipped };
    })();
    recent.set(owner, { at: now, read });
    read.catch(() => recent.delete(owner));
    return read;
  };
  // A wallet's own token accounts, as the RPC's index reports them; each is then observed natively.
  const owned: Live["owned"] = async (owner) => {
    try {
      const { entries } = await tokenAccounts(owner);
      const found = entries
        .filter((entry) => entry.delegate !== null)
        .map(({ program, source, owner, delegate, mint, delegated, ui, decimals }) => ({
          program,
          source,
          owner,
          delegate,
          mint,
          amount: delegated,
          ui,
          decimals,
        }));
      return Response.json(found, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "The wallet's token accounts could not be read." }, { status: 502 });
    }
  };
  // The wallet as its RPC reports it: SOL and every token account with any delegate. Display only;
  // permissions shown as verified still come from observing each account through the runtime.
  const LISTED = 500;
  const holdings: Live["holdings"] = async (owner) => {
    try {
      const account = object(
        await rpc("getAccountInfo", [owner, { encoding: "jsonParsed", commitment: "finalized" }]),
      ).value;
      // What the address itself is decides how the console reads it. Mints and multisigs belong to
      // the token programs too, so the parsed type tells them apart from token accounts.
      const program = account === null ? null : text(object(account).owner);
      const data = account === null ? null : object(account).data;
      const parsed =
        data !== null && data !== undefined && !Array.isArray(data) && typeof data === "object"
          ? text(object(object(data).parsed ?? {}).type ?? "")
          : "";
      const tokenProgram =
        program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ? "token-account"
          : program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
            ? "token-2022-account"
            : undefined;
      const kind =
        program === null || program === "11111111111111111111111111111111"
          ? "wallet"
          : tokenProgram && parsed === "account"
            ? tokenProgram
            : tokenProgram && parsed === "mint"
              ? "mint"
              : "other";
      if (kind !== "wallet")
        return Response.json({ kind, program }, { headers: { "Cache-Control": "no-store" } });
      const [balance, { entries, skipped }] = await Promise.all([
        rpc("getBalance", [owner, { commitment: "finalized" }]),
        tokenAccounts(owner),
      ]);
      const tokens = entries
        .slice(0, LISTED)
        .map(({ program, source, mint, amount, decimals, delegate, delegated }) => ({
          program,
          source,
          mint,
          amount,
          decimals,
          delegate,
          delegated,
        }));
      return Response.json(
        {
          kind,
          lamports: String(integer(object(balance).value)),
          tokens,
          omitted: entries.length - tokens.length,
          skipped,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "The wallet could not be read." }, { status: 502 });
    }
  };
  // Token names and logos, as their creators published them: Metaplex metadata for SPL Token mints,
  // the metadata extension for Token-2022 mints. Display only, never evidence.
  type Named = { name: string; symbol: string; image: string | null };
  const named = new Map<string, { at: number; value: Named | null }>();
  const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
  const clean = (value: string, limit: number) =>
    value
      .replace(/\0/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, limit);
  // A Borsh string: little-endian u32 length, then UTF-8 bytes.
  const borsh = (bytes: Uint8Array, offset: number): [string, number] => {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
    if (length > 256 || offset + 4 + length > bytes.length) throw new Error("bad string");
    return [new TextDecoder().decode(bytes.subarray(offset + 4, offset + 4 + length)), offset + 4 + length];
  };
  // Logos live off chain. Only public https hosts are fetched, small and quickly, once per hour.
  const image = async (uri: string): Promise<string | null> => {
    try {
      const url = new URL(uri);
      if (
        url.protocol !== "https:" ||
        /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(url.hostname)
      )
        return null;
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
      const body = await response.text();
      if (!response.ok || body.length > 65536) return null;
      const link = (JSON.parse(body) as { image?: unknown }).image;
      return typeof link === "string" && link.startsWith("https://") && link.length < 512 ? link : null;
    } catch {
      return null;
    }
  };
  const metadata: Live["metadata"] = async (mints) => {
    const now = Date.now();
    if (named.size > 5000) named.clear();
    const wanted = mints.filter((mint) => {
      const cached = named.get(mint);
      return !cached || now - cached.at > 3_600_000;
    });
    try {
      if (wanted.length) {
        const pdas = await Promise.all(
          wanted.map(
            async (mint) =>
              (
                await getProgramDerivedAddress({
                  programAddress: METAPLEX as Address,
                  seeds: ["metadata", encoder.encode(METAPLEX as Address), encoder.encode(mint as Address)],
                })
              )[0],
          ),
        );
        const [metaplex, parsed] = await Promise.all([
          rpc("getMultipleAccounts", [pdas, { encoding: "base64", commitment: "finalized" }]),
          rpc("getMultipleAccounts", [wanted, { encoding: "jsonParsed", commitment: "finalized" }]),
        ]);
        await Promise.all(
          wanted.map(async (mint, index) => {
            let found: { name: string; symbol: string; uri: string } | undefined;
            const account = array(object(metaplex).value)[index];
            if (account) {
              try {
                const data = Uint8Array.from(atob(text(array(object(account).data)[0])), (c) =>
                  c.charCodeAt(0),
                );
                const [name, afterName] = borsh(data, 65);
                const [symbol, afterSymbol] = borsh(data, afterName);
                const [uri] = borsh(data, afterSymbol);
                found = { name, symbol, uri };
              } catch {
                /* Not Metaplex metadata; the mint may still carry its own. */
              }
            }
            const mintAccount = array(object(parsed).value)[index];
            if (!found && mintAccount) {
              const info = object(object(object(object(mintAccount).data).parsed ?? {}).info ?? {});
              for (const extension of array(info.extensions ?? [])) {
                const entry = object(extension);
                if (entry.extension !== "tokenMetadata") continue;
                const state = object(entry.state);
                found = { name: text(state.name), symbol: text(state.symbol), uri: text(state.uri) };
              }
            }
            named.set(mint, {
              at: now,
              value: found
                ? {
                    name: clean(found.name, 48),
                    symbol: clean(found.symbol, 12),
                    image: found.uri ? await image(clean(found.uri, 512)) : null,
                  }
                : null,
            });
          }),
        );
      }
      const result = Object.fromEntries(mints.map((mint) => [mint, named.get(mint)?.value ?? null]));
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "Token names could not be read." }, { status: 502 });
    }
  };
  live = { observe, owned, holdings, metadata };
  // Public clusters refuse browser-origin RPC, so a local console relays the methods it needs.
  // The hosted bench does the same in deploy/gateway.ts; keep the two lists in step.
  if (process.env.RPC_RELAY === "1") {
    const methods = new Set([
      "getGenesisHash",
      "getBlockHeight",
      "isBlockhashValid",
      "getLatestBlockhash",
      "getTokenAccountBalance",
      "getAccountInfo",
      "sendTransaction",
    ]);
    live.relay = async (body) => {
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const call = input as { jsonrpc?: unknown; method?: unknown; params?: unknown } | null;
      if (!call || Array.isArray(call) || call.jsonrpc !== "2.0" || !methods.has(String(call.method)))
        return new Response("RPC method refused", { status: 403 });
      // The console only asks who owns an account, never for its data.
      if (call.method === "getAccountInfo") {
        const slice = (Array.isArray(call.params) ? call.params[1] : undefined) as
          { dataSlice?: { length?: unknown } } | undefined;
        if (slice?.dataSlice?.length !== 0) return new Response("Account data refused", { status: 403 });
      }
      try {
        const response = await fetch(process.env.RPC_URL!, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(45000),
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      } catch {
        // The provider URL can carry a key, so the failure is reported without it.
        return new Response("RPC unavailable", { status: 502 });
      }
    };
  }
  // Enumerating a program's accounts is only reasonable on a ledger we started ourselves.
  if (network === "localnet") {
    const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const delegated = { memcmp: { offset: 72, bytes: "AQAAAA==", encoding: "base64" } };
    // Every open page polls this list; concurrent polls share one scan for a second.
    let scan: { at: number; found: Promise<Json> } | undefined;
    live.discover = async () => {
      try {
        if (!scan || Date.now() - scan.at > 1000) {
          const found = scanDelegated();
          scan = { at: Date.now(), found };
          found.catch(() => (scan = undefined));
        }
        return Response.json(await scan.found, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "Live discovery is unavailable." }, { status: 502 });
      }
    };
    const scanDelegated = async (): Promise<Json> =>
      array(
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
  if (example && !isAddress(example)) throw new Error("LIVE_SOURCE must be an account address.");
  scenarios.push({
    name: {
      mainnet: "Mainnet SPL token account",
      devnet: "Devnet SPL token account",
      localnet: "Local validator SPL token account",
    }[network],
    scope: "",
    live: true,
    snapshots: [],
    examples: example ? [{ label: "Demo token account", address: example }] : [],
  });
}

// Optional read-only feeds: the newest token delegations on a public cluster, as its RPC reports them.
// A row is only a lead. Opening it observes the account, and only that observation is evidence.
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
      slot > scanned &&
      read < (scanned ? 10 : 40) &&
      weighed < (scanned ? 2000 : 8000) &&
      sources.length < 60;
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
    const current = candidates
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
      .filter((entry, index, all) => all.findIndex((other) => other.owner === entry.owner) === index);
    if (!current.length) return void (seen = []);
    // Only a wallet can sign a revoke; accounts held by programs are left out of the feed.
    const owners = await mainnet("getMultipleAccounts", [
      current.map((entry) => entry.owner),
      { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "finalized" },
    ]);
    seen = current
      .filter((_, index) => {
        const owner = owners.value[index];
        return owner === null || (owner.owner === "11111111111111111111111111111111" && !owner.executable);
      })
      .slice(0, 5);
  }
  // Blocks are only read while someone is looking: each full block costs provider credits.
  let asked = 0;
  let running: Promise<void> | undefined;
  const once = () =>
    (running ??= refresh()
      .catch(() => {})
      .finally(() => (running = undefined)));
  void (async () => {
    for (;;) {
      if (Date.now() - asked < 120000) await once();
      await Bun.sleep(20000);
    }
  })();
  return () => {
    if (Date.now() - asked >= 120000 && !seen.length) void once();
    asked = Date.now();
    return Response.json(seen, { headers: { "Cache-Control": "no-store" } });
  };
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
  // Background loops (the approval feeds, catalog refresh) would otherwise keep the process alive.
  process.exit(0);
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
  // The runtime stopping on its own is a failure; exit so a supervisor sees it and restarts.
  console.error(`Observation API exited with code ${exitCode}.`);
  process.exit(exitCode || 1);
} catch (error) {
  await shutdown();
  throw error;
}

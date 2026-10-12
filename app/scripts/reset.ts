import { resolve } from "node:path";
import { integer, object, readJson, text, type Json } from "../src/wire.ts";

// Restores the demo delegate on the running local validator without touching its ledger.
const ALLOWANCE = process.env.ALLOWANCE ?? "25";
if (!/^[1-9]\d{0,17}$/.test(ALLOWANCE)) throw new Error("ALLOWANCE must be a positive integer.");
const tools = process.env.AGAVE_BIN;
if (!tools) throw new Error("Set AGAVE_BIN to an Agave 3.1.10 release bin directory.");
const dir = `${resolve(import.meta.dir, "..")}/.data/local`;
const url = `http://127.0.0.1:${Number(process.env.LOCAL_RPC_PORT ?? 8899)}`;

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "inherit" });
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

const address = (name: string) => run([`${tools}/solana-keygen`, "pubkey", `${dir}/${name}.json`]);
const [owner, delegate, mint] = ["owner", "delegate", "mint"].map(address) as [string, string, string];
const held = object(
  await rpc("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "finalized" },
  ]),
);
const source = text(object((held.value as Json[])[0]).pubkey);
const token = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
run([
  `${tools}/spl-token`,
  "approve",
  source,
  ALLOWANCE,
  delegate,
  ...["--owner", `${dir}/owner.json`, "--fee-payer", `${dir}/owner.json`],
  ...["--program-id", token, "--url", url],
]);

// The demo reads finalized state only.
const approved = integer(await rpc("getSlot", [{ commitment: "confirmed" }]));
while (integer(await rpc("getSlot", [{ commitment: "finalized" }])) <= approved) await Bun.sleep(500);
const info = object(
  await rpc("getAccountInfo", [source, { encoding: "jsonParsed", commitment: "finalized" }]),
);
const state = object(object(object(object(info.value).data).parsed).info);
if (state.delegate !== delegate) throw new Error("Finalized token account does not show the delegate.");
console.log(`Owner             ${owner}
Token account     ${source}
Delegate          ${delegate}
Delegated amount  ${text(object(state.delegatedAmount).amount)} base units
Finalized slot    ${integer(object(info.context).slot)}`);

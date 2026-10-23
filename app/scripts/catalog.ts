import { createHash } from "node:crypto";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import { array, integer, object, readJson, text, type Json, type ObjectValue } from "../src/wire.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// The only SPL Token build with a verified source; https://verify.osec.io/status/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
export const PROGRAM_HASH = "8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697";
const TOKEN_SOURCE = "a94dd19750dc3b2409f73e15bb74754935b2a489";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Mainnet's Token-2022 at its 427147035 deployment; OtterSec verifies these bytes from source.
// https://verify.osec.io/status/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
const TOKEN_2022_HASH = "0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469";
const TOKEN_2022_SOURCE = "9bc02757f600ffe754746708a8a072bcd49d1260";
// One mainnet epoch. Features can change at the next boundary, so each launch captures again.
const VALIDITY = 432_000;

const bytes = (key: string) => Array.from(getAddressEncoder().encode(key as Address));

type Program = {
  id: string;
  name: string;
  hash: string;
  source: string;
  protocol: string;
  schema: { uri: string; revision: string };
  adapter: string;
  // SPL Token is required; Token-2022 is recorded only where the cluster runs the verified build.
  required: boolean;
};
const PROGRAMS: Program[] = [
  {
    id: TOKEN_PROGRAM,
    name: "SPL Token",
    hash: PROGRAM_HASH,
    source: `solana-program/token@${TOKEN_SOURCE}`,
    protocol: "spl-token",
    schema: { uri: "https://docs.rs/spl-token-interface/3.0.0", revision: "3.0.0" },
    adapter: "spl.rs",
    required: true,
  },
  {
    id: TOKEN_2022_PROGRAM,
    name: "Token-2022",
    hash: TOKEN_2022_HASH,
    source: `solana-program/token-2022@${TOKEN_2022_SOURCE}`,
    protocol: "token-2022",
    schema: { uri: "https://docs.rs/spl-token-2022-interface/3.1.2", revision: "3.1.2" },
    adapter: "token2022.rs",
    required: false,
  },
];

/// Catalog records from the cluster's own finalized code and activated features.
export function tokenCatalog(binary: string, cwd: string, rpcUrl: string, revision: string): Json[] {
  return PROGRAMS.flatMap((program) => {
    const result = Bun.spawnSync([binary, "capture", program.id], {
      cwd,
      env: { ...process.env, RPC_URL: rpcUrl },
      stdout: "pipe",
      stderr: "inherit",
    });
    return accept(program, result.exitCode === 0 ? result.stdout.toString() : undefined, rpcUrl, revision);
  });
}

/// The same capture without blocking the server, for refreshing a running catalog.
export async function tokenCatalogAsync(
  binary: string,
  cwd: string,
  rpcUrl: string,
  revision: string,
): Promise<Json[]> {
  const records: Json[] = [];
  for (const program of PROGRAMS) {
    const child = Bun.spawn([binary, "capture", program.id], {
      cwd,
      env: { ...process.env, RPC_URL: rpcUrl },
      stdout: "pipe",
      stderr: "inherit",
    });
    const raw = await new Response(child.stdout).text();
    records.push(...accept(program, (await child.exited) === 0 ? raw : undefined, rpcUrl, revision));
  }
  return records;
}

function accept(program: Program, raw: string | undefined, rpcUrl: string, revision: string): Json[] {
  const capture = raw === undefined ? undefined : object(readJson(raw));
  const problem =
    capture === undefined
      ? `Capturing ${program.name} failed.`
      : text(capture.version) !== `sha256:${program.hash}`
        ? `This cluster runs ${program.name} ${text(capture.version)}, not the verified build.`
        : undefined;
  if (problem) {
    if (program.required) throw new Error(problem);
    console.warn(`${problem} Its approvals are listed but not verified.`);
    return [];
  }
  return [record(program, raw!, capture!, rpcUrl, revision)];
}

function record(program: Program, raw: string, capture: ObjectValue, rpcUrl: string, revision: string): Json {
  const deployed = Number(integer(capture.deployment_slot));
  const observed = Number(integer(capture.observed_slot));
  const programdata = array(capture.programdata_address).map((byte) => Number(integer(byte)));
  const cluster = text(capture.cluster);
  // Only the origin is kept: provider URLs often carry an API key in the path or query.
  const origin = new URL(rpcUrl).origin;
  return {
    cluster,
    program_id: bytes(program.id),
    deployment: `solana:loader-v3:${getAddressDecoder().decode(Uint8Array.from(programdata))}:${deployed}`,
    version: text(capture.version),
    supported_from_slot: deployed + 1,
    supported_until_slot_exclusive: observed + VALIDITY,
    schema: program.schema,
    adapter: {
      protocol: program.protocol,
      version: "0.1",
      source: `https://github.com/dakewamama/velon/blob/${revision}/sdk/src/${program.adapter}`,
    },
    provenance: {
      source: `rpc:${origin}`,
      revision: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      evidence_reference: `rpc:finalized:${cluster}:${observed}`,
    },
    executable: {
      programdata_address: programdata,
      observed_slot: observed,
      source_revision: program.source,
      build_toolchain: `solana-verify; https://verify.osec.io/status/${program.id}`,
      identity: capture.identity!,
      runtime: capture.runtime!,
    },
  };
}

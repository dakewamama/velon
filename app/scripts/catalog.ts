import { createHash } from "node:crypto";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import { array, integer, object, readJson, text, type Json, type ObjectValue } from "../src/wire.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// The only SPL Token build with a verified source; https://verify.osec.io/status/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
export const PROGRAM_HASH = "8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697";
const TOKEN_SOURCE = "a94dd19750dc3b2409f73e15bb74754935b2a489";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Mainnet's Token-2022 at its 460497271 deployment; OtterSec verifies these bytes from source.
// https://verify.osec.io/status/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
const TOKEN_2022_HASH = "15a2e615a42e20f31714bbaaee43002ae6f1cda2e8d7118243117ab3c1342e2d";
const TOKEN_2022_SOURCE = "8867f751c0f69367ba03af4f85510b5611989491";
export const SUBSCRIPTIONS_PROGRAM = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
// Devnet's Subscriptions at its 506642674 deployment, hashed over the whole padded payload.
// The foundation's verify run built this source; trimmed of trailing zeros, its bytes hash to e705f5a3.
const SUBSCRIPTIONS_HASH = "2675ad1d2b5068d47fc5d169156cf4859a9c21c0406ce63e3828e3b7320fddbf";
const SUBSCRIPTIONS_SOURCE = "56de552a26a0f0af437c0ce5191b3309741cc596";
// Mainnet's Subscriptions at its 438440823 deployment, program-v0.5.0; OtterSec verifies these
// bytes from source. https://verify.osec.io/status/De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
const SUBSCRIPTIONS_MAINNET_HASH = "af3cefa5947173e03298361b3f461e2a314382a7206c084f77ad9a40c8b18d3a";
const SUBSCRIPTIONS_MAINNET_SOURCE = "364a41976c33347d092902443bbec2def9227e75";
// One mainnet epoch. Features can change at the next boundary, so each launch captures again.
const VALIDITY = 432_000;

const bytes = (key: string) => Array.from(getAddressEncoder().encode(key as Address));

// One verified build: its padded payload hash, the source it was built from, and how.
type Build = { hash: string; source: string; buildToolchain: string };
export type Program = {
  id: string;
  name: string;
  builds: Build[];
  protocol: string;
  schema: { uri: string; revision: string };
  adapter: string;
  adapterVersion: string;
  // SPL Token is required; the others are recorded only where the cluster runs the verified build.
  required: boolean;
};
const PROGRAMS: Program[] = [
  {
    id: TOKEN_PROGRAM,
    name: "SPL Token",
    builds: [
      {
        hash: PROGRAM_HASH,
        source: `solana-program/token@${TOKEN_SOURCE}`,
        buildToolchain: `solana-verify; https://verify.osec.io/status/${TOKEN_PROGRAM}`,
      },
    ],
    protocol: "spl-token",
    schema: { uri: "https://docs.rs/spl-token-interface/3.0.0", revision: "3.0.0" },
    adapter: "spl.rs",
    adapterVersion: "0.1",
    required: true,
  },
  {
    id: TOKEN_2022_PROGRAM,
    name: "Token-2022",
    builds: [
      {
        hash: TOKEN_2022_HASH,
        source: `solana-program/token-2022@${TOKEN_2022_SOURCE}`,
        buildToolchain: `solana-verify; https://verify.osec.io/status/${TOKEN_2022_PROGRAM}`,
      },
    ],
    protocol: "token-2022",
    schema: { uri: "https://docs.rs/spl-token-2022-interface/3.1.2", revision: "3.1.2" },
    adapter: "token2022.rs",
    adapterVersion: "0.1",
    required: false,
  },
  {
    id: SUBSCRIPTIONS_PROGRAM,
    name: "Solana Subscriptions",
    builds: [
      {
        hash: SUBSCRIPTIONS_HASH,
        source: `solana-foundation/subscriptions@${SUBSCRIPTIONS_SOURCE}`,
        buildToolchain:
          "solana-verify 0.5.2; Agave 3.1.10; platform-tools v1.52; https://github.com/solana-foundation/subscriptions/actions/runs/37008589067",
      },
      {
        hash: SUBSCRIPTIONS_MAINNET_HASH,
        source: `solana-foundation/subscriptions@${SUBSCRIPTIONS_MAINNET_SOURCE}`,
        buildToolchain: `solana-verify; https://verify.osec.io/status/${SUBSCRIPTIONS_PROGRAM}`,
      },
    ],
    protocol: "subscriptions",
    schema: { uri: "https://docs.rs/subscriptions/0.5.0", revision: "0.5.0" },
    adapter: "subscriptions.rs",
    adapterVersion: "0.3",
    required: false,
  },
];

// A provider can answer from a bank whose clock trails its slot, so a failed capture is asked
// again; a capture that succeeds with another build is a verdict and is never retried.
const CAPTURES = 6;
const pause = (attempt: number) => 300 * attempt;

/// Catalog records from the cluster's own finalized code and activated features.
export function tokenCatalog(binary: string, cwd: string, rpcUrl: string, revision: string): Json[] {
  return PROGRAMS.flatMap((program) => {
    let raw: string | undefined;
    for (let attempt = 0; raw === undefined && attempt < CAPTURES; attempt++) {
      if (attempt) Bun.sleepSync(pause(attempt));
      const result = Bun.spawnSync([binary, "capture", program.id], {
        cwd,
        env: { ...process.env, RPC_URL: rpcUrl },
        stdout: "pipe",
        stderr: "inherit",
      });
      if (result.exitCode === 0) raw = result.stdout.toString();
    }
    return accept(program, raw, rpcUrl, revision);
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
    let raw: string | undefined;
    for (let attempt = 0; raw === undefined && attempt < CAPTURES; attempt++) {
      if (attempt) await Bun.sleep(pause(attempt));
      const child = Bun.spawn([binary, "capture", program.id], {
        cwd,
        env: { ...process.env, RPC_URL: rpcUrl },
        stdout: "pipe",
        stderr: "inherit",
      });
      const out = await new Response(child.stdout).text();
      if ((await child.exited) === 0) raw = out;
    }
    records.push(...accept(program, raw, rpcUrl, revision));
  }
  return records;
}

export function accept(program: Program, raw: string | undefined, rpcUrl: string, revision: string): Json[] {
  const capture = raw === undefined ? undefined : object(readJson(raw));
  // A failed capture has no version; it is reported as failed, never read.
  const version = capture === undefined ? undefined : text(capture.version);
  const build = program.builds.find((build) => version === `sha256:${build.hash}`);
  const problem =
    capture === undefined
      ? `Capturing ${program.name} failed.`
      : !build
        ? `This cluster runs ${program.name} ${text(capture.version)}, not a verified build.`
        : undefined;
  if (problem) {
    if (program.required) throw new Error(problem);
    console.warn(`${problem} Its approvals are listed but not verified.`);
    return [];
  }
  return [record(program, build!, raw!, capture!, rpcUrl, revision)];
}

function record(
  program: Program,
  build: Build,
  raw: string,
  capture: ObjectValue,
  rpcUrl: string,
  revision: string,
): Json {
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
      version: program.adapterVersion,
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
      source_revision: build.source,
      build_toolchain: build.buildToolchain,
      identity: capture.identity!,
      runtime: capture.runtime!,
    },
  };
}

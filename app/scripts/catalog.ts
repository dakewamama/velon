import { createHash } from "node:crypto";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import { array, integer, object, readJson, text, type Json } from "../src/wire.ts";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// The only SPL Token build with a verified source; https://verify.osec.io/status/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
export const PROGRAM_HASH = "8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697";
const TOKEN_SOURCE = "a94dd19750dc3b2409f73e15bb74754935b2a489";
// One mainnet epoch. Features can change at the next boundary, so each launch captures again.
const VALIDITY = 432_000;

const bytes = (key: string) => Array.from(getAddressEncoder().encode(key as Address));

/// One SPL Token catalog record from the cluster's own finalized code and activated features.
export function tokenCatalog(binary: string, cwd: string, rpcUrl: string, revision: string): Json[] {
  const result = Bun.spawnSync([binary, "capture", TOKEN_PROGRAM], {
    cwd,
    env: { ...process.env, RPC_URL: rpcUrl },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("Capturing the token program failed.");
  const raw = result.stdout.toString();
  const capture = object(readJson(raw));
  if (text(capture.version) !== `sha256:${PROGRAM_HASH}`)
    throw new Error(`This cluster runs SPL Token ${text(capture.version)}, not the verified build.`);
  const deployed = Number(integer(capture.deployment_slot));
  const observed = Number(integer(capture.observed_slot));
  const programdata = array(capture.programdata_address).map((byte) => Number(integer(byte)));
  const cluster = text(capture.cluster);
  // Only the origin is kept: provider URLs often carry an API key in the path or query.
  const origin = new URL(rpcUrl).origin;
  return [
    {
      cluster,
      program_id: bytes(TOKEN_PROGRAM),
      deployment: `solana:loader-v3:${getAddressDecoder().decode(Uint8Array.from(programdata))}:${deployed}`,
      version: text(capture.version),
      supported_from_slot: deployed + 1,
      supported_until_slot_exclusive: observed + VALIDITY,
      schema: { uri: "https://docs.rs/spl-token-interface/3.0.0", revision: "3.0.0" },
      adapter: {
        protocol: "spl-token",
        version: "0.1",
        source: `https://github.com/dakewamama/velon/blob/${revision}/sdk/src/spl.rs`,
      },
      provenance: {
        source: `rpc:${origin}`,
        revision: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        evidence_reference: `rpc:finalized:${cluster}:${observed}`,
      },
      executable: {
        programdata_address: programdata,
        observed_slot: observed,
        source_revision: `solana-program/token@${TOKEN_SOURCE}`,
        build_toolchain: `solana-verify; https://verify.osec.io/status/${TOKEN_PROGRAM}`,
        identity: capture.identity!,
        runtime: capture.runtime!,
      },
    },
  ];
}

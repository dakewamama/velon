// Fetches the deployed Squads V4 program for native tests. AGPL-3.0; never commit the output.
// https://github.com/Squads-Protocol/v4
const PROGRAM_DATA = "Fy3YMJCvwbAXUgUM5b91ucUVA3jYzwWLHL3MwBqKsh8n";
const SHA256 = "dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c";
const path = `${import.meta.dir}/../tests/fixtures/squads-v4-mainnet.so`;
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const cached = Bun.file(path);
if (await cached.exists()) {
  if (digest(await cached.bytes()) !== SHA256) throw new Error(`${path} is not the pinned program.`);
  console.log("Squads V4 program already present and verified.");
} else {
  const response = await fetch(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [PROGRAM_DATA, { encoding: "base64", commitment: "finalized" }],
    }),
  });
  const reply = (await response.json()) as { result?: { value: { data: [string, string] } | null } };
  const account = reply.result?.value;
  if (!account) throw new Error("ProgramData account unavailable.");
  // Loader-v3 ProgramData carries 45 bytes of metadata before the executable.
  const program = Buffer.from(account.data[0], "base64").subarray(45);
  if (digest(program) !== SHA256) throw new Error("Fetched program does not match the pinned hash.");
  await Bun.write(path, program);
  console.log("Squads V4 program fetched and verified.");
}

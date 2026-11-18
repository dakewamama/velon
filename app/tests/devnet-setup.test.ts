import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("devnet setup never defaults to a personal signing key or reaches RPC without an explicit funder", async () => {
  let calls = 0;
  const rpc = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json({ jsonrpc: "2.0", id: 1, result: "wrong-cluster" });
    },
  });
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("../scripts/devnet-subscription.ts", import.meta.url))],
    {
      env: { ...process.env, DEVNET_FUNDER: "", DEVNET_RPC_URL: String(rpc.url) },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain("DEVNET_FUNDER must name a disposable devnet test keypair");
    expect(calls).toBe(0);
  } finally {
    child.kill();
    rpc.stop(true);
  }
});

test("active fixture rejects another cluster before reading a funder or creating keys", async () => {
  const methods: string[] = [];
  const rpc = Bun.serve({
    port: 0,
    async fetch(request) {
      const { method } = await request.json();
      methods.push(method);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "wrong-cluster" });
    },
  });
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("../scripts/devnet-subscription.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        DEVNET_FUNDER: "/nonexistent-disposable-funder.json",
        DEVNET_FIXTURE_MODE: "active-charge",
        DEVNET_RPC_URL: String(rpc.url),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain("is not devnet");
    expect(methods).toEqual(["getGenesisHash"]);
  } finally {
    child.kill();
    rpc.stop(true);
  }
});

import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("operator measurements include rejected calls and RPC errors without leaking credentials or wallet paths", async () => {
  let rpcStatus = 429;
  let rpcBody = '{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"private-provider-detail"}}';
  let upstreamCalls = 0;
  let probes = 0;
  const app = Bun.serve({ port: 0, fetch: () => Response.json({ cluster: "expected-genesis" }) });
  const rpc = Bun.serve({
    port: 0,
    async fetch(request) {
      if ((await request.json()).method === "getGenesisHash") {
        probes++;
        return Response.json({ jsonrpc: "2.0", id: 1, result: "expected-genesis" });
      }
      upstreamCalls++;
      return new Response(rpcBody, { status: rpcStatus });
    },
  });
  const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reserve.port!;
  reserve.stop(true);
  const secret = "server-only-operator-token";
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../deploy/gateway.ts")], {
    env: {
      ...process.env,
      PUBLIC_DEMO_ORIGIN: "https://console.example",
      GATEWAY_TOKEN: secret,
      GATEWAY_PORT: String(port),
      GATEWAY_APP: String(app.url),
      RPC_URL: String(rpc.url) + "private-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${secret}` };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(url + "/healthz")).ok) break;
      } catch {
        /* startup */
      }
      if (attempt === 50) throw new Error("Gateway did not start");
      await Bun.sleep(50);
    }
    await fetch(url + "/healthz");
    expect(probes).toBe(1);
    expect((await fetch(url + "/operations")).status).toBe(401);
    expect((await fetch(url + "/api/snapshots/private-wallet-address")).status).toBe(401);
    expect((await fetch(url + "/operations", { method: "POST", headers })).status).toBe(405);
    const call = () =>
      fetch(url + "/rpc", {
        method: "POST",
        headers: { ...headers, "X-Velon-Action": "rpc", "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight" }),
      });
    expect((await call()).status).toBe(429);
    expect(upstreamCalls).toBe(1); // No automatic provider retry, especially for signed submissions.
    rpcStatus = 200;
    expect((await call()).status).toBe(200); // HTTP success still contains an RPC error.
    rpcBody = '{"jsonrpc":"2.0","id":1,"result":18446744073709551615}';
    expect(await (await call()).text()).toBe(rpcBody);
    const result = await fetch(url + "/operations", { headers });
    expect(result.headers.get("cache-control")).toBe("no-store");
    const body = await result.json();
    expect(body.rpc).toEqual({ requests: 3, errors: 2, rateLimited: 2, transportFailures: 0 });
    expect(body.requests.operations.failed).toBe(2);
    expect(body.evidence).toBe("not_assessed");
    expect(body.backup).toBe("not_assessed");
    expect(JSON.stringify(body)).not.toContain(secret);
    child.kill("SIGTERM");
    await child.exited;
    const logs = await new Response(child.stdout).text();
    for (const value of [secret, "private-key", "private-wallet-address", "private-provider-detail"])
      expect(logs).not.toContain(value);
  } finally {
    child.kill();
    await child.exited;
    app.stop(true);
    rpc.stop(true);
  }
});

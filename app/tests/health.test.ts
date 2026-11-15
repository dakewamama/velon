import { expect, test } from "bun:test";
import { infrastructureHealth } from "../deploy/health.ts";

test("HTTP success is insufficient: health requires the application's cluster and RPC agreement", async () => {
  let control: unknown = { cluster: "expected-genesis" };
  let reply: unknown = { jsonrpc: "2.0", id: 1, result: "expected-genesis" };
  const app = Bun.serve({ port: 0, fetch: () => Response.json(control) });
  const rpc = Bun.serve({ port: 0, fetch: () => Response.json(reply) });
  try {
    expect(await infrastructureHealth(String(app.url), String(rpc.url))).toBe(true);
    for (const invalid of [
      { jsonrpc: "2.0", id: 1, error: { code: -32000 } },
      { jsonrpc: "2.0", id: 1, result: "other-genesis" },
      { jsonrpc: "2.0", id: 2, result: "expected-genesis" },
      { jsonrpc: "2.0", id: 1, result: "expected-genesis", error: {} },
      null,
    ]) {
      reply = invalid;
      expect(await infrastructureHealth(String(app.url), String(rpc.url))).toBe(false);
    }
    reply = { jsonrpc: "2.0", id: 1, result: "expected-genesis" };
    control = null;
    expect(await infrastructureHealth(String(app.url), String(rpc.url))).toBe(false);
  } finally {
    app.stop(true);
    rpc.stop(true);
  }
});

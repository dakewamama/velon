import { afterEach, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
const handler = createRequire(import.meta.url)("../scripts/hosted-proxy.cjs");
const original = globalThis.fetch;
function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  globalThis.fetch = Object.assign(implementation, { preconnect: original.preconnect });
}
afterEach(() => {
  globalThis.fetch = original;
});
process.env.DAYTONA_PREVIEW_URL = "https://3402-example.daytonaproxy01.eu";
process.env.DAYTONA_PREVIEW_TOKEN = "test-server-only";
async function call(path: string, body?: string, origin?: string) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    url: `/api/live?path=${path}`,
    method: body === undefined ? "GET" : "POST",
    headers: {
      host: "velon-eta.vercel.app",
      ...(origin ? { origin } : {}),
      "content-type": "application/json",
      "x-velon-action": "revoke",
    },
  });
  const chunks: Buffer[] = [];
  const response = Object.assign(
    new Writable({
      write(chunk, _, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    }),
    {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
    },
  );
  await handler(request, response);
  return { status: response.statusCode, body: Buffer.concat(chunks).toString() };
}
test("native u64 response survives unchanged", async () => {
  const raw = '{"amount":18446744073709551615}';
  mockFetch(async () => new Response(raw));
  expect((await call("api/scopes/abc")).body).toBe(raw);
});
test("control advertises same-origin RPC only", async () => {
  mockFetch(async () => Response.json({ network: "localnet", rpcUrl: "http://private/rpc" }));
  const result = await call("api/control");
  expect(JSON.parse(result.body).rpcUrl).toBe("https://velon-eta.vercel.app/rpc");
  expect(result.body).not.toContain("test-server-only");
});
test("submission bytes survive and redirects are refused", async () => {
  const body = '{"jsonrpc":"2.0","method":"sendTransaction","params":["exactbytes"]}';
  mockFetch(async (_url: unknown, init: RequestInit = {}) => {
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe(body);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["X-Daytona-Preview-Token"]).toBe("test-server-only");
    expect((init.headers as Record<string, string>)["x-velon-action"]).toBe("revoke");
    return new Response('{"result":"signature"}');
  });
  expect((await call("rpc", body)).status).toBe(200);
});
test("invalid requests never reach sandbox", async () => {
  mockFetch(async () => {
    throw new Error("Must not forward");
  });
  expect((await call("rpc", "{}", "https://other.example")).status).toBe(403);
  expect((await call("rpc", "x".repeat(4097))).status).toBe(413);
  expect((await call("api/../toolbox")).status).toBe(400);
});
test("pending and unavailable remain failures", async () => {
  mockFetch(async () => new Response("Pending", { status: 404 }));
  expect((await call("api/verifications/revoke/abc")).status).toBe(404);
  mockFetch(async () => {
    throw new Error("offline");
  });
  expect((await call("api/control")).status).toBe(502);
});

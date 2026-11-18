import { expect, test } from "bun:test";
import { rpcResponse } from "../scripts/rpc-response.ts";

test("RPC errors never expose provider details, mismatched IDs cannot succeed, and successful u64 bytes remain exact", () => {
  for (const [status, raw] of [
    [200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"private-key","data":"private-key"}}'],
    [429, "private-key"],
    [503, "private-key"],
    [304, "private-key"],
    [200, '{"jsonrpc":"2.0","id":2,"result":"private-key"}'],
    [200, "private-key"],
  ] as const) {
    const reply = rpcResponse(raw, status, 1);
    expect(reply.failed).toBe(true);
    expect(reply.raw).not.toContain("private-key");
    expect(JSON.parse(reply.raw).id).toBe(1);
    expect(() => new Response(reply.raw, { status: reply.status })).not.toThrow();
  }
  const raw = '{"jsonrpc":"2.0","id":1,"result":18446744073709551615}';
  expect(rpcResponse(raw, 200, 1)).toEqual({ raw, status: 200, failed: false, rateLimited: false });
});

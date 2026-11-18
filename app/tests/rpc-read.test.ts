import { expect, test } from "bun:test";
import { rpcReader } from "../scripts/rpc-read.ts";

test("concurrent identical reads share work, other reads are bounded, and completed reads are refreshed", async () => {
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      await Bun.sleep(20);
      active--;
      return new Response('{"jsonrpc":"2.0","id":1,"result":18446744073709551615}');
    },
  });
  const read = rpcReader(String(server.url));
  try {
    const same = Array.from({ length: 6 }, () => read("getBalance", ["same"]));
    const other = Array.from({ length: 4 }, (_, i) => read("getBalance", [i]));
    expect(await Promise.all([...same, ...other])).toEqual(Array(10).fill(18446744073709551615n));
    expect(calls).toBe(5);
    expect(maximum).toBe(2);
    await read("getBalance", ["same"]);
    expect(calls).toBe(6);
    await expect(read("sendTransaction", ["signed bytes"])).rejects.toThrow("Only supported read methods");
    expect(calls).toBe(6);
  } finally {
    server.stop(true);
  }
});

test("read retries are bounded, honor long Retry-After, and never expose provider details", async () => {
  let calls = 0;
  let wait = "0";
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return new Response("private-provider-error", { status: 429, headers: { "Retry-After": wait } });
    },
  });
  const read = rpcReader(String(server.url) + "private-key");
  try {
    await expect(read("getBalance")).rejects.toThrow("RPC read unavailable");
    expect(calls).toBe(3);
    wait = "120";
    await expect(read("getBalance")).rejects.toThrow("RPC read unavailable");
    expect(calls).toBe(4);
  } finally {
    server.stop(true);
  }
});

test("queued and active reads have deadlines and recover their concurrency permits", async () => {
  let slow = true;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      if (slow) await Bun.sleep(200);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "ok" });
    },
  });
  const read = rpcReader(String(server.url), 50);
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => read("getBalance", [i])));
    expect(results.every(({ status }) => status === "rejected")).toBe(true);
    slow = false;
    expect(await read("getBalance", ["fresh"])).toBe("ok");
  } finally {
    server.stop(true);
  }
});

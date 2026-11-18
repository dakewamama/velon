import { integer, object, readJson, writeJson, type Json } from "../src/wire.ts";

// Discovery/display reads only. Native observation and signed submission retain their own checks.
const METHODS = new Set([
  "getGenesisHash",
  "getAccountInfo",
  "getBalance",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
]);

export function rpcReader(url: string, timeoutMs = 15000) {
  const pending = new Map<string, Promise<Json>>();
  const queue: (() => void)[] = [];
  let active = 0;

  async function work(method: string, params: Json[]): Promise<Json> {
    const signal = AbortSignal.timeout(timeoutMs);
    if (active >= 2) {
      if (queue.length >= 16) throw new Error("RPC read queue is full.");
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          active++;
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = queue.indexOf(ready);
          if (index >= 0) queue.splice(index, 1);
          reject(new Error("RPC read deadline exceeded."));
        };
        queue.push(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: writeJson({ jsonrpc: "2.0", id: 1, method, params }),
          signal,
          redirect: "error",
        });
        let reply: ReturnType<typeof object> | undefined;
        if (response.ok) reply = object(readJson(await response.text()));
        else await response.body?.cancel();
        const code = reply?.error !== undefined ? object(reply.error).code : undefined;
        const rpcLimited = code === 429 || code === 429n;
        if ((response.status === 429 || response.status === 503 || rpcLimited) && attempt < 2) {
          const header = response.headers.get("Retry-After");
          const seconds =
            header === null
              ? 0
              : /^\d+$/.test(header)
                ? Number(header)
                : (Date.parse(header) - Date.now()) / 1000;
          // Do not retry earlier than a provider's requested wait.
          if (!Number.isFinite(seconds) || seconds > 5)
            throw new Error("RPC provider requested a longer wait.");
          const delay = Math.max(0, seconds * 1000, 500 * 2 ** attempt);
          console.log(
            JSON.stringify({ event: "rpc_read_backoff", attempt: attempt + 1, milliseconds: delay }),
          );
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new Error("RPC read deadline exceeded."));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, delay);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          continue;
        }
        if (
          !response.ok ||
          reply?.jsonrpc !== "2.0" ||
          integer(reply.id) !== 1n ||
          reply.error !== undefined ||
          reply.result === undefined
        )
          throw new Error("RPC read failed.");
        return reply.result;
      }
    } catch {
      // Provider exceptions can contain an API key; expose neither URL nor upstream error body.
      throw new Error("RPC read unavailable.");
    } finally {
      active--;
      queue.shift()?.();
    }
  }

  return (method: string, params: Json[] = []): Promise<Json> => {
    if (!METHODS.has(method))
      return Promise.reject(new Error("Only supported read methods may use read retries."));
    const key = writeJson([method, params]);
    const existing = pending.get(key);
    if (existing) return existing;
    const result = work(method, params).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}

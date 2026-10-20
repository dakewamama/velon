// Public edge of the hosted test bench. Only the Vercel proxy holds the preview token that
// reaches this port, so X-Velon-Client is the visitor address that proxy observed.
const origin = process.env.PUBLIC_DEMO_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") throw new Error("PUBLIC_DEMO_ORIGIN must be HTTPS.");
const port = Number(process.env.GATEWAY_PORT ?? 3402);
const app = process.env.GATEWAY_APP ?? "http://127.0.0.1:3400";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:19099";

// What the console needs from the validator, nothing that funds or enumerates.
const methods = new Set([
  "getGenesisHash",
  "getBlockHeight",
  "isBlockhashValid",
  "getLatestBlockhash",
  "getTokenAccountBalance",
  "getAccountInfo",
  "getTransaction",
  "sendTransaction",
]);
// Requests per minute: each visitor, then everyone together.
const limits = {
  grant: { each: 3, all: 20 },
  revoke: { each: 12, all: 120 },
  rpc: { each: 240, all: 2400 },
} as const;
type Kind = keyof typeof limits;
const seen = new Map<string, number[]>();

function allow(kind: Kind, client: string): boolean {
  const now = Date.now();
  const recent = (key: string) => (seen.get(key) ?? []).filter((at) => now - at < 60000);
  const mine = recent(`${kind}:${client}`);
  const all = recent(kind);
  if (mine.length >= limits[kind].each || all.length >= limits[kind].all) return false;
  seen.set(`${kind}:${client}`, [...mine, now]);
  seen.set(kind, [...all, now]);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of seen) if (times.every((at) => now - at >= 60000)) seen.delete(key);
}, 60000).unref();

function kind(method: string, path: string, rpc: boolean): Kind | undefined {
  if (rpc) return "rpc";
  if (method !== "POST") return undefined;
  if (path === "/api/test/account" || path === "/api/live/spl/approve") return "grant";
  if (/\/actions\/revoke\//.test(path)) return "revoke";
  return undefined;
}

let active = 0;
Bun.serve({
  hostname: "0.0.0.0",
  port,
  maxRequestBodySize: 4096,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const rpc = url.pathname === "/rpc" && !url.search;
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin && browserOrigin !== origin) return new Response("Origin refused", { status: 403 });
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (active >= 8) return new Response("Demo busy; retry shortly", { status: 429, headers });
    const client = request.headers.get("X-Velon-Client") || "unknown";
    const limited = kind(request.method, url.pathname, rpc);
    if (limited && !allow(limited, client))
      return new Response("Too many requests; retry in a minute", { status: 429, headers });
    active++;
    try {
      const forward = new Headers();
      for (const key of ["Content-Type", "X-Velon-Action"]) {
        const value = request.headers.get(key);
        if (value) forward.set(key, value);
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      if (rpc) {
        if (request.method !== "POST") return new Response("POST required", { status: 405, headers });
        let input;
        try {
          input = JSON.parse(body!);
        } catch {
          return new Response("Invalid JSON", { status: 400, headers });
        }
        if (!input || Array.isArray(input) || input.jsonrpc !== "2.0" || !methods.has(input.method))
          return new Response("RPC method refused", { status: 403, headers });
        forward.set("Content-Type", "application/json");
      }
      const target = rpc ? rpcUrl : new URL(url.pathname + url.search, app);
      const response = await fetch(target, {
        method: request.method,
        headers: forward,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
      for (const key of ["Content-Type", "Allow"]) {
        const value = response.headers.get(key);
        if (value) headers.set(key, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Demo unavailable", { status: 502, headers });
    } finally {
      active--;
    }
  },
});

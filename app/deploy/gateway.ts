import { timingSafeEqual } from "node:crypto";
// Public edge of the hosted console. Only the Vercel proxy holds the token that reaches this
// port (a Daytona preview token, or GATEWAY_TOKEN on a host that serves the port publicly), so
// X-Velon-Client is the visitor address that proxy observed.
const origin = process.env.PUBLIC_DEMO_ORIGIN;
if (!origin || new URL(origin).protocol !== "https:") throw new Error("PUBLIC_DEMO_ORIGIN must be HTTPS.");
const port = Number(process.env.GATEWAY_PORT ?? 3402);
const appUrl = process.env.GATEWAY_APP ?? "http://127.0.0.1:3400";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:19099";
const token = process.env.GATEWAY_TOKEN ? Buffer.from(`Bearer ${process.env.GATEWAY_TOKEN}`) : undefined;
function authorized(request: Request) {
  if (!token) return true;
  const given = Buffer.from(request.headers.get("Authorization") ?? "");
  return given.length === token.length && timingSafeEqual(given, token);
}

// What the console needs from the validator, nothing that funds or enumerates.
const methods = new Set([
  "getGenesisHash",
  "getBlockHeight",
  "isBlockhashValid",
  "getLatestBlockhash",
  "getTokenAccountBalance",
  "getAccountInfo",
  "sendTransaction",
  // Shows the visitor when a sent revoke has landed; display only, never evidence.
  "getSignatureStatuses",
]);
// Requests per minute: each visitor, then everyone together.
// The global caps keep one busy minute well inside a provider plan's request budget.
const limits = {
  grant: { each: 3, all: 20 },
  revoke: { each: 12, all: 120 },
  // Waiting for finality polls every two seconds after one revoke was sent.
  verify: { each: 90, all: 900 },
  send: { each: 6, all: 60 },
  observe: { each: 60, all: 600 },
  read: { each: 60, all: 300 },
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
  if (/\/actions\/(revoke|cancel)\/[^/]+\/verify$/.test(path)) return "verify";
  if (/\/actions\/(revoke|cancel)\//.test(path)) return "revoke";
  // Each observation runs the runtime and reads the cluster; each wallet read lists its accounts.
  if (path === "/api/live/spl/observe") return "observe";
  if (
    path === "/api/live/spl/owned" ||
    path === "/api/live/wallet" ||
    path === "/api/live/tokens" ||
    path === "/api/live/history" ||
    path === "/api/live/plan"
  )
    return "read";
  return undefined;
}

// IPv6 visitors are grouped by their /64, which one machine can otherwise rotate through freely.
function visitor(address: string): string {
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  // "::" stands for any run of zero groups, so it is expanded before the first four are kept.
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":");
}

// One line per request: enough to see abuse, errors and latency without logging bodies or keys.
function log(method: string, path: string, status: number, started: number, client: string) {
  const id = new Bun.CryptoHasher("sha256").update(client).digest("hex").slice(0, 12);
  console.log(`${new Date().toISOString()} ${method} ${path} ${status} ${Date.now() - started}ms ${id}`);
}

// Healthy when the app answers and the cluster RPC returns its genesis hash.
async function health(headers: Headers): Promise<Response> {
  try {
    const [app, chain] = await Promise.all([
      fetch(new URL("/api/control", appUrl), { signal: AbortSignal.timeout(5000) }),
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (app.ok && chain.ok) return new Response("ok", { headers });
  } catch {
    /* Reported as unhealthy below. */
  }
  return new Response("unhealthy", { status: 503, headers });
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
    const client = visitor(request.headers.get("X-Velon-Client") || "unknown");
    if (url.pathname === "/healthz") return health(headers);
    if (!authorized(request)) return new Response("Unauthorized", { status: 401, headers });
    const limited = kind(request.method, url.pathname, rpc);
    if (limited && !allow(limited, client))
      return new Response("Too many requests; retry in a minute", { status: 429, headers });
    active++;
    const started = Date.now();
    try {
      const forward = new Headers();
      for (const key of ["Content-Type", "X-Velon-Action"]) {
        const value = request.headers.get(key);
        if (value) forward.set(key, value);
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      let forwarded = body;
      if (rpc) {
        if (request.method !== "POST") return new Response("POST required", { status: 405, headers });
        let input;
        try {
          input = JSON.parse(body!);
        } catch {
          return new Response("Invalid JSON", { status: 400, headers });
        }
        // A browser cannot send this header cross-origin without a preflight that is never answered.
        // Scripts can, so the method allowlist and the rate limits are what bound the relay.
        if (request.headers.get("X-Velon-Action") !== "rpc")
          return new Response("Action header required", { status: 403, headers });
        if (!input || Array.isArray(input) || input.jsonrpc !== "2.0" || !methods.has(input.method))
          return new Response("RPC method refused", { status: 403, headers });
        // The console only asks who owns an account, never for its data.
        if (input.method === "getAccountInfo" && input.params?.[1]?.dataSlice?.length !== 0)
          return new Response("Account data refused", { status: 403, headers });
        if (input.method === "sendTransaction" && !allow("send", client))
          return new Response("Too many transactions; retry in a minute", { status: 429, headers });
        forward.set("Content-Type", "application/json");
        // The provider receives exactly the request that was checked, never the raw bytes, so a
        // duplicated key cannot pass one method or params past the checks and send another.
        forwarded = JSON.stringify({
          jsonrpc: "2.0",
          id: input.id ?? null,
          method: input.method,
          params: input.params,
        });
      }
      const target = rpc ? rpcUrl : new URL(url.pathname + url.search, appUrl);
      const response = await fetch(target, {
        method: request.method,
        headers: forward,
        body: forwarded,
        redirect: "error",
        signal: AbortSignal.timeout(45000),
      });
      for (const key of ["Content-Type", "Allow"]) {
        const value = response.headers.get(key);
        if (value) headers.set(key, value);
      }
      log(request.method, url.pathname, response.status, started, client);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      log(request.method, url.pathname, 502, started, client);
      return new Response("Demo unavailable", { status: 502, headers });
    } finally {
      active--;
    }
  },
});

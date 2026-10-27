import index from "./index.html";
import app from "./console.html";
import { isAddress } from "@solana/addresses";
import type { Control } from "./control.ts";

// Accounts one observation may cover; the console sends a wallet's accounts in batches this size.
export const observeBatch = 25;

export type Live = {
  observe?: (sources: string[]) => Promise<Response>;
  /// Recent mainnet delegations as its RPC reports them; read only and unverified.
  mainnet?: () => Response;
  devnet?: () => Response;
  /// Lists one wallet's delegated token accounts, as the RPC's owner index reports them.
  owned?: (owner: string) => Promise<Response>;
  /// The wallet's SOL balance and every token account, as the RPC reports them. Display only.
  holdings?: (owner: string) => Promise<Response>;
  /// Names, symbols and logos for up to 80 mints (one request body), as their creators published them.
  metadata?: (mints: string[]) => Promise<Response>;
  /// Lists delegated token accounts the cluster reports right now.
  discover?: () => Promise<Response>;
  /// Test bench only: approves a fresh delegate allowance on a disposable ledger.
  approve?: () => Promise<Response>;
  /// Test bench only: gives a visitor's wallet a funded token account on that ledger.
  fund?: (owner: string) => Promise<Response>;
  /// Forwards the browser's allowed JSON-RPC calls to a cluster that refuses browser origins.
  relay?: (body: string) => Promise<Response>;
};

export function createServer(
  runtime: string,
  scenarios: unknown,
  port: number,
  hostname = "127.0.0.1",
  control: Control | null = null,
  live?: Live,
) {
  return Bun.serve({
    port,
    hostname,
    development: false,
    // Observations and wallet reads can take tens of seconds on a busy provider.
    idleTimeout: 120,
    maxRequestBodySize: 4096,
    routes: { "/": index, "/app": app },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.search) return new Response("Not found", { status: 404 });
      const match =
        /^\/api\/(snapshots|scopes)\/([a-f0-9]{64})(?:\/(authorizations|effective|graph)\/([^/]+)|\/(coverage))?$/.exec(
          url.pathname,
        );
      // Simulation follows the scope: a retained snapshot leaves its finalized bank within a slot.
      const simulate = /^\/api\/scopes\/[a-f0-9]{64}\/actions\/revoke\/([^/]+)$/.exec(url.pathname);
      const verify = /^\/api\/snapshots\/[a-f0-9]{64}\/actions\/revoke\/([^/]+)\/verify$/.exec(url.pathname);
      const action = simulate ?? verify;
      const receipt = /^\/api\/verifications\/revoke\/[a-f0-9]{64}$/.test(url.pathname);
      const scenariosPath = url.pathname === "/api/scenarios";
      const controlPath = url.pathname === "/api/control";
      const observe = live?.observe;
      const observePath = observe && url.pathname === "/api/live/spl/observe";
      const fund = url.pathname === "/api/test/account" ? live?.fund : undefined;
      const owned = url.pathname === "/api/live/spl/owned" ? live?.owned : undefined;
      const holdings = url.pathname === "/api/live/wallet" ? live?.holdings : undefined;
      const metadata = url.pathname === "/api/live/tokens" ? live?.metadata : undefined;
      const discover = url.pathname === "/api/live/spl/delegated" ? live?.discover : undefined;
      const approve = url.pathname === "/api/live/spl/approve" ? live?.approve : undefined;
      const relay = url.pathname === "/rpc" ? live?.relay : undefined;
      const mainnet =
        url.pathname === "/api/mainnet/delegated"
          ? live?.mainnet
          : url.pathname === "/api/devnet/delegated"
            ? live?.devnet
            : undefined;
      if (
        (!match &&
          !action &&
          !receipt &&
          !scenariosPath &&
          !controlPath &&
          !observePath &&
          !fund &&
          !owned &&
          !holdings &&
          !metadata &&
          !discover &&
          !approve &&
          !relay &&
          !mainnet) ||
        (match?.[4] && !isAddress(match[4])) ||
        (action && !isAddress(action[1]!))
      )
        return new Response("Not found", { status: 404 });
      const method =
        action || observePath || approve || fund || owned || holdings || metadata || relay ? "POST" : "GET";
      if (request.method !== method)
        return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
      if (scenariosPath) return Response.json(scenarios);
      if (controlPath) return Response.json(control, { headers: { "Cache-Control": "no-store" } });
      // Cross-origin pages cannot send this header or JSON without a preflight, which is never answered.
      if (metadata) {
        if (request.headers.get("X-Velon-Action") !== "observe")
          return new Response("Action header required", { status: 403 });
        let mints: unknown;
        try {
          mints = (JSON.parse(await request.text()) as { mints?: unknown }).mints;
        } catch {
          /* Rejected below. */
        }
        if (
          !Array.isArray(mints) ||
          mints.length === 0 ||
          mints.length > 80 ||
          !mints.every((mint) => typeof mint === "string" && isAddress(mint))
        )
          return new Response("Up to 80 mint addresses required", { status: 400 });
        return metadata([...new Set(mints as string[])]);
      }
      if (relay) {
        if (request.headers.get("X-Velon-Action") !== "rpc")
          return new Response("Action header required", { status: 403 });
        return request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() === "application/json"
          ? relay(await request.text())
          : new Response("JSON body required", { status: 415 });
      }
      if (discover) return discover();
      if (mainnet) return mainnet();
      // Cross-origin browser requests cannot supply this header without a CORS preflight.
      const intent = action ? "revoke" : approve || fund ? "test" : "observe";
      if (request.method === "POST" && request.headers.get("X-Velon-Action") !== intent)
        return new Response("Action header required", { status: 403 });
      if (approve)
        return (await request.arrayBuffer()).byteLength
          ? new Response("Test approval takes no input", { status: 400 })
          : approve();
      if (
        (verify || observePath || fund || owned || holdings) &&
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      )
        return new Response("JSON body required", { status: 415 });
      if (observePath || fund || owned || holdings) {
        // Only a validated address leaves this handler; the launcher builds everything else.
        // An observation names one account, or a batch of a wallet's accounts observed together.
        const keys = fund || owned || holdings ? ["owner"] : ["source", "sources"];
        let address: unknown;
        let key: string | undefined;
        try {
          const input: unknown = JSON.parse(await request.text());
          const given = input && typeof input === "object" ? Object.keys(input) : [];
          if (given.length === 1 && keys.includes(given[0]!)) {
            key = given[0];
            address = (input as Record<string, unknown>)[key!];
          }
        } catch {
          /* Malformed JSON is rejected below. */
        }
        if (key === "sources") {
          const sources = Array.isArray(address) ? address : [];
          if (
            !sources.length ||
            sources.length > observeBatch ||
            new Set(sources).size !== sources.length ||
            !sources.every((source) => typeof source === "string" && isAddress(source))
          )
            return new Response(`Between 1 and ${observeBatch} distinct addresses required`, { status: 400 });
          return observe!(sources as string[]);
        }
        if (typeof address !== "string" || !isAddress(address))
          return new Response("Address required", { status: 400 });
        if (holdings) return holdings(address);
        return fund ? fund(address) : owned ? owned(address) : observe!([address]);
      }
      const body = action ? await request.arrayBuffer() : undefined;
      if (simulate && body!.byteLength)
        return new Response("Simulation requires an empty body", { status: 400 });
      try {
        const response = await fetch(new URL(url.pathname.slice(4), runtime), {
          method,
          body,
          headers: verify ? { "Content-Type": "application/json" } : undefined,
          signal: AbortSignal.timeout(action ? 30000 : 5000),
          redirect: "error",
        });
        return new Response(response.body, {
          status: response.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json(
          { error: "The observation provider is unavailable. Try again." },
          { status: 502 },
        );
      }
    },
  });
}

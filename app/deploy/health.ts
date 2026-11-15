// This probe measures reachability and cluster agreement. It does not measure
// index freshness, supported deployments or the completeness of retained evidence.
export async function infrastructureHealth(appUrl: string, rpcUrl: string): Promise<boolean> {
  try {
    const [app, chain] = await Promise.all([
      fetch(new URL("/api/control", appUrl), { signal: AbortSignal.timeout(5000), redirect: "error" }),
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }),
    ]);
    if (!app.ok || !chain.ok) return false;
    const control = await app.json();
    const reply = await chain.json();
    return (
      control !== null &&
      typeof control.cluster === "string" &&
      control.cluster.length > 0 &&
      reply !== null &&
      reply.jsonrpc === "2.0" &&
      reply.id === 1 &&
      reply.error === undefined &&
      reply.result === control.cluster
    );
  } catch {
    return false;
  }
}

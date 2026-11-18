// Bounded, process-local measurements. No wallet, IP, path, key or request-body labels.
export class Operations {
  constructor(private revision?: string) {}
  private started = new Date().toISOString();
  private requests = new Map<
    string,
    { count: number; failed: number; milliseconds: number; buckets: number[] }
  >();
  private provider = { requests: 0, errors: 0, rateLimited: 0, transportFailures: 0 };

  request(group: string, status: number, milliseconds: number) {
    const key = ["health", "operations", "rpc", "observe", "review", "revalidate", "verify", "read"].includes(
      group,
    )
      ? group
      : "other";
    const row = this.requests.get(key) ?? {
      count: 0,
      failed: 0,
      milliseconds: 0,
      buckets: [0, 0, 0, 0, 0, 0],
    };
    row.count++;
    row.failed += Number(status >= 400);
    row.milliseconds += milliseconds;
    const bucket = [500, 1000, 5000, 15000, 45000].findIndex((limit) => milliseconds <= limit);
    row.buckets[bucket === -1 ? 5 : bucket]!++;
    this.requests.set(key, row);
  }

  rpc(status: number, error = false, rateLimited = false) {
    this.provider.requests++;
    this.provider.errors += Number(status === 0 || status >= 400 || error);
    this.provider.rateLimited += Number(status === 429 || rateLimited);
    this.provider.transportFailures += Number(status === 0);
  }

  snapshot() {
    return {
      format: 1,
      revision: this.revision && /^[a-f0-9]{40}$/.test(this.revision) ? this.revision : null,
      observedAt: new Date().toISOString(),
      startedAt: this.started,
      scope: "gateway process since startup; counters reset on restart",
      latencyBucketUpperBoundsMs: [500, 1000, 5000, 15000, 45000, null],
      latencyBuckets: "non-cumulative counts",
      requests: Object.fromEntries(this.requests),
      rpc: { ...this.provider },
      rpcScope: "gateway relay only; excludes health probes and native runtime's direct RPC calls",
      evidence: "not_assessed",
      backup: "not_assessed",
    };
  }
}

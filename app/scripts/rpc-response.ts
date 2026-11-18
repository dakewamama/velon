// Successful RPC bytes stay lossless. Error bodies may contain a provider URL/key and never leave the server.
export function rpcResponse(raw: string, status: number, id: unknown) {
  let body: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown } } | undefined;
  try {
    body = JSON.parse(raw);
  } catch {
    /* Malformed replies cannot establish success. */
  }
  const valid =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.jsonrpc === "2.0" &&
    body.id === id &&
    (body.error !== undefined) !== (body.result !== undefined);
  const failed = status < 200 || status >= 300 || !valid || body?.error !== undefined;
  const rateLimited = status === 429 || body?.error?.code === 429;
  if (!failed) return { raw, status, failed, rateLimited };
  const code = Number.isSafeInteger(body?.error?.code) ? body!.error!.code : rateLimited ? 429 : -32000;
  return {
    raw: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "RPC provider unavailable" } }),
    status: [204, 205, 304].includes(status) || (status >= 200 && status < 300 && !valid) ? 502 : status,
    failed,
    rateLimited,
  };
}

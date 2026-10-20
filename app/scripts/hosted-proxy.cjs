const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
module.exports = async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const host = request.headers.host;
  const path = new URL(request.url, "http://localhost").searchParams.get("path");
  if (
    !/^[a-z0-9-]+\.vercel\.app$/.test(host || "") ||
    !path ||
    !(path === "rpc" || /^api\/[a-zA-Z0-9/_-]+$/.test(path))
  ) {
    response.statusCode = 400;
    return response.end("Invalid request");
  }
  if (!["GET", "POST", "HEAD"].includes(request.method)) {
    response.statusCode = 405;
    return response.end("Method refused");
  }
  if (request.headers.origin && request.headers.origin !== `https://${host}`) {
    response.statusCode = 403;
    return response.end("Origin refused");
  }
  try {
    const base = new URL(process.env.DAYTONA_PREVIEW_URL);
    if (base.protocol !== "https:" || base.username || base.password) throw new Error("Invalid upstream");
    const headers = {
      "X-Daytona-Preview-Token": process.env.DAYTONA_PREVIEW_TOKEN,
      "X-Daytona-Skip-Preview-Warning": "true",
    };
    for (const name of ["content-type", "x-velon-action"])
      if (request.headers[name]) headers[name] = request.headers[name];
    let body;
    if (request.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) {
          response.statusCode = 413;
          return response.end("Request too large");
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const upstream = await fetch(new URL("/" + path, base), {
      method: request.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(55000),
    });
    response.statusCode = upstream.status;
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    if (path === "api/control" && upstream.ok) {
      const control = await upstream.json();
      if (control) control.rpcUrl = `https://${host}/rpc`;
      return response.end(JSON.stringify(control));
    }
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
    else response.end();
  } catch {
    if (!response.headersSent) response.statusCode = 502;
    response.end("Demo temporarily unavailable");
  }
};
module.exports.config = { api: { bodyParser: false } };

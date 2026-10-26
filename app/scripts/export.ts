import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

// Recorded evidence remains the default. Hosted control forwards to an independently running runtime.
const root = resolve(import.meta.dir, "..");
const out = `${root}/site`;
const port = 3410;
const origin = `http://127.0.0.1:${port}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  PORT: String(port),
  RUNTIME_PORT: String(port + 1),
};
for (const key of [
  "RPC_URL",
  "PUBLIC_RPC_URL",
  "LIVE_CATALOG",
  "LIVE_SOURCE",
  "MAINNET_RPC_URL",
  "DEVNET_RPC_URL",
])
  delete env[key];

const server = Bun.spawn(["bun", `${root}/scripts/demo.ts`, "--production"], {
  cwd: root,
  env,
  stdout: "ignore",
  stderr: "inherit",
});
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null || attempt === 600) throw new Error("The demo did not start.");
    if (
      await fetch(`${origin}/api/scenarios`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    await Bun.sleep(500);
  }
  const project = await Bun.file(`${out}/.vercel/project.json`)
    .text()
    .catch(() => undefined);
  await rm(out, { recursive: true, force: true });
  if (project) await Bun.write(`${out}/.vercel/project.json`, project);
  await mkdir(`${out}/api`, { recursive: true });
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response;
  };
  const media = /["(]\.\/([\w.-]+\.(?:png|svg|webp|jpg|woff2))[")]/g;
  const images = new Set<string>();
  // CONSOLE_ROOT=1 publishes only the console, at the root of its own host.
  const pages =
    process.env.CONSOLE_ROOT === "1"
      ? ([["/app", "index.html"]] as const)
      : ([
          ["/", "index.html"],
          ["/app", "app.html"],
        ] as const);
  for (const [path, file] of pages) {
    const html = await (await get(path)).text();
    await Bun.write(`${out}/${file}`, html);
    for (const [, asset] of html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css))"/g)) {
      const body = await (await get(`/${asset}`)).arrayBuffer();
      await Bun.write(`${out}/${asset}`, body);
      for (const [, image] of new TextDecoder().decode(body).matchAll(media)) images.add(image!);
    }
    for (const [, image] of html.matchAll(media)) images.add(image!);
  }
  // Token marks and fonts are bundled as hashed files that the HTML, scripts and styles point to.
  for (const image of images)
    await Bun.write(`${out}/${image}`, await (await get(`/${image}`)).arrayBuffer());
  // Bodies are kept as the runtime's raw text so native u64 values survive untouched.
  const data: Record<string, string> = {};
  const keep = async (path: string) => (data[path] = await (await get(path)).text());
  const scenarios = JSON.parse(await keep("/api/scenarios")) as {
    scope: string;
    snapshots: { id: string }[];
    examples: { address: string }[];
  }[];
  data["/api/control"] = "null";
  for (const scenario of scenarios) {
    await keep(`/api/scopes/${scenario.scope}`);
    for (const { address } of scenario.examples)
      await keep(`/api/scopes/${scenario.scope}/effective/${address}`);
    for (const { id } of scenario.snapshots) {
      await keep(`/api/snapshots/${id}`);
      for (const { address } of scenario.examples)
        await keep(`/api/snapshots/${id}/authorizations/${address}`);
    }
  }
  await Bun.write(`${out}/data.json`, JSON.stringify(data));
  // One function answers every recorded path; the rewrite hands it the path that was asked for.
  await Bun.write(
    `${out}/api/data.js`,
    `const data = require("../data.json");
module.exports = (request, response) => {
  const path = new URL(request.url, "http://localhost").searchParams.get("path");
  const body = data["/api/" + path];
  if (body === undefined || request.method !== "GET") {
    response.statusCode = body === undefined ? 404 : 405;
    return response.end("Not found");
  }
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
};
`,
  );
  const hosting: Record<string, unknown> = {
    cleanUrls: true,
    rewrites: [{ source: "/api/(.*)", destination: "/api/data?path=$1" }],
  };
  if (process.env.HOSTED_RUNTIME === "1") {
    // Token logos come from their issuers' https hosts; everything else is this origin.
    hosting.headers = [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
    await copyFile(`${root}/scripts/hosted-proxy.cjs`, `${out}/api/live.js`);
    hosting.rewrites = [
      { source: "/rpc", destination: "/api/live?path=rpc" },
      { source: "/api/(.*)", destination: "/api/live?path=api/$1" },
    ];
  }
  await Bun.write(`${out}/vercel.json`, `${JSON.stringify(hosting, null, 2)}\n`);
  console.log(`Exported ${Object.keys(data).length} recorded responses to ${out}`);
} finally {
  server.kill("SIGINT");
  await server.exited;
}

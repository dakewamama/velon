// Static server for the site. Usage: bun web/serve.ts [port]
import { join, normalize } from "node:path";

const root = import.meta.dir;
const port = Number(process.argv[2] ?? process.env.PORT ?? 4321);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(root, normalize(path).replace(/^(\.\.[/\\])+/, "")));
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    return new Response(file);
  },
});

process.stdout.write(`Velon site on http://127.0.0.1:${port}\n`);

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function frontendManifest(directory: string, revision: string, consoleFile = "index.html") {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("An exact release commit is required.");
  const assets = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!/^[\w.-]+\.(html|js|css|png|svg|webp|jpg|woff2)$/.test(name)) continue;
    const bytes = await readFile(join(directory, name));
    assets.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (!assets.some(({ name }) => name === "index.html") || !assets.some(({ name }) => name.endsWith(".js")))
    throw new Error("The console HTML and script must be exported first.");
  if (!["index.html", "app.html"].includes(consoleFile) || !assets.some(({ name }) => name === consoleFile))
    throw new Error("The console page must be in the manifest.");
  return { format: 1, revision, apiVersion: "1", consoleFile, assets };
}

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("launcher rejects a mislabeled native binary before replay or serving controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "velon-release-identity-"));
  const calls = join(dir, "calls.jsonl");
  const binary = join(dir, "native-fixture");
  await writeFile(join(dir, "Cargo.toml"), "# isolated launcher fixture\n");
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] !== "identity") process.exit(2);
console.log(JSON.stringify({ id: "fixture", sdk_revision: "${"b".repeat(40)}" }));
`,
  );
  await chmod(binary, 0o700);
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../scripts/demo.ts", import.meta.url))], {
    env: {
      ...process.env,
      AUTHZ_BIN: binary,
      CATALOGER_DIR: dir,
      CATALOGER_REVISION: "a".repeat(40),
      DATABASE_URL: `sqlite://${join(dir, "evidence.db")}`,
      LIVE_NETWORK: "mainnet",
      RPC_URL: "http://127.0.0.1:9",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const error = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(error).toContain("Native runtime revision does not match CATALOGER_REVISION");
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands).toHaveLength(1);
    expect(commands[0][0]).toBe("identity");
  } finally {
    child.kill();
  }
});

test("mainnet launcher serves its live scenario without importing recorded fixtures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "velon-mainnet-startup-"));
  const calls = join(dir, "calls.jsonl");
  const binary = join(dir, "native-fixture");
  const revision = "a".repeat(40);
  const cluster = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const reserve = () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = server.port!;
    server.stop(true);
    return port;
  };
  const port = reserve();
  const runtimePort = reserve();
  let redirectedSubmissions = 0;
  const redirected = Bun.serve({
    port: 0,
    fetch: () => {
      redirectedSubmissions++;
      return Response.json({ jsonrpc: "2.0", id: 1, result: "unexpected" });
    },
  });
  const rpc = Bun.serve({
    port: 0,
    fetch: async (request) =>
      (await request.json()).method === "sendTransaction"
        ? new Response(null, { status: 307, headers: { Location: String(redirected.url) } })
        : Response.json({ jsonrpc: "2.0", id: 1, result: cluster }),
  });
  await writeFile(join(dir, "Cargo.toml"), "# isolated launcher orchestration fixture\n");
  await writeFile(
    join(dir, "catalog.json"),
    JSON.stringify([{ cluster, adapter: { protocol: "spl-token" }, executable: { runtime: {} } }]),
  );
  const journal = join(dir, "retained.db");
  await writeFile(journal, "retained evidence sentinel");
  await writeFile(
    binary,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const identity = { sdk_revision: "${revision}", runtime_version: "fixture" };
if (process.argv[2] === "identity") console.log(JSON.stringify(identity));
else if (process.argv[2] === "history-recent") console.log(JSON.stringify({ cluster: "${cluster}" }));
else if (process.argv[2] === "history") console.log('{"events":[{"amount":"18446744073709551615","period_end_ts":9223372036854775807}],"transactions":[],"complete":false}');
else if (process.argv[2] === "serve") {
  if (process.env.FAIL_SERVE === "1") process.exit(23);
  const server = Bun.serve({ port: Number(process.argv[3].split(":").at(-1)), hostname: "127.0.0.1", fetch: () => Response.json(identity) });
  process.once("SIGINT", () => { server.stop(true); process.exit(0); });
} else process.exit(2);
`,
  );
  await chmod(binary, 0o700);
  const launch = (fail = false) =>
    Bun.spawn([process.execPath, fileURLToPath(new URL("../scripts/demo.ts", import.meta.url))], {
      env: {
        ...process.env,
        AUTHZ_BIN: binary,
        CATALOGER_DIR: dir,
        CATALOGER_REVISION: revision,
        DATABASE_URL: `sqlite://${journal}`,
        LIVE_NETWORK: "mainnet",
        RPC_URL: String(rpc.url),
        PUBLIC_RPC_URL: String(rpc.url),
        RPC_RELAY: "1",
        LIVE_CATALOG: join(dir, "catalog.json"),
        MAINNET_RPC_URL: "",
        DEVNET_RPC_URL: "",
        PORT: String(port),
        RUNTIME_PORT: String(runtimePort),
        FAIL_SERVE: fail ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  let child = launch();
  try {
    let scenarios: Array<{ live: boolean; scope: string }> | undefined;
    let lastFailure = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/api/scenarios`);
        if (reply.ok) {
          scenarios = (await reply.json()) as typeof scenarios;
          break;
        }
        lastFailure = `${reply.status}: ${await reply.text()}`;
      } catch (error) {
        lastFailure = String(error);
        /* launcher is still binding */
      }
      await Bun.sleep(50);
    }
    if (!scenarios) {
      child.kill("SIGINT");
      await child.exited;
      throw new Error(
        `Mainnet launcher did not answer on ${port}: ${lastFailure} ${await new Response(child.stderr).text()} ${await new Response(child.stdout).text()}`,
      );
    }
    expect(scenarios).toHaveLength(1);
    expect(scenarios![0]).toMatchObject({ live: true, scope: "" });
    expect((await fetch(`http://127.0.0.1:${port}/api/identity`)).status).toBe(404);
    expect(await readFile(journal, "utf8")).toBe("retained evidence sentinel");
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(commands.map((args) => args[0])).toEqual(["identity", "serve"]);
    const history = await fetch(`http://127.0.0.1:${port}/api/live/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Velon-Action": "observe" },
      body: JSON.stringify({ delegation: "11111111111111111111111111111111" }),
    });
    expect(history.status).toBe(200);
    expect(history.headers.get("Cache-Control")).toBe("no-store");
    expect(await history.text()).toContain('"period_end_ts":9223372036854775807');
    const submission = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Velon-Action": "rpc" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: ["dummy-unit-test-bytes"],
      }),
    });
    expect(submission.status).toBe(502);
    expect(redirectedSubmissions).toBe(0);
    child.kill("SIGINT");
    expect(await child.exited).toBe(0);
    child = launch();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/scenarios`)).ok) break;
      } catch {
        /* starting */
      }
      await Bun.sleep(50);
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    child = launch(true);
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain("Console startup failed");
  } finally {
    child.kill("SIGINT");
    await child.exited;
    rpc.stop(true);
    redirected.stop(true);
  }
}, 15000);

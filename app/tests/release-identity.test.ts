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
if (process.argv[2] !== "import") process.exit(2);
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
    expect(commands[0][0]).toBe("import");
  } finally {
    child.kill();
  }
});

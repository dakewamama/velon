import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalData, requireValidatorRevision, validatorFailure } from "../scripts/local-data.ts";

test("local setup refuses to erase existing ledger and evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "velon-preservation-"));
  const dir = join(root, "local");
  await mkdir(dir);
  await mkdir(join(dir, "ledger"));
  await writeFile(join(dir, "ledger", "retained-evidence"), "preserve these bytes");
  await expect(createLocalData(dir)).rejects.toThrow("preserved");
  expect(await readFile(join(dir, "ledger", "retained-evidence"), "utf8")).toBe("preserve these bytes");
});

test("local conformance never silently uses a different native runtime", () => {
  expect(() =>
    requireValidatorRevision("solana-test-validator 4.3.2 (src:a2033000; feat:c9ad34d2, client:Agave)"),
  ).not.toThrow();
  for (const release of ["solana-test-validator 3.1.10", "solana-test-validator 4.3.2 (src:ffffffff;)"])
    expect(() => requireValidatorRevision(release)).toThrow("matching the runtime");
  expect(validatorFailure("io_uring NOT supported: Function not implemented (os error 38)")).toContain(
    "requires io_uring",
  );
});

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function requireValidatorRevision(release: string): void {
  if (!/^solana-test-validator 4\.3\.2 \(src:a2033000;/.test(release))
    throw new Error("Local conformance requires Agave 4.3.2 at a2033000, matching the runtime.");
}

export async function createLocalData(dir: string): Promise<void> {
  await mkdir(dirname(dir), { recursive: true });
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Local validator data already exists and was preserved. Reuse that ledger or run setup from a fresh checkout.",
      );
    throw error;
  }
}

export function validatorFailure(log: string): string {
  if (/io_uring NOT supported|assertion failed: io_uring_supported/.test(log))
    return "Agave 4.3.2 requires io_uring, which this environment does not provide. Use a host with io_uring support; existing test data was preserved.";
  return "Validator exited during startup. Inspect its ledger/validator.log; existing test data was preserved.";
}

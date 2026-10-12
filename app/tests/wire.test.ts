import { expect, test } from "bun:test";
import {
  authorization,
  compare,
  object,
  permissionLabel,
  publicKey,
  readJson,
  writeJson,
  type ObjectValue,
} from "../src/wire.ts";

const grant = (): ObjectValue => ({
  schema_version: "0.1",
  id: "test:grant",
  capability: "spend",
  principal: { kind: "identity", value: "owner" },
  resource: { namespace: "test", id: "resource" },
  constraints: {
    kind: "constraint",
    value: {
      kind: "amount_at_most",
      amount: 18446744073709551615n,
      asset: { namespace: "test", id: "asset" },
    },
  },
  usage: { kind: "cumulative", remaining: 18446744073709551615n },
  lifecycle: { kind: "active" },
  authority_kind: { kind: "direct" },
  native_context: { protocol: "test" },
  evidence: { observed_at: "1" },
});
const record = (slot: bigint, authorizations: ObjectValue[]) => ({
  snapshot: {
    observation: { slot, cluster: "test", origin: "fixture" },
    targets: [{ kind: "test", source: "resource" }],
  },
  projection: { status: "compiled", authorizations },
});

test("native integers survive parsing, explanation and raw rendering", () => {
  const parsed = readJson('{"amount":18446744073709551615,"expiry":-9223372036854775808}');
  expect(writeJson(parsed)).toBe('{"amount":18446744073709551615,"expiry":-9223372036854775808}');
  expect(permissionLabel(grant())).toContain("18,446,744,073,709,551,615");
  expect(writeJson(grant())).toContain('"remaining":18446744073709551615');
});

test("Kit decodes exact public key bytes and rejects narrowing", () => {
  expect(publicKey(Array(32).fill(0n))).toBe("11111111111111111111111111111111");
  expect(() => publicKey(Array(32).fill(256n))).toThrow("Malformed public key");
  expect(() => publicKey([0n])).toThrow("Malformed public key");
});

test("unsupported schemas, kinds and native amounts cannot become explanations", () => {
  expect(() => authorization({ ...grant(), schema_version: "0.2" })).toThrow("Unsupported ARM schema");
  expect(() => authorization({ ...grant(), authority_kind: { kind: "future" } })).toThrow(
    "Unsupported authority kind",
  );
  const invalid = grant();
  object(object(invalid.constraints).value).amount = -1n;
  expect(() => permissionLabel(invalid)).toThrow("Invalid native amount");
});

test("boolean alternatives do not imply one unconditional amount limit", () => {
  const permission = grant();
  permission.constraints = { kind: "any", value: [permission.constraints!, { kind: "true" }] };
  expect(permissionLabel(permission)).toBe("Spend under the recorded constraints");
});

test("evidence updates alone are not semantic changes; limits and removals are", () => {
  const before = grant();
  const refreshed = { ...before, evidence: { observed_at: "2" } };
  expect(compare(record(1n, [before]), record(2n, [refreshed]))).toEqual([]);
  const changed = { ...refreshed, usage: { kind: "cumulative", remaining: 1n } };
  expect(compare(record(1n, [before]), record(2n, [changed]))[0]?.kind).toBe("changed");
  expect(compare(record(1n, [before]), record(2n, []))[0]?.kind).toBe("removed");
  expect(compare(record(1n, []), record(2n, [before]))[0]?.kind).toBe("added");
});

test("comparison fails for different scopes, unordered banks, failed projections and duplicate identities", () => {
  const before = record(1n, [grant()]);
  const other = record(2n, []);
  other.snapshot.observation.cluster = "different";
  expect(() => compare(before, other)).toThrow("different scopes");
  expect(() => compare(before, before)).toThrow("earlier and a later");
  expect(() =>
    compare(before, {
      ...record(2n, []),
      projection: { status: "unsupported", reason: "unknown deployment" },
    }),
  ).toThrow("unsupported");
  expect(() => compare(before, record(2n, [grant(), grant()]))).toThrow("Ambiguous authorization");
});

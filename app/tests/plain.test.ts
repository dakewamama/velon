import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { array, object, readJson, short, text, UNLIMITED, type ObjectValue } from "../src/wire.ts";
import {
  allowance,
  assetMint,
  decimal,
  exposure,
  nextSteps,
  GLOSSARY,
  HISTORICAL,
  reported,
  type Holder,
  planApproval,
  planChanges,
  planName,
  planSentence,
  sentence,
  status,
  UNVERIFIED,
  when,
  who,
} from "../src/plain.ts";

// Lossless parsing keeps u64 amounts above 2^53 exact; every call returns a fresh copy.
const load = (path: string) => readJson(readFileSync(new URL(path, import.meta.url), "utf8"));
const spl = () => object(object(load("./fixtures/spl-control.json")).grant);
const arm = (name: string) =>
  array(load(`../../sdk/tests/fixtures/subscriptions-${name}-arm.json`)).map(object);
const technical = () => arm("recurring")[0]!;
const recurring = () => arm("recurring")[1]!;
const fixed = () => arm("fixed")[1]!;
const plan = () => arm("plan")[1]!;
const admin = () => arm("plan")[2]!;

const OWNER = "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq";
const DELEGATE = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";
const MINT = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";
const SUBSCRIBER = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const USDC = { symbol: "USDC", verified: true, decimals: 6 };
const mine = { viewer: OWNER, yours: true };

function limit(grant: ObjectValue, amount: bigint): ObjectValue {
  object(object(grant.constraints).value).amount = amount;
  object(grant.usage).remaining = amount;
  return grant;
}
// A Token-2022 permanent delegate as sdk/src/token2022.rs compiles it: set on the mint, no amount.
function permanent(): ObjectValue {
  return {
    ...spl(),
    id: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb:${MINT}:permanent-delegate:spend`,
    subject: { kind: "resource", value: { namespace: "solana:mint", id: MINT } },
    resource: { namespace: "solana:mint-token-accounts", id: MINT },
    constraints: { kind: "true" },
    usage: { kind: "unlimited" },
    native_context: { ...object(spl().native_context), protocol: "token-2022" },
  };
}

test("a verified token with known decimals reads as an exact amount from your wallet", () => {
  const grant = limit(spl(), 50_000_000n);
  expect(sentence(grant, { ...mine, token: USDC, delegate: { kind: "wallet", title: "Wallet" } })).toBe(
    `Wallet ${short(DELEGATE)} can take up to 50 USDC in total from your wallet without asking you again.`,
  );
});

test("unknown decimals stay in base units and known decimals are never rounded", () => {
  expect(sentence(spl())).toBe(
    `Address ${short(DELEGATE)} can take up to 25 of this token's smallest units in total from an account owned by ${short(OWNER)} without asking again.`,
  );
  expect(decimal(1_234_567n, 6)).toBe("1.234567");
  expect(decimal(1n, 9)).toBe("0.000000001");
  expect(decimal(10n ** 20n, 6)).toBe("100,000,000,000,000");
  expect(decimal(25n, 0)).toBe("25");
  const grant = limit(spl(), 1_000_001n);
  expect(sentence(grant, { ...mine, token: USDC })).toContain("up to 1.000001 USDC");
});

test("a creator-set name or symbol never enters the sentence", () => {
  for (const symbol of ["USDC", "https://claim.example", "SOL\u202e"]) {
    const said = sentence(spl(), { ...mine, token: { symbol, name: symbol, verified: false, decimals: 6 } });
    expect(said).not.toContain(symbol);
    expect(said).toContain("up to 0.000025 of this token in total");
  }
  const holder = sentence(permanent(), { token: { symbol: "USDC", verified: false } });
  expect(holder).not.toContain("USDC");
});

test("the holder is named only by the kind describeDelegate reported, never guessed", () => {
  const named = (delegate?: Holder) => who(spl(), { delegate });
  expect(named()).toBe(`Address ${short(DELEGATE)}`);
  expect(named({ kind: "wallet", title: "Wallet" })).toBe(`Wallet ${short(DELEGATE)}`);
  expect(named({ kind: "program", title: "Program" })).toBe(`Program ${short(DELEGATE)}`);
  expect(named({ kind: "account", title: "Program account" })).toBe(`Program account ${short(DELEGATE)}`);
  // No account at the address could be an unfunded wallet as well as a program's signer.
  expect(named({ kind: "none", title: "Program-derived address" })).toBe(`Address ${short(DELEGATE)}`);
  expect(named({ kind: "owned", title: "Squads V4" })).toBe(
    `An account controlled by Squads V4 (${short(DELEGATE)})`,
  );
  // Only a bundled program list entry names an app.
  expect(named({ kind: "listed", title: "Jupiter Aggregator v6" })).toBe("Jupiter Aggregator v6");
  // Mid-sentence, a description is lower-cased; a name is not.
  const inside = (delegate?: Holder) => who(spl(), { delegate }, true);
  expect(inside()).toBe(`address ${short(DELEGATE)}`);
  expect(inside({ kind: "owned", title: "Squads V4" })).toBe(
    `an account controlled by Squads V4 (${short(DELEGATE)})`,
  );
  expect(inside({ kind: "listed", title: "Jupiter Aggregator v6" })).toBe("Jupiter Aggregator v6");
});

test("an unlimited approval says any amount, while a near-maximum one reads as no practical limit", () => {
  const open = limit(spl(), UNLIMITED);
  expect(sentence(open, { ...mine, token: USDC })).toBe(
    `Address ${short(DELEGATE)} can take any amount of USDC from your wallet, now and later, without asking you again.`,
  );
  expect(sentence(open)).toContain("any amount of this token");
  const near = sentence(limit(spl(), UNLIMITED - 60n));
  expect(near).toContain("up to 18.4 quintillion of this token's smallest units (no practical limit)");
  expect(near).not.toContain("any amount");
});

test("a wallet that is not yours, or an account owned by another key, never says you", () => {
  const pasted = sentence(spl(), { viewer: OWNER, yours: false });
  expect(pasted).toContain("from this wallet without asking again.");
  expect(pasted).not.toMatch(/\byour?\b/);
  const other = sentence(spl(), { viewer: DELEGATE, yours: true });
  expect(other).toContain(`from an account owned by ${short(OWNER)}`);
  expect(other).not.toMatch(/\byour?\b/);
});

test("a used-up approval and a frozen account's approval say what still holds", () => {
  expect(sentence(limit(spl(), 0n), mine)).toBe(
    `Address ${short(DELEGATE)} is still approved on your wallet but has nothing left to take.`,
  );
  const frozen = { ...spl(), lifecycle: { kind: "suspended" } };
  expect(sentence(frozen, mine)).toBe(
    `Address ${short(DELEGATE)} is approved to take up to 25 of this token's smallest units in total from your wallet, but it is on hold.`,
  );
});

test("a grant Velon read as on hold, ended, barred or used up never says it can act", () => {
  const account = short(text(object(spl().resource).id));
  // An ended plan's admin grant is on hold (sdk/src/subscriptions.rs).
  const plan = { ...admin(), lifecycle: { kind: "suspended" } };
  expect(sentence(plan)).toBe(
    `Address ${short(DELEGATE)} owns this subscription plan, but changing who is allowed to charge through it is on hold.`,
  );
  expect(sentence(plan, { then: true })).toBe(
    `Address ${short(DELEGATE)} owned this subscription plan, but changing who is allowed to charge through it was on hold.`,
  );
  // A frozen account's Subscriptions approval is on hold; one with nothing left is used up.
  const frozen = { ...technical(), lifecycle: { kind: "suspended" } };
  expect(sentence(frozen)).toBe(
    `Solana Subscriptions is approved to take up to 18.4 quintillion of this token's smallest units (no practical limit) from an account owned by ${short(SUBSCRIBER)}, but it is on hold.`,
  );
  const spent = limit(technical(), 0n);
  expect(sentence(spent)).toBe(
    `Solana Subscriptions is still approved on an account owned by ${short(SUBSCRIBER)} but has nothing left to take.`,
  );
  // Rules that allow nothing are said, not pointed to.
  const barred = { ...spl(), constraints: { kind: "false" } };
  expect(sentence(barred, mine)).toBe(
    `Address ${short(DELEGATE)} is approved on your wallet, but its rules don't allow any use.`,
  );
  const close = { ...spl(), capability: "close" };
  expect(sentence({ ...close, constraints: { kind: "false" } })).toBe(
    `Address ${short(DELEGATE)} has permission to close account ${account} and collect the SOL it holds, but its rules don't allow any use.`,
  );
  const closed = { ...close, lifecycle: { kind: "revoked" } };
  expect(sentence(closed)).toBe(
    `Address ${short(DELEGATE)} no longer has permission to close account ${account} and collect the SOL it holds.`,
  );
  const lapsed = { ...close, lifecycle: { kind: "active", valid_from: null, valid_until: 10n } };
  expect(sentence(lapsed, { now: 10n })).toBe(sentence(closed));
  const freeze = { ...spl(), capability: "freeze", lifecycle: { kind: "suspended" } };
  expect(sentence(freeze)).toBe(
    `Address ${short(DELEGATE)} has the "freeze" permission on account ${account}, but it is on hold.`,
  );
  const later = {
    ...spl(),
    capability: "revoke_authority",
    lifecycle: { kind: "active", valid_from: 1_800_000_000n, valid_until: null },
  };
  expect(sentence(later, { now: 1_799_999_000n })).toBe(
    `Address ${short(DELEGATE)} can remove permissions on account ${account}, starting ${when(1_800_000_000n)}.`,
  );
  // The mint-wide delegate is always active today; if it ever is not, it says so too.
  const wide = { ...permanent(), lifecycle: { kind: "suspended" } };
  expect(sentence(wide, { token: USDC })).toBe(
    `Address ${short(DELEGATE)} is approved to move USDC out of any account that holds it, but it is on hold.`,
  );
  expect(sentence({ ...permanent(), lifecycle: { kind: "revoked" } })).toBe(
    "This approval has ended and can no longer take from any account that holds this token.",
  );
  const now = 1_800_000_151n;
  for (const grant of [plan, frozen, spent, barred, closed, freeze, wide, recurring()]) {
    expect(status(grant, "inactive", now).label).not.toBe("In force");
    expect(sentence(grant, { now })).not.toMatch(/\b(?:can|could) (?!no longer)/);
  }
});

test("a permanent delegate is set on the token itself and is never described as burning", () => {
  const grant = permanent();
  expect(assetMint(grant)).toBe(MINT);
  expect(assetMint(spl())).toBe(MINT);
  const said = sentence(grant, { token: USDC });
  expect(said).toBe(
    `Address ${short(DELEGATE)} can move USDC out of any account that holds it. It is set on the token itself, so holders can't remove it.`,
  );
  expect(said).not.toMatch(/burn/i);
});

test("a subscriptions technical approval is named from the verified grant, not the RPC", () => {
  const said = sentence(technical(), { delegate: { kind: "none", title: "Program-derived address" } });
  expect(said).toBe(
    `Solana Subscriptions can take up to 18.4 quintillion of this token's smallest units (no practical limit) from an account owned by ${short(SUBSCRIBER)}; it uses this approval to collect payments for any subscription on this account.`,
  );
});

test("a recurring subscription states its amount, period, end and recipients", () => {
  const now = 1_800_000_010n;
  expect(sentence(recurring(), { now })).toBe(
    `Address ${short(DELEGATE)} can charge up to 100 of this token's smallest units every 30 seconds from an account owned by ${short(SUBSCRIBER)} until ${when(1_800_000_151n)}.`,
  );
  expect(sentence(plan(), { now })).toBe(
    `Any of 2 keys can charge up to 100 of this token's smallest units every hour from an account owned by ${short(SUBSCRIBER)}, paid only to ${short("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY")}.`,
  );
  expect(sentence(fixed(), { now })).toBe(
    `Address ${short(DELEGATE)} can take up to 60 of this token's smallest units in total from an account owned by ${short(SUBSCRIBER)} until ${when(1_800_000_101n)}.`,
  );
});

test("a subscription that has not started says when it starts", () => {
  expect(sentence(recurring(), { now: 1_799_999_000n })).toContain(`every 30 seconds`);
  expect(sentence(recurring(), { now: 1_799_999_000n })).toContain(`, starting ${when(1_800_000_000n)}`);
  expect(sentence(recurring(), { now: 1_800_000_000n })).not.toContain("starting");
});

test("an ended or revoked subscription says it ended and never that it was cancelled", () => {
  const ended = sentence(recurring(), { now: 1_800_000_151n });
  expect(ended).toBe(
    `This subscription has ended and can no longer charge an account owned by ${short(SUBSCRIBER)}.`,
  );
  expect(sentence(fixed(), { now: 1_800_000_101n })).toBe(
    `This approval has ended and can no longer take from an account owned by ${short(SUBSCRIBER)}.`,
  );
  expect(sentence({ ...recurring(), lifecycle: { kind: "revoked" } })).toContain("has ended");
  for (const said of [ended, sentence(recurring(), { now: 1_800_000_010n })])
    expect(said).not.toMatch(/cancel/i);
});

test("the plan owner is named as owning the plan, and other powers name their account", () => {
  expect(sentence(admin())).toBe(
    `Address ${short(DELEGATE)} owns this subscription plan and can change who is allowed to charge through it.`,
  );
  const resource = short("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");
  expect(sentence({ ...spl(), capability: "modify_authority" })).toBe(
    `Address ${short(DELEGATE)} can change who is allowed to act on account ${resource}.`,
  );
  expect(sentence({ ...spl(), capability: "revoke_authority" })).toContain(
    `can remove permissions on account ${resource}`,
  );
  expect(sentence({ ...spl(), capability: "close" })).toContain(
    `can close account ${resource} and collect the SOL it holds`,
  );
  expect(sentence({ ...spl(), capability: "freeze" })).toBe(
    `Address ${short(DELEGATE)} has the "freeze" permission on account ${resource}.`,
  );
});

test("shared principals count their keys", () => {
  expect(who(plan())).toBe("Any of 2 keys");
  const together = { ...spl(), principal: { ...object(plan().principal), kind: "all_of" } };
  expect(who(together)).toBe("2 keys acting together");
  expect(sentence(together)).toStartWith("2 keys acting together can take up to 25");
});

test("constraints with no single amount fall back to Technical details", () => {
  const grant = spl();
  grant.constraints = { kind: "any", value: [grant.constraints!, { kind: "true" }] };
  expect(sentence(grant, mine)).toBe(
    `Address ${short(DELEGATE)} can take tokens from your wallet under rules listed in Technical details.`,
  );
  const other = plan();
  array(object(other.constraints).value)[1] = {
    kind: "constraint",
    value: { kind: "not_before", unix_seconds: 1 },
  };
  expect(sentence(other, { now: 1_800_000_010n })).toContain(
    ", under other rules listed in Technical details.",
  );
});

test("invalid native amounts throw instead of reading as a sentence", () => {
  expect(() => sentence(limit(spl(), -1n))).toThrow("Invalid native amount");
  expect(() => sentence(limit(spl(), UNLIMITED + 1n))).toThrow("Invalid native amount");
});

test("an earlier observation is told in the past tense", () => {
  expect(sentence(spl(), { ...mine, then: true })).toStartWith(
    `Address ${short(DELEGATE)} could take up to 25`,
  );
  expect(sentence(limit(spl(), 0n), { ...mine, then: true })).toContain("was still approved");
  expect(sentence(admin(), { then: true })).toContain("owned this subscription plan and could change");
});

test("an end time beyond what a date can show is pointed to Technical details", () => {
  expect(when(1_800_000_151n)).toMatch(/2027.* UTC$/);
  expect(when(9_223_372_036_854_775_807n)).toBeUndefined();
  const far = {
    ...recurring(),
    lifecycle: { kind: "active", valid_from: null, valid_until: 9_223_372_036_854_775_807n },
  };
  expect(sentence(far, { now: 1_800_000_010n })).toContain("until a date shown in Technical details.");
});

test("only a conditional grant reads as in force; other states give their reason", () => {
  const now = 1_800_000_010n;
  expect(status(spl(), "conditional")).toEqual({ label: "In force" });
  expect(status(recurring(), "inactive", 1_800_000_151n)).toEqual({
    label: "Ended",
    reason: `It ended on ${when(1_800_000_151n)}.`,
  });
  expect(status({ ...spl(), lifecycle: { kind: "revoked" } }, "inactive").label).toBe("Ended");
  expect(status({ ...spl(), lifecycle: { kind: "suspended" } }, "inactive")).toEqual({
    label: "On hold",
    reason: "It is on hold, so it can't be used right now.",
  });
  expect(status(recurring(), "inactive", 1_799_999_000n)).toEqual({
    label: "Not started",
    reason: `It starts on ${when(1_800_000_000n)}.`,
  });
  expect(status(limit(spl(), 0n), "inactive").label).toBe("Used up");
  expect(status({ ...spl(), constraints: { kind: "false" } }, "inactive").reason).toBe(
    "Its rules don't allow any use.",
  );
  const unknown = (grant: ObjectValue, at = now) => status(grant, "unknown", at);
  expect(unknown({ ...spl(), lifecycle: { kind: "unknown" } })).toEqual({
    label: "Not confirmed",
    reason: "Velon couldn't tell whether it has started or ended.",
  });
  expect(unknown(recurring(), 1_800_000_030n).reason).toContain("from an earlier period");
  expect(unknown(recurring(), 1_799_999_999n).reason).toContain("for a later period");
  const spent = recurring();
  object(spent.usage).remaining = 0n;
  expect(status(spent, "inactive", now)).toEqual({
    label: "Used up for now",
    reason: "Nothing is left for this period.",
  });
  expect(unknown({ ...spl(), usage: { kind: "cumulative", remaining: null } }).reason).toBe(
    "Velon couldn't read how much is left.",
  );
  expect(unknown(admin()).reason).toContain("not every rule the program applies");
  expect(unknown(recurring()).reason).toContain("works through another approval");
  expect(unknown(spl()).reason).toBe("Velon can't confirm it is usable right now.");
  expect(status(spl(), HISTORICAL).label).toBe("Earlier state");
  // A value the runtime never sends is shown as it came, never relabelled.
  expect(status(spl(), "active")).toEqual({ label: "active" });
  for (const availability of ["inactive", "unknown", HISTORICAL, "active", ""])
    expect(status(spl(), availability, now).label).not.toBe("In force");
});

test("an approval Velon could not verify is attributed to the network and keeps its reason", () => {
  const entry = { delegate: DELEGATE, ui: "1.5", unlimited: false, where: "your wallet" };
  expect(reported(entry)).toBe(
    `The network reports that address ${short(DELEGATE)} can take up to 1.5 of this token from your wallet.`,
  );
  expect(reported({ ...entry, by: "Devnet", unlimited: true, token: USDC })).toBe(
    `Devnet reports that address ${short(DELEGATE)} can take any amount of USDC from your wallet.`,
  );
  expect(reported({ ...entry, token: { symbol: "USDC", verified: false } })).not.toContain("USDC");
  for (const reason of ["UnsupportedVersion", "UnsupportedOperation", "default"])
    expect(UNVERIFIED[reason]).toContain("This is what the network reports.");
});

test("the glossary explains the words the cards use", () => {
  expect(GLOSSARY.map(([term]) => term)).toEqual(
    expect.arrayContaining(["Approval", "Token account", "Subscription", "Remove access"]),
  );
  for (const [, meaning] of GLOSSARY) expect(meaning).not.toContain("\u2014");
});

test("a wallet row's amount names a listed token only, and says smallest units when the scale is unknown", () => {
  expect(allowance(limit(spl(), UNLIMITED), USDC)).toBe("No limit");
  expect(allowance(limit(spl(), 18446744073709551555n), USDC)).toBe("No practical limit");
  expect(allowance(limit(spl(), 2_500_000n), USDC)).toBe("Up to 2.5 USDC");
  // A creator-set symbol stays in the token cell; the amount stands alone.
  expect(allowance(limit(spl(), 2_500_000n), { symbol: "USDC", verified: false, decimals: 6 })).toBe(
    "Up to 2.5",
  );
  expect(allowance(limit(spl(), 25n))).toBe("Up to 25 smallest units");
});

test("a plan says what it can charge, where it pays, and why the wallet warns", () => {
  const terms = {
    amount: 49_000_000n,
    periodHours: 720n,
    endTs: 0n,
    destinations: [DELEGATE],
  };
  expect(planSentence(terms, USDC)).toBe(
    `Subscribing lets this plan charge up to 49 USDC every 30 days from your wallet, paid only to ${short(DELEGATE)}.`,
  );
  // A creator-set symbol never enters the sentence; no destinations means no limit is claimed.
  const open = { ...terms, destinations: [] };
  expect(planSentence(open, { symbol: "USDC", verified: false, decimals: 6 })).toBe(
    "Subscribing lets this plan charge up to 49 of this token every 30 days from your wallet.",
  );
  expect(planChanges(open)).toContain("doesn't limit where payments go");
  expect(planChanges(terms)).toContain("so is where payments go");
  const [why, limit] = planApproval(terms, USDC);
  expect(why).toContain("That approval carries no amount, so wallets show it as able to take any amount.");
  expect(limit).toContain("For this plan that is up to 49 USDC every 30 days.");
});

test("a plan's name is read only from its merchant's {n} metadata", () => {
  expect(planName('{"n":"Helius Business (Monthly)"}')).toBe("Helius Business (Monthly)");
  expect(planName("https://example.com/plan.json")).toBeUndefined();
  expect(planName('{"n":""}')).toBeUndefined();
  expect(planName(`{"n":"${"x".repeat(65)}"}`)).toBeUndefined();
  expect(planName('{"name":"Other"}')).toBeUndefined();
});

test("exposure sets an approval against what its account holds now", () => {
  expect(exposure(UNLIMITED, 109_172_600n, USDC)).toBe("All 109.1726 USDC here now, and anything sent later");
  expect(exposure(500_000_000n, 109_172_600n, USDC)).toBe("All 109.1726 USDC here now");
  expect(exposure(25_000_000n, 109_172_600n, USDC)).toBe("25 USDC of the 109.1726 USDC here now");
  expect(exposure(UNLIMITED, 0n, USDC)).toBe("None of it is here now");
  // A creator-set symbol stays out, as everywhere else.
  expect(exposure(UNLIMITED, 5_000_000n, { symbol: "USDC", verified: false, decimals: 6 })).toBe(
    "All 5 of this token here now, and anything sent later",
  );
});

const quiet = {
  total: 0,
  removable: 0,
  unlimitedRemovable: 0,
  reported: 0,
  running: 0,
  connected: false,
  owner: false,
  mainnet: true,
  unread: false,
};

test("next steps say what to do after a check, at most three", () => {
  expect(nextSteps(quiet)).toEqual([
    "Nothing to do. Check again after you approve a new app, or check another wallet.",
  ]);
  const exposed = { ...quiet, total: 5, removable: 4, unlimitedRemovable: 3, reported: 1 };
  const looking = nextSteps(exposed);
  expect(looking).toHaveLength(3);
  expect(looking[0]).toStartWith("Connect this wallet.");
  expect(looking[1]).toBe(
    "Remove the ones you don't use, starting with the 3 with no limit. Each is one signature and about 0.000015 SOL in fees.",
  );
  expect(looking[2]).toContain("receipt");
  expect(nextSteps({ ...exposed, connected: true })).toEqual([
    "Only this wallet's owner can remove these. Send them this page's link, or connect the owner's wallet.",
    "Velon can't remove the one shown as the network reports yet. Details shows who holds it.",
  ]);
  expect(nextSteps({ ...exposed, connected: true, owner: true })[0]).toStartWith(
    "Review the 3 with no limit",
  );
  expect(nextSteps({ ...exposed, connected: true, owner: true, unlimitedRemovable: 1 })[0]).toStartWith(
    "Choose Remove access",
  );
  expect(nextSteps({ ...quiet, total: 1, running: 1 })).toEqual([
    "Velon can't remove a subscription that is still running. It can be removed here once it is cancelled and its paid period has ended.",
  ]);
  // A partial read says so first, and never claims there is nothing to do.
  expect(nextSteps({ ...quiet, unread: true })[0]).toStartWith("Check again.");
  expect(nextSteps({ ...quiet, unread: true })).toHaveLength(1);
  expect(nextSteps({ ...exposed, mainnet: false })[1]).toEndWith("Each is one signature.");
});

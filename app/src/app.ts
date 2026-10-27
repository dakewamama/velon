import { createSolanaRpc } from "@solana/rpc";
import { signAndSubmitReviewedTransaction } from "catalyst-sdk/src/submit";
import { action, result, reviewRevoke, verifiedRevoke, type Control, type ActionState } from "./control.ts";
import { wallets, signingWallets, testWallet, type SigningWallet } from "./wallet.ts";
import { address as toAddress, isAddress } from "@solana/addresses";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import {
  compileTransaction,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/transactions";
import { avatar, icon, solana, type IconName } from "./icons.ts";
import { TOKENS, describeDelegate, nameTokens, rpcHeaders, tokenLogo, tokenName } from "./tokens.ts";
import {
  call,
  array,
  authorization,
  compare,
  grants,
  integer,
  object,
  mintOf,
  permissionLabel,
  principalLabel,
  publicKey,
  readJson,
  KINDS,
  meaning,
  semantic,
  short,
  STATUS,
  system,
  text,
  writeJson,
  type Json,
  type ObjectValue,
} from "./wire.ts";

type Scenario = {
  name: string;
  scope: string;
  live: boolean;
  snapshots: { id: string; slot: string }[];
  examples: { label: string; address: string }[];
};
const form = document.querySelector<HTMLFormElement>("#scan-form")!;
const input = document.querySelector<HTMLInputElement>("#address")!;
const select = document.querySelector<HTMLSelectElement>("#scenario")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const results = document.querySelector<HTMLElement>("#results")!;
const diff = document.querySelector<HTMLElement>("#diff")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
let scenarios: Scenario[] = [];
let request: AbortController | undefined;
let mode: "scan" | "diff" = "scan";

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = content;
  result.className = className;
  return result;
}

async function get(path: string, signal?: AbortSignal): Promise<Json> {
  const response = await call(`/api/${path}`, { signal });
  if (!response.ok) {
    if (response.status === 409)
      throw new Error("Conflicting observations at the same slot. No current permission can be shown.");
    if (response.status === 404) throw new Error("No observation is available for this scope.");
    throw new Error("The observation provider is unavailable. Try scanning again.");
  }
  return readJson(await response.text());
}

function status(message: string, error = false) {
  notice.replaceChildren(node("p", message, error ? "error" : "notice"));
}

function raw(title: string, value: Json): HTMLDetailsElement {
  const section = node("details");
  section.append(node("summary", title), node("pre", writeJson(value, 2)));
  return section;
}

function field(title: string, value: string): HTMLElement {
  const row = node("div", "", "field");
  row.append(node("dt", title), node("dd", value));
  return row;
}

// An address with its avatar and a copy button; the full key stays selectable.
function address(title: string, value: string): HTMLElement {
  const row = field(title, "");
  const cell = row.querySelector("dd")!;
  cell.classList.add("address-cell");
  const copy = node("button", "", "icon-button");
  copy.type = "button";
  copy.title = "Copy address";
  copy.setAttribute("aria-label", `Copy ${title.toLowerCase()} address`);
  copy.append(icon("copy"));
  copy.onclick = async () => {
    await navigator.clipboard?.writeText(value).catch(() => {});
    copy.replaceChildren(icon("check"));
    setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
  };
  cell.append(avatar(value), node("span", value, "mono"), copy);
  return row;
}

// A button or link that leads with its icon.
function labelled<T extends HTMLElement>(element: T, name: IconName): T {
  element.prepend(icon(name));
  return element;
}

// The header names the network, with Solana's mark whenever a real cluster is behind it.
function badge(label: string, chain = true) {
  const target = document.querySelector<HTMLElement>(".header-links .badge")!;
  target.replaceChildren(...(chain && control ? [solana()] : []), label);
}

function metadata(view: ObjectValue): HTMLElement {
  const observation = object(view.observation);
  const coverage = object(view.coverage);
  const block = node("section", "", "state-meta");
  block.append(
    node(
      "p",
      `${text(observation.origin)} evidence · slot ${integer(observation.slot)} · ${coverage.complete === true ? "Reported complete coverage" : "Partial coverage"}`,
      "eyebrow",
    ),
  );
  block.append(
    node(
      "p",
      "Only this account was read. Other permissions may exist elsewhere, so an empty list is not an all-clear.",
      "muted",
    ),
  );
  block.append(
    raw("Technical: state and adapter provenance", {
      state_version: view.state_version!,
      observation,
      coverage,
      versions: view.versions!,
      sdk_revision: view.sdk_revision!,
      arm_schema_version: view.arm_schema_version!,
    }),
  );
  return block;
}

// Details open inside the card they belong to; one summary is open at a time.
function toggleDetail(row: HTMLElement, button: HTMLButtonElement, grant: ObjectValue) {
  const open = row.querySelector("#detail");
  for (const other of results.querySelectorAll("#detail")) other.remove();
  for (const other of results.querySelectorAll<HTMLButtonElement>("[aria-expanded]")) {
    other.setAttribute("aria-expanded", "false");
    other.textContent = "View details";
  }
  if (open) return;
  button.setAttribute("aria-expanded", "true");
  button.textContent = "Hide details";
  const detail = node("section", "", "detail");
  detail.id = "detail";
  const facts = node("dl", "", "facts");
  const usage = object(grant.usage);
  facts.append(
    field("Enforcement", text(grant.enforcement)),
    field("Observability", text(grant.observability)),
    field("Lifecycle", text(object(grant.lifecycle).kind)),
    field("Usage", text(usage.kind)),
  );
  if (usage.remaining !== undefined)
    facts.append(
      field(
        "Remaining at observation",
        usage.remaining === null
          ? "Unknown"
          : allowance(text(object(grant.resource).id), integer(usage.remaining)),
      ),
    );
  detail.append(facts);
  if (object(grant.principal).kind !== "identity")
    detail.append(
      node(
        "p",
        "These principals share one permission and one allowance. The budget is not duplicated for each signer.",
        "notice",
      ),
    );
  if (object(grant.authority_kind).kind === "derived")
    detail.append(
      node(
        "p",
        "This authority depends on its parent grant. Generic availability remains unknown until those dependencies are resolved.",
        "notice",
      ),
    );
  detail.append(
    raw("Full constraints and lineage", {
      constraints: grant.constraints!,
      authority_kind: grant.authority_kind!,
      usage: grant.usage!,
    }),
    raw("Native context and evidence", { native_context: grant.native_context!, evidence: grant.evidence! }),
    raw("Exact ARM authorization", grant),
  );
  row.append(detail);
}

function summary(permissions: { grant: ObjectValue }[], view: ObjectValue): HTMLElement {
  const count = (matches: (grant: ObjectValue) => boolean) =>
    String(permissions.filter(({ grant }) => matches(grant)).length);
  const block = node("div", "", "summary");
  for (const [value, label] of [
    [String(permissions.length), "Permissions found"],
    [count((grant) => object(grant.usage).kind === "recurring"), "Repeat on a schedule"],
    [count((grant) => object(grant.authority_kind).kind === "administrative"), "Can change the rules"],
    [object(view.coverage).complete === true ? "Complete" : "Partial", "How much was read"],
  ] as const) {
    const tile = node("div");
    tile.append(node("strong", value), node("span", label));
    block.append(tile);
  }
  return block;
}

// Why an observed approval is shown without a revoke. Velon never offers what it cannot prove.
const UNVERIFIED: Record<string, string> = {
  UnsupportedVersion:
    "This token program's current build is not one Velon has verified, so it will not prepare a revoke for it. The approval is shown as the RPC reports it.",
  UnsupportedOperation:
    "This approval uses a feature Velon cannot model exactly yet, such as a token extension that changes how spending works or a multisig delegate. It is shown as the RPC reports it.",
  default:
    "Velon could not verify this approval, so it is shown as the RPC reports it and cannot be revoked here.",
};

// Revokes the visitor asked to review in a row. Each still gets its own review and signature.
let queue: (() => void)[] = [];
const revocable = new WeakMap<HTMLElement, () => void>();

function card(grant: ObjectValue, view: ObjectValue, availability: string, scope?: string): HTMLElement {
  const row = node("article", "", "permission");
  row.dataset.id = text(grant.id);
  const actor = object(grant.principal);
  row.dataset.who = actor.kind === "identity" ? short(text(actor.value)) : "several keys";
  const left = object(grant.usage).remaining;
  row.dataset.amount = left == null ? "" : compact(integer(left));
  row.dataset.system = text(object(grant.native_context).protocol);
  const header = node("div", "", "permission-header");
  const state = node("span", STATUS[availability] ?? availability, "availability");
  state.dataset.state = availability;
  const kind = text(object(grant.authority_kind).kind);
  const source = text(object(grant.resource).id);
  const mint = mintOf(grant);
  const asset = node("span", "", "token");
  if (mint) {
    const label = tokenName(mint);
    asset.append(tokenLogo(mint), node("span", label.symbol ?? label.name ?? `Token ${short(mint)}`));
    // A creator can name a token anything, including a link; only listed tokens are verified.
    if (!label.verified && (label.symbol || label.name))
      asset.append(node("span", "unverified", "unverified"));
    asset.title = `${label.name ?? "Token"}${label.verified ? "" : " (name set by its creator, not verified)"}: ${mint}`;
  }
  header.prepend(asset);
  header.append(node("span", KINDS[kind] ?? kind, "badge"), state);
  row.append(
    header,
    node(
      "h3",
      permissionLabel(grant, (units) =>
        units === UNLIMITED
          ? "every token, with no limit"
          : (tokens(units, source, mint) ?? `${units.toLocaleString("en-US")} base units`),
      ),
    ),
    delegate(grant),
    node("p", meaning(grant, connected?.account.address), "explain"),
  );
  const usage = object(grant.usage);
  if (usage.remaining !== undefined)
    row.append(
      node(
        "p",
        usage.remaining === null
          ? "Remaining allowance is unknown."
          : integer(usage.remaining) === UNLIMITED
            ? "No limit: the delegate can move every token this account holds, now and later."
            : `${allowance(source, integer(usage.remaining), mint)} remain at this observation.`,
        usage.remaining !== null && integer(usage.remaining) === UNLIMITED
          ? "remaining unlimited"
          : "remaining",
      ),
    );
  const facts = node("dl");
  facts.append(
    object(grant.principal).kind === "identity"
      ? address("Who", text(object(grant.principal).value))
      : field("Who", principalLabel(grant.principal)),
    address("From", text(object(grant.resource).id)),
    field("Native system", system(grant)),
  );
  // The wallet that owns the account the permission applies to.
  const holder = object(grant.subject);
  if (holder.kind === "identity") facts.prepend(address("Owner", text(holder.value)));
  const actions = node("div", "", "permission-actions");
  const button = node("button", "View details", "link-button");
  button.setAttribute("aria-expanded", "false");
  button.onclick = () => toggleDetail(row, button, grant);
  actions.append(button);
  row.append(facts, actions);
  const protocol = text(object(grant.native_context).protocol);
  if (
    control &&
    scope &&
    connected &&
    object(view.observation).origin === "finalized" &&
    grant.observability === "exact" &&
    grant.capability === "spend" &&
    ((["spl-token", "token-2022"].includes(protocol) &&
      object(grant.authority_kind).kind === "direct" &&
      object(grant.lifecycle).kind === "active") ||
      (protocol === "subscriptions" && ended(grant, view) && revokeKey(grant) !== undefined)) &&
    object(grant.subject).kind === "identity" &&
    object(grant.subject).value === connected.account.address
  ) {
    const revoke = labelled(node("button", "Revoke", "action-button"), "revoke");
    const start = () => void prepare(grant, scope);
    revoke.onclick = () => {
      queue = [];
      start();
    };
    revocable.set(row, start);
    actions.prepend(revoke);
  } else if (scope && grant.capability === "spend") {
    // Only the token account's owner can sign a revoke; that is the chain's rule, not a setting.
    const holder = object(grant.subject);
    const owner = holder.kind === "identity" ? text(holder.value) : "";
    if (!connected) {
      const start = labelled(node("button", "Connect to revoke", "action-button"), "wallet");
      start.onclick = () => connectButton.click();
      actions.prepend(start);
    } else if (owner && owner !== connected.account.address)
      actions.append(node("span", `Only wallet ${short(owner)} can revoke this.`, "muted"));
  }
  return row;
}

const SUBSCRIPTIONS = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";

// A subscription grant whose cancellation has taken effect at this observation. Only then does the
// program close its delegation; an active subscription can only be cancelled, and the technical
// approval it rests on is direct and never closed here.
function ended(grant: ObjectValue, view: ObjectValue): boolean {
  const lifecycle = object(grant.lifecycle);
  const now = object(view.observation).unix_timestamp;
  return (
    object(grant.authority_kind).kind === "derived" &&
    lifecycle.kind === "active" &&
    lifecycle.valid_until != null &&
    now != null &&
    integer(lifecycle.valid_until) <= integer(now)
  );
}

// The account a revoke is keyed by: the token account for SPL, and for Subscriptions the
// delegation named in the grant id `<program>:<delegation>:<init id>:spend`, never the shared
// token account.
function revokeKey(grant: ObjectValue): string | undefined {
  if (text(object(grant.native_context).protocol) !== "subscriptions") return text(object(grant.resource).id);
  const [program, delegation, init, capability, ...rest] = text(grant.id).split(":");
  return program === SUBSCRIPTIONS &&
    delegation !== undefined &&
    isAddress(delegation) &&
    /^-?\d+$/.test(init ?? "") &&
    capability === "spend" &&
    rest.length === 0
    ? delegation
    : undefined;
}

// Who holds the permission, named from what the chain says the key is.
function delegate(grant: ObjectValue): HTMLElement {
  const actor = object(grant.principal);
  const line = node("div", "", "delegate");
  if (actor.kind !== "identity") {
    line.append(
      node("strong", "Several keys"),
      node("span", "Any of them can use this one shared permission", "muted"),
    );
    return line;
  }
  const key = text(actor.value);
  const name = node("strong", short(key));
  const detail = node("span", `Delegate through ${system(grant)}`, "muted");
  line.append(avatar(key), name, detail);
  if (control)
    void describeDelegate(control.rpcUrl, key)
      .then((found) => {
        name.textContent = found.title;
        detail.textContent = `${found.detail} · ${short(key)}`;
      })
      .catch(() => {});
  return line;
}

// Short enough for the diagram's node: 25, 1.2K, 4.5M, then powers of ten.
function compact(units: bigint): string {
  if (units === UNLIMITED) return "∞";
  if (units < 1_000_000_000_000n)
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(units);
  const digits = units.toString();
  return `${digits[0]}.${digits[1]}e${digits.length - 1}`;
}

function currentScenario(): Scenario {
  const scenario = scenarios[Number(select.value)];
  if (!scenario) throw new Error("No native observation selected.");
  return scenario;
}

// What the address is on chain: a wallet, an SPL Token account, a Token-2022 account or something else.
// Undefined when the RPC did not answer.
async function addressKind(
  address: string,
  signal: AbortSignal,
): Promise<{ kind: string; wallet?: ObjectValue } | undefined> {
  const response = await call("/api/live/wallet", {
    method: "POST",
    headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
    body: JSON.stringify({ owner: address }),
    signal,
  }).catch(() => undefined);
  // A server without this endpoint reads every address as a token account, as before.
  if (response?.status === 404) return { kind: "token-account" };
  if (!response?.ok) return undefined;
  const wallet = object(readJson(await response.text()));
  return { kind: text(wallet.kind), wallet };
}

// A pasted subscription delegation's grants are read through the token account it draws from.
const drawsFrom = new Map<string, string>();

async function scan(historical = false, refresh = false) {
  invalidateReview();
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const address = input.value.trim() || subject;
  results.replaceChildren();
  scanButton.disabled = false;
  if (!isAddress(address)) {
    if (currentScenario().live) status("Pick an account from the list, or paste a token account.");
    else status("Enter a valid Solana address.", true);
    return;
  }
  scanButton.disabled = true;
  status("Loading the selected observation...");
  try {
    const scenario = currentScenario();
    const live = scenario.live;
    compareTab(!live);
    let subscription = false;
    // On a public cluster a pasted wallet is read like a connected one, without signing rights.
    if (live && control?.network !== "localnet") {
      const found = await addressKind(address, signal);
      const kind = found?.kind;
      const refused: Record<string, string> = {
        mint: "This is a token mint, not a wallet or a token account. Paste the wallet that holds the token instead.",
        "token-2022-account":
          "This is a Token-2022 account. Velon lists Token-2022 delegates for a wallet but cannot verify or revoke them yet. Paste the owner's wallet address instead.",
        other:
          "This address is owned by a program, not a wallet or an SPL Token account. Paste a wallet address or one of its token accounts.",
      };
      // A Subscriptions account is observed; the runtime reads it only as a subscription delegation.
      subscription = kind === "other" && found!.wallet!.program === SUBSCRIPTIONS;
      if (kind === undefined || (refused[kind] && !subscription)) {
        scanButton.disabled = false;
        status(
          kind ? refused[kind]! : "The RPC did not answer. It may be rate limiting; try again in a minute.",
          true,
        );
        return;
      }
      if (kind === "wallet") {
        scanButton.disabled = false;
        status("Reading the wallet's token accounts...");
        // A wallet is never re-read as a single token account.
        await scanWallet(address, found!.wallet);
        return;
      }
    }
    if (live && (refresh || !scenario.scope)) {
      status("Observing the finalized token account...");
      const observed = await call("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source: address }),
        signal,
      });
      const observation = object(await result(observed));
      scenario.scope = text(observation.scope_id);
      if (subscription) {
        const target = array(object(object(observation.record).snapshot).targets)
          .map(object)
          .find((target) => target.kind === "subscription" && publicKey(target.delegation) === address);
        if (!target) throw new Error("This Subscriptions account is not a subscription delegation.");
        drawsFrom.set(address, publicKey(target.source));
      }
    }
    badge(live ? network().label : "Recorded native evidence", live);
    document.querySelector(".scope-note")!.textContent = live
      ? "Read from a finalized observation of this token account. Coverage is partial."
      : "Read from accounts captured in executed native tests. Coverage is partial.";
    const path = historical
      ? `snapshots/${scenario.snapshots[0]!.id}/authorizations/${address}`
      : `scopes/${scenario.scope}/effective/${drawsFrom.get(address) ?? address}`;
    const view = object(await get(path, signal));
    if (view.arm_schema_version !== "0.1")
      throw new Error("Unsupported ARM schema. Permission interpretation is unavailable.");
    const entries = array(object(view.projection).authorizations ?? []);
    if (object(view.projection).status !== "compiled") {
      grants(view.projection);
    }
    const permissions = entries.map((entry) =>
      historical
        ? { grant: authorization(entry), availability: "Historical grant; availability not evaluated" }
        : {
            grant: authorization(object(entry).authorization),
            availability: text(object(entry).availability),
          },
    );
    if (live)
      await nameTokens(
        permissions.flatMap(({ grant }) => mintOf(grant) ?? []),
        signal,
      ).catch(() => undefined);
    const content = document.createDocumentFragment();
    const heading = node("div", "", "section-heading");
    heading.append(node("h2", historical ? "Who could act on it earlier" : "Who can act on this account"));
    if (scenario.snapshots.length > 1) {
      const toggle = node(
        "button",
        historical ? "View current observation" : `View earlier slot ${scenario.snapshots[0]!.slot}`,
        "link-button",
      );
      toggle.onclick = () => scan(!historical);
      heading.append(toggle);
    }
    content.append(summary(permissions, view), heading, metadata(view));
    if (permissions.length === 0)
      content.append(
        node("p", "No permissions found in the state that was read. Coverage is partial.", "empty"),
      );
    else
      for (const { grant, availability } of permissions)
        content.append(card(grant, view, availability, live ? scenario.scope : undefined));
    reload = () => scan();
    if (signal.aborted) return;
    results.replaceChildren(content);
    guide(permissions.length && results.querySelector(".action-button") ? 3 : 2);
    if (refresh && innerWidth < 960) results.scrollIntoView({ block: "start" });
    notice.replaceChildren();
    for (const row of feed.querySelectorAll<HTMLElement>(".feed-row"))
      row.toggleAttribute("aria-current", row.dataset.source === address);
    return true;
  } catch (error) {
    if (!signal.aborted) {
      results.replaceChildren();
      status(error instanceof Error ? error.message : "Unable to read the observation.", true);
    }
  } finally {
    if (!signal.aborted) scanButton.disabled = false;
  }
}

async function showDiff() {
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  diff.replaceChildren();
  const scenario = currentScenario();
  if (scenario.snapshots.length < 2) {
    status("This fixture has one observation. A comparison requires two native states.");
    return;
  }
  status("Comparing the two recorded native states...");
  try {
    const [before, after] = await Promise.all([
      get(`snapshots/${scenario.snapshots[0]!.id}`, signal),
      get(`scopes/${scenario.scope}`, signal),
    ]);
    const changes = compare(before!, after!);
    if (signal.aborted) return;
    diff.append(
      node(
        "h2",
        `Observed changes: slot ${scenario.snapshots[0]!.slot} → ${integer(object(object(object(after).snapshot).observation).slot)}`,
      ),
    );
    diff.append(
      node(
        "p",
        "This compares recorded states across several native transitions. It does not predict a transaction or attribute every change to revoke alone.",
        "notice",
      ),
    );
    if (changes.length === 0)
      diff.append(node("p", "No semantic authorization changes between these observations.", "empty"));
    for (const change of changes) {
      const grant = change.after ?? change.before!;
      const row = node("article", "", "permission");
      const header = node("div", "", "permission-header");
      const kind = text(object(grant.authority_kind).kind);
      header.append(node("span", change.kind, "badge change"), node("span", KINDS[kind] ?? kind, "badge"));
      row.append(header, node("h3", permissionLabel(grant)));
      row.append(node("p", principalLabel(grant.principal), "address"));
      if (change.before) row.append(raw("Before", change.before));
      if (change.after) row.append(raw("After", change.after));
      diff.append(row);
    }
    diff.append(
      raw("Observation provenance", {
        before: {
          id: object(before).id!,
          observation: object(object(before).snapshot).observation!,
          versions: object(before).versions!,
        },
        after: {
          id: object(after).id!,
          observation: object(object(after).snapshot).observation!,
          versions: object(after).versions!,
        },
      }),
    );
    status("Comparison complete. Source evidence is retained in both records.");
  } catch (error) {
    if (!signal.aborted) {
      diff.replaceChildren();
      status(error instanceof Error ? error.message : "Comparison unavailable.", true);
    }
  }
}

function setMode(next: "scan" | "diff", refresh = false) {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  receipts.hidden = true;
  document.querySelector("#receipts-tab")!.classList.remove("selected");
  invalidateReview();
  mode = next;
  results.hidden = next !== "scan";
  diff.hidden = next !== "diff";
  document.querySelector("#scan-tab")!.classList.toggle("selected", next === "scan");
  document.querySelector("#diff-tab")!.classList.toggle("selected", next === "diff");
  if (next === "diff") {
    scanButton.disabled = false;
    void showDiff();
  } else void (refresh ? scan(false, true) : reload());
}

// The account shown when the visitor has not typed or picked one.
let subject = "";
function selectScenario() {
  const scenario = currentScenario();
  const examples = document.querySelector<HTMLElement>("#examples")!;
  examples.replaceChildren();
  // A live ledger lists its own accounts; fixed examples belong to recorded evidence.
  examples.hidden = scenario.live && control?.network === "localnet";
  if (scenario.examples.length) examples.append(node("span", "Try", "muted"));
  for (const example of scenario.examples) {
    const button = node("button", example.label, "example");
    button.onclick = () => {
      input.value = example.address;
      setMode("scan", true);
    };
    examples.append(button);
  }
  // The first example opens with the set, but the box stays the visitor's to fill.
  subject = scenario.examples[0]?.address ?? "";
  input.value = "";
  if (mode === "diff") void showDiff();
  else void scan();
}

let control: Control | null = null;
// Wallet Standard chain, plain name and Explorer suffix for the server's network.
const NETWORKS = {
  mainnet: { chain: "solana:mainnet", label: "Mainnet", explorer: () => "" },
  devnet: { chain: "solana:devnet", label: "Devnet", explorer: () => "?cluster=devnet" },
  localnet: {
    chain: "solana:localnet",
    label: "Local validator",
    explorer: () => `?cluster=custom&customUrl=${encodeURIComponent(control?.rpcUrl ?? "")}`,
  },
} as const;
const network = () => NETWORKS[control?.network ?? "localnet"];
const explorer = (kind: "address" | "tx", value: string) =>
  `https://explorer.solana.com/${kind}/${value}${network().explorer()}`;
// Mint decimals as the RPC's token index reported them, keyed by token account. Display only:
// every check and every signed byte stays in base units.
const decimals = new Map<string, number>();
const UNLIMITED = 18446744073709551615n;
function tokens(units: bigint, source: string, mint?: string): string | undefined {
  const known = mint ? TOKENS[mint] : undefined;
  const scale = known?.decimals ?? decimals.get(source);
  if (scale === undefined) return undefined;
  const whole = (units / 10n ** BigInt(scale)).toLocaleString("en-US");
  const fraction = (units % 10n ** BigInt(scale)).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ${known?.symbol ?? "tokens"}`;
}
function allowance(source: string, units: bigint, mint?: string): string {
  if (units === UNLIMITED) return "Unlimited: every token this account will ever hold";
  const base = `${units.toLocaleString("en-US")} base units`;
  const shown = tokens(units, source, mint);
  return shown ? `${shown} (${base})` : base;
}
let connected: { wallet: SigningWallet; account: SigningWallet["accounts"][number] } | undefined;
let unsubscribe: (() => void) | undefined;
let actionAbort: AbortController | undefined;
let actionState: ActionState | undefined;
const chooser = document.querySelector<HTMLDialogElement>("#wallet-chooser")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect-wallet")!;
const disconnectButton = document.querySelector<HTMLButtonElement>("#disconnect-wallet")!;
const walletStatus = document.querySelector<HTMLElement>("#wallet-status")!;
const review = document.querySelector<HTMLDialogElement>("#revoke-review")!;
const actionResult = document.querySelector<HTMLElement>("#action-result")!;

function invalidateReview() {
  if (actionState === "PREPARING" || actionState === "SIMULATED") {
    actionAbort?.abort();
    review.close();
    actionState = undefined;
  }
}

function refreshWallets() {
  const available = signingWallets();
  connectButton.hidden = !!connected;
  connectButton.disabled = !available.length || !scenarios.length;
  connectButton.title = available.length ? "" : "No Solana wallet with signTransaction was detected.";
}
wallets.on("register", refreshWallets);
wallets.on("unregister", () => {
  if (connected && !wallets.get().includes(connected.wallet)) disconnected();
  refreshWallets();
});
connectButton.prepend(icon("wallet"));
refreshWallets();

function disconnected() {
  actionAbort?.abort();
  review.close();
  unsubscribe?.();
  unsubscribe = undefined;
  connected = undefined;
  disconnectButton.hidden = true;
  tryPanel.dataset.state = "";
  delete stage.dataset.state;
  draw();
  document.querySelector("#try-status")!.textContent = "Test chain. Test tokens. Your signature.";
  bench.hidden = !control?.testBench;
  walletStatus.textContent = "";
  refreshWallets();
  if (actionState)
    setAction("FAILED", "Wallet changed. Any submitted transaction must still be checked on chain.");
  // The wallet's view goes with the wallet; a live console returns to its first screen.
  reload = () => scan();
  if (document.body.classList.contains("is-live")) lesson();
  else void scan();
}
disconnectButton.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  disconnected();
};
// One button for every Wallet Standard wallet; a chooser appears only when several are installed.
connectButton.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  const available = signingWallets();
  if (available.length < 2) return void connect(available[0]);
  chooser.replaceChildren(
    node("h2", "Connect a wallet"),
    ...available.map((wallet) => {
      const option = node("button", "", "wallet-option");
      const icon = node("img");
      icon.src = wallet.icon;
      icon.alt = "";
      option.append(icon, node("span", wallet.name));
      option.onclick = () => {
        chooser.close();
        void connect(wallet);
      };
      return option;
    }),
  );
  chooser.showModal();
};

async function connect(wallet: SigningWallet | undefined) {
  try {
    invalidateReview();
    if (!wallet) throw new Error("Install a Wallet Standard wallet with signTransaction support.");
    const { accounts } = await wallet.features["standard:connect"].connect();
    const account = accounts.find(
      (account) =>
        account.features.includes("solana:signTransaction") &&
        (control?.network === "localnet" || account.chains.includes(network().chain)),
    );
    if (!account) throw new Error("This wallet has no compatible Solana signing account.");
    unsubscribe?.();
    connected = { wallet, account };
    unsubscribe = wallet.features["standard:events"].on("change", disconnected);
    const logo = node("img", "", "wallet-icon");
    logo.src = wallet.icon;
    logo.alt = "";
    walletStatus.replaceChildren(logo, `${account.address.slice(0, 4)}…${account.address.slice(-4)}`);
    walletStatus.title = `${wallet.name}: ${account.address}`;
    disconnectButton.hidden = false;
    refreshWallets();
    document.querySelector("#app")!.scrollIntoView();
    bench.hidden = true;
    tryPanel.dataset.state = "connected";
    draw();
    if (control?.testBench)
      document.querySelector("#try-status")!.textContent = "Test tokens arrive, then you sign one approval.";
    const live = scenarios.findIndex((scenario) => scenario.live);
    if (live >= 0) select.value = String(live);
    if (control && (await scanWallet())) return;
    if (live >= 0) selectScenario();
    else {
      input.value = account.address;
      setMode("scan");
    }
  } catch (error) {
    status(error instanceof Error ? error.message : "Wallet connection failed.", true);
  }
}

// Tells the wallet which cluster the bytes belong to. Without it a wallet assumes its own
// network, cannot simulate a test-chain transaction there and may rewrite the blockhash.
function chainFor(wallet: SigningWallet) {
  const { chain } = network();
  return wallet.chains.includes(chain) ? { chain } : {};
}

// Extensions simulate on the network they are set to. On the test chain that check fails
// inside the wallet unless it is pointed at the same chain, so the visitor is told beforehand.
function walletHint(): string {
  if (control?.network !== "localnet" || !connected || connected.wallet.name === "Velon test wallet")
    return "";
  return `${connected.wallet.name} checks transactions against its own network. Set it to Localnet first (Phantom: Settings, Developer Settings, Testnet Mode, Solana Localnet), or it will warn that simulation failed.`;
}

const tryPanel = document.querySelector<HTMLElement>("#try")!;
const grantButton = document.querySelector<HTMLButtonElement>("#grant")!;
document.querySelector<HTMLButtonElement>("#use-test-wallet")!.onclick = async () =>
  connect(await testWallet());
document.querySelector<HTMLButtonElement>("#connect-own")!.onclick = () => connectButton.click();
// Comparing two recorded states only exists for recorded examples.
const compareTab = (shown: boolean) => (document.querySelector<HTMLElement>("#diff-tab")!.hidden = !shown);

const WSOL = "So11111111111111111111111111111111111111112";
function units(amount: bigint, scale: number): string {
  // A nonzero amount never reads as zero.
  if (amount > 0n && amount * 10_000n < 10n ** BigInt(scale)) return "<0.0001";
  const whole = (amount / 10n ** BigInt(scale)).toLocaleString("en-US");
  const fraction = (amount % 10n ** BigInt(scale))
    .toString()
    .padStart(scale, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// What the wallet holds, as its RPC reports it, and whether any other key can spend each token.
// Display only: the permissions below are the ones Velon observed and can act on.
// Amounts arrive as decimal strings so u64 values survive JSON.
async function holdingsPanel(
  owner: string,
  signal: AbortSignal,
  prefetched?: ObjectValue,
): Promise<HTMLElement | undefined> {
  const yours = owner === connected?.account.address;
  let wallet = prefetched;
  if (!wallet) {
    const response = await call("/api/live/wallet", {
      method: "POST",
      headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
      signal,
    }).catch(() => undefined);
    if (!response?.ok) return undefined;
    wallet = object(readJson(await response.text()));
  }
  if (wallet.kind !== "wallet") return undefined;
  const all = array(wallet.tokens).map(object);
  const shown = all
    .filter((entry) => entry.delegate !== null || text(entry.amount) !== "0")
    .sort(
      (a, b) =>
        Number(b.delegate !== null) - Number(a.delegate !== null) ||
        Number(Boolean(TOKENS[text(b.mint)])) - Number(Boolean(TOKENS[text(a.mint)])),
    );
  const panel = node("section", "", "holdings");
  const head = node("div", "", "holdings-head");
  const link = labelled(node("a", "Explorer", "link-button"), "external");
  link.href = explorer("address", owner);
  link.target = "_blank";
  link.rel = "noreferrer";
  head.append(node("h2", yours ? "Your wallet" : "This wallet"), node("span", short(owner), "mono"), link);
  const list = node("ul", "", "holdings-list");
  const row = (logo: Element, name: string, detail: string, amount: string, status: HTMLElement) => {
    const item = node("li", "", "holding");
    const label = node("div", "", "holding-name");
    label.append(node("strong", name), node("span", detail, "muted"));
    item.append(logo, label, node("span", amount, "holding-amount"), status);
    return item;
  };
  const safe = () =>
    node("span", yours ? "Only you can move it" : "Only the owner can move it", "holding-status ok");
  // Names are display only; a lookup that fails leaves the addresses in place.
  await nameTokens(
    shown.map((entry) => text(entry.mint)),
    signal,
  ).catch(() => undefined);
  list.append(row(tokenLogo(WSOL), "SOL", "Native balance", units(BigInt(text(wallet.lamports)), 9), safe()));
  for (const entry of shown) {
    const mint = text(entry.mint);
    const scale = Number(entry.decimals);
    let status = safe();
    if (entry.delegate !== null) {
      const delegated = BigInt(text(entry.delegated));
      const limit = delegated === UNLIMITED ? "with no limit" : `up to ${units(delegated, scale)}`;
      status = node("span", `${short(text(entry.delegate))} can spend ${limit}`, "holding-status risk");
    }
    const label = tokenName(mint);
    const detail = `${label.name ?? "Unlisted token"}${label.verified || !label.name ? "" : " · unverified"}${entry.program === "spl-token-2022" ? " · Token-2022" : ""}`;
    list.append(
      row(
        tokenLogo(mint),
        label.symbol ?? label.name ?? `Token ${short(mint)}`,
        detail,
        units(BigInt(text(entry.amount)), scale),
        status,
      ),
    );
  }
  panel.append(head, list);
  // A wallet with many tokens folds to one line; the approvals below are what needs attention.
  if (shown.length > 4) {
    const delegated = shown.filter((entry) => entry.delegate !== null).length;
    const sol = units(BigInt(text(wallet.lamports)), 9);
    const summary = node(
      "p",
      `${sol} SOL · ${shown.length} tokens${delegated ? ` · ${delegated} with a delegate` : ""}`,
      "holdings-summary",
    );
    const toggle = node("button", "Show tokens", "link-button");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => {
      const open = panel.classList.toggle("unfolded");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide tokens" : "Show tokens";
    };
    head.after(summary);
    summary.append(toggle);
    panel.classList.add("folded");
  }
  const hidden = Number(wallet.omitted ?? 0) + Number(wallet.skipped ?? 0);
  if (hidden)
    panel.append(
      node("p", `${hidden} more token account${hidden === 1 ? "" : "s"} could not be shown.`, "muted"),
    );
  const empty = all.length - shown.length;
  if (empty)
    panel.append(
      node("p", `${empty} empty token account${empty === 1 ? "" : "s"} with no delegate not shown.`, "muted"),
    );
  return panel;
}

// Every permission across the connected wallet's token accounts.
// Each account is observed through the runtime; the RPC's index only says where to look.
// Any wallet can be read; only the connected owner can sign a revoke for it.
async function scanWallet(
  owner = connected?.account.address,
  prefetched?: ObjectValue,
): Promise<boolean | undefined> {
  if (!owner) return false;
  const yours = owner === connected?.account.address;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const wallet = holdingsPanel(owner, signal, prefetched);
  // Display only: a panel that cannot be read must not surface as an unhandled rejection.
  void wallet.catch(() => undefined);
  // Only a ledger we started can be enumerated; public clusters answer per owner.
  const listed =
    control?.network === "localnet"
      ? await call("/api/live/spl/delegated", { signal })
      : await call("/api/live/spl/owned", {
          method: "POST",
          headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
          body: JSON.stringify({ owner }),
          signal,
        });
  if (!listed.ok) {
    const retry = node("button", "Try again", "link-button");
    retry.type = "button";
    retry.onclick = () => void scanWallet(owner);
    const message = node(
      "p",
      listed.status === 429
        ? "Too many requests right now. Wait a minute, then try again. "
        : "The wallet's token accounts could not be read. ",
      "error",
    );
    message.append(retry);
    notice.replaceChildren(message);
    return false;
  }
  mode = "scan";
  diff.hidden = true;
  receipts.hidden = true;
  results.hidden = false;
  const reported = array(readJson(await listed.text()))
    .map(object)
    .filter((entry) => entry.owner === owner);
  for (const entry of reported)
    if (typeof entry.decimals === "number") decimals.set(text(entry.source), entry.decimals);
  // Token-2022 delegations are real, but this runtime cannot verify or revoke them yet.
  // Every delegated account, SPL Token or Token-2022, is observed through the runtime.
  const owned = reported;
  // Accounts the runtime observed but could not model exactly, with the reason it gave.
  const unsupported: [ObjectValue, string][] = [];
  const content = document.createDocumentFragment();
  const cards: HTMLElement[] = [];
  let last: ObjectValue | undefined;
  let unread = 0;
  // While the chain is read, every account is listed at once and marked as its batch returns.
  const checking = node("ol", "", "checking");
  const rows = owned.map((entry) => {
    const row = node("li", "", "pending");
    const delegate = text(entry.delegate);
    row.append(
      node("span", "", "checking-token"),
      node("span", `${delegate.slice(0, 4)}…${delegate.slice(-4)}`, "checking-who"),
      node("span", text(entry.amount) === String(UNLIMITED) ? "unlimited" : "limited", "checking-amount"),
      node("span", "Checking…", "checking-state"),
    );
    checking.append(row);
    return row;
  });
  const label = () =>
    owned.forEach((entry, index) => {
      const mint = text(entry.mint);
      const token = tokenName(mint);
      rows[index]!.querySelector(".checking-token")!.textContent =
        token.symbol ?? token.name ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    });
  label();
  const heading = node("p", "", "approvals-summary");
  if (owned.length) results.replaceChildren(heading, checking);
  const mark = (index: number, view: [ObjectValue, string] | undefined) => {
    const projection = view ? object(view[0].projection) : undefined;
    const [state, kind] = !projection
      ? ["Couldn't read", "unread"]
      : projection.status !== "compiled"
        ? ["Read-only", "reported"]
        : array(projection.authorizations ?? []).length
          ? ["Verified", "verified"]
          : ["No permission", "clear"];
    rows[index]!.className = kind;
    rows[index]!.querySelector(".checking-state")!.textContent = state;
  };
  // Names arrive while the accounts are checked; the list is relabelled when they do.
  const naming = nameTokens(
    owned.map((entry) => text(entry.mint)),
    signal,
  )
    .then(label)
    .catch(() => undefined);
  try {
    // A few accounts are observed at once; cards keep the order the RPC listed them in.
    // Public RPCs rate limit, so an account is retried before it is reported as unread.
    const views: ([ObjectValue, string] | undefined)[] = new Array(owned.length);
    // Accounts are observed in batches: the runtime starts and checks the program once per batch.
    const observe = async (sources: string[]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const observed = await call("/api/live/spl/observe", {
            method: "POST",
            headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
            body: JSON.stringify({ sources }),
            signal,
          });
          const scope = text(object(await result(observed)).scope_id);
          if (sources.length > 1) batchScopes.add(scope);
          return await Promise.all(
            sources.map(
              async (source) =>
                [object(await get(`scopes/${scope}/effective/${source}`, signal)), scope] as [
                  ObjectValue,
                  string,
                ],
            ),
          );
        } catch (error) {
          if (signal.aborted || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
        }
      }
    };
    // A batch holds one token program's accounts: a program Velon cannot verify makes the whole
    // observation read-only, so it must not take the other program's accounts with it.
    const batches: number[][] = [];
    for (const program of new Set(owned.map((entry) => String(entry.program)))) {
      const indexes = [...owned.keys()].filter((index) => String(owned[index]!.program) === program);
      for (let start = 0; start < indexes.length; start += observeBatch)
        batches.push(indexes.slice(start, start + observeBatch));
    }
    let done = 0;
    const progress = () => {
      status(
        `Checking ${done} of ${owned.length} token account${owned.length === 1 ? "" : "s"} against the chain…`,
      );
      const verified = checking.querySelectorAll(".verified").length;
      const reported = checking.querySelectorAll(".reported").length;
      heading.textContent = `Checked ${done} of ${owned.length}${verified ? ` · ${verified} verified` : ""}${reported ? ` · ${reported} read-only` : ""}`;
    };
    if (owned.length) progress();
    // A batch that still fails after its retries is split in half, down to single accounts, so a
    // provider's rate limit costs time rather than the rows of a whole batch.
    const check = async (indexes: number[]): Promise<void> => {
      const results = await observe(indexes.map((index) => text(owned[index]!.source))).catch(() => {
        if (signal.aborted) throw signal.reason;
        return undefined;
      });
      if (!results && indexes.length > 1) {
        const half = Math.ceil(indexes.length / 2);
        await check(indexes.slice(0, half));
        return check(indexes.slice(half));
      }
      indexes.forEach((index, offset) => {
        views[index] = results?.[offset];
        mark(index, views[index]);
      });
      done += indexes.length;
      if (!signal.aborted) progress();
    };
    // One batch at a time: each is a single runtime run, and a provider rate limits bursts.
    for (const batch of batches) await check(batch);
    unread = views.filter((view) => !view).length;
    views.forEach((view, index) => {
      const projection = view ? object(view[0].projection) : undefined;
      if (projection && projection.status !== "compiled")
        unsupported.push([owned[index]!, text(projection.reason ?? projection.status)]);
    });
    await naming;
    for (const [view, scope] of views.filter((view) => view !== undefined)) {
      last = view;
      for (const item of array(object(view.projection).authorizations ?? []))
        cards.push(
          card(authorization(object(item).authorization), view, text(object(item).availability), scope),
        );
    }
  } catch (error) {
    if (!signal.aborted)
      status(error instanceof Error ? error.message : "Your wallet could not be read.", true);
    return false;
  }
  if (signal.aborted) return false;
  badge(network().label);
  // The panel is display only; if it cannot be read, the permissions still are.
  const holdings = await wallet.catch(() => undefined);
  if (signal.aborted) return false;
  if (holdings) content.append(holdings);
  content.append(node("h2", yours ? "Who can act on your wallet" : "Who can act on this wallet"));
  if (control?.network === "mainnet")
    content.append(
      node(
        "p",
        "Mainnet: a revoke is a real transaction and costs a small fee in SOL. Velon only asks you to sign after it has executed the revoke itself against the account's finalized state.",
        "notice",
      ),
    );
  if (last) content.append(metadata(last));
  // In a wallet, each permission is one row; its explanation and evidence open under Details.
  for (const row of cards) row.classList.add("compact");
  if (cards.length) {
    const unlimited = cards.filter((row) => row.dataset.amount === "∞").length;
    content.append(
      node(
        "p",
        `${cards.length} approval${cards.length === 1 ? "" : "s"} on this wallet${unlimited ? ` · ${unlimited} unlimited` : ""}`,
        "approvals-summary",
      ),
    );
    cards.sort((a, b) => Number(b.dataset.amount === "∞") - Number(a.dataset.amount === "∞"));
    const batch = cards.filter((row) => row.dataset.amount === "∞" && revocable.has(row));
    if (batch.length > 1) {
      const all = labelled(node("button", `Review all ${batch.length} unlimited`, "action-button"), "revoke");
      all.type = "button";
      all.onclick = () => {
        const [first, ...rest] = batch.map((row) => revocable.get(row)!);
        queue = rest;
        first!();
      };
      content.append(all);
    }
  }
  if (unread)
    content.append(
      node(
        "p",
        `${unread} of ${owned.length} token accounts could not be read; the RPC may be rate limiting. Reload to try them again.`,
        "notice",
      ),
    );
  if (cards.length) content.append(...cards);
  else
    content.append(
      node(
        "p",
        control?.testBench
          ? "No classic SPL token delegates found on this wallet. Get a test permission above, then revoke it here."
          : "No SPL Token delegates found on this wallet. Other kinds of permission were not checked.",
        "empty",
      ),
    );
  for (const [entry, reason] of unsupported) {
    const row = node("article", "", "permission reported");
    const header = node("div", "", "permission-header");
    header.append(
      node("span", entry.program === "spl-token-2022" ? "Token-2022" : "SPL Token", "badge"),
      node("span", "Reported, not verified", "availability"),
    );
    const link = labelled(node("a", "Open on Solana Explorer", "link-button"), "external");
    link.href = explorer("address", text(entry.source));
    link.target = "_blank";
    link.rel = "noreferrer";
    const actions = node("div", "", "permission-actions");
    actions.append(link);
    const facts = node("dl");
    facts.append(
      address("Who", text(entry.delegate)),
      address("From", text(entry.source)),
      address("Token", text(entry.mint)),
    );
    row.append(
      header,
      node(
        "h3",
        text(entry.amount) === String(UNLIMITED)
          ? "Spend every token, with no limit"
          : `Spend up to ${text(entry.ui)} tokens`,
      ),
      node("p", UNVERIFIED[reason] ?? UNVERIFIED.default!, "explain"),
      facts,
      actions,
    );
    content.append(row);
  }
  compareTab(false);
  results.replaceChildren(content);
  notice.replaceChildren();
  reload = () => scanWallet(owner);
  guide(cards.length ? 3 : 2);
  return true;
}

// Test bench: the visitor's own wallet receives a token account, then signs an ordinary
// SPL approval. That approval is test setup; only the revoke goes through Velon's checks.
grantButton.onclick = async () => {
  if (!connected || !control) return;
  const session = connected;
  const say = (message: string) => (document.querySelector("#try-status")!.textContent = message);
  tryPanel.dataset.busy = "";
  grantButton.disabled = true;
  try {
    say("Preparing a test token account…");
    const funded = await call("/api/test/account", {
      method: "POST",
      headers: { "X-Velon-Action": "test", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: session.account.address }),
    });
    const account = object(await result(funded));
    const source = toAddress(text(account.source));
    const rpc = createSolanaRpc(control.rpcUrl, { headers: rpcHeaders(control.rpcUrl) });
    for (let attempt = 0; ; attempt++) {
      const held = await rpc
        .getTokenAccountBalance(source, { commitment: "confirmed" })
        .send({ abortSignal: AbortSignal.timeout(15000) })
        .catch(() => null);
      if (held && held.value.amount !== "0") break;
      if (attempt === 60) throw new Error("The test account did not arrive. Try again.");
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    const allowance = 1n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 500);
    const data = new Uint8Array(9);
    data[0] = 4;
    new DataView(data.buffer).setBigUint64(1, allowance, true);
    const owner = toAddress(session.account.address);
    const { value: latest } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(15000) });
    const message = appendTransactionMessageInstruction(
      {
        programAddress: toAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        accounts: [
          { address: source, role: 1 },
          { address: toAddress(text(account.delegate)), role: 0 },
          { address: owner, role: 2 },
        ],
        data,
      },
      setTransactionMessageLifetimeUsingBlockhash(
        latest,
        setTransactionMessageFeePayer(owner, createTransactionMessage({ version: "legacy" })),
      ),
    );
    say(`Sign to let a test key spend ${allowance} tokens. ${walletHint()}`);
    const [signed] = await session.wallet.features["solana:signTransaction"].signTransaction({
      account: session.account,
      transaction: new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))),
      ...chainFor(session.wallet),
    });
    await rpc
      .sendTransaction(
        getBase64EncodedWireTransaction(getTransactionDecoder().decode(signed!.signedTransaction)),
        {
          encoding: "base64",
          preflightCommitment: "confirmed",
        },
      )
      .send({ abortSignal: AbortSignal.timeout(30000) });
    say("Granted. Waiting for the chain to finalize it…");
    // Live means the finalized chain reports this delegate with this allowance, not that time passed.
    let finalized = false;
    for (let attempt = 0; attempt < 60 && connected === session && !finalized; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      try {
        const listed = await call("/api/live/spl/delegated", {}, 10000);
        finalized =
          listed.ok &&
          array(readJson(await listed.text()))
            .map(object)
            .some(
              (entry) =>
                entry.source === source &&
                entry.delegate === account.delegate &&
                entry.amount === String(allowance),
            );
      } catch {
        /* A slow read is retried; only the chain's answer ends the wait. */
      }
    }
    if (!finalized)
      throw new Error(
        "The approval was sent but is not finalized yet, so it is not shown as live. Try again shortly.",
      );
    say(
      (await scanWallet())
        ? "Your permission is live. Revoke it below."
        : "Your permission is live on chain, but the wallet could not be read. Scan again.",
    );
  } catch (error) {
    say(error instanceof Error ? error.message : "The test permission failed.");
  } finally {
    grantButton.disabled = false;
    delete tryPanel.dataset.busy;
  }
};

// Receipts of verified revokes, kept in this browser and replayable from the journal.
type Receipt = { id: string; signature: string; slot: string; source: string; network: string; at: string };
const receipts = document.querySelector<HTMLElement>("#receipts")!;
const kept = (): Receipt[] => {
  try {
    return JSON.parse(localStorage.getItem("velon:receipts") ?? "[]");
  } catch {
    return [];
  }
};
function remember(receipt: Receipt) {
  localStorage.setItem("velon:receipts", JSON.stringify([receipt, ...kept()].slice(0, 20)));
}
document.querySelector<HTMLButtonElement>("#receipts-tab")!.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  results.hidden = true;
  diff.hidden = true;
  receipts.hidden = false;
  for (const tab of document.querySelectorAll(".tabs button")) tab.classList.remove("selected");
  document.querySelector("#receipts-tab")!.classList.add("selected");
  const list = kept();
  receipts.replaceChildren(node("h2", "Verified revokes"));
  if (!list.length)
    receipts.append(
      node("p", "A receipt appears here each time a revoke is verified in this browser.", "empty"),
    );
  for (const receipt of list) {
    const row = node("article", "", "permission");
    const facts = node("dl");
    facts.append(
      field("Account", receipt.source),
      field("Finalized slot", receipt.slot),
      field("Signature", receipt.signature),
      field("Verification", receipt.id),
    );
    const replay = node("button", "Replay proof", "action-button");
    const outcome = node("span", "", "muted");
    replay.onclick = async () => {
      replay.disabled = true;
      outcome.textContent = "Replaying from the journal…";
      try {
        const response = await call(`/api/verifications/revoke/${receipt.id}`);
        if (!response.ok) throw new Error();
        const body = await response.text();
        outcome.textContent = "Replayed without the chain: the revoke and the cleared state still check out.";
        const save = node("a", "Download evidence", "link-button");
        save.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
        save.download = `velon-revoke-${receipt.id.slice(0, 12)}.json`;
        actions.append(save);
      } catch {
        outcome.textContent = "This receipt is not in the journal the server is using now.";
      } finally {
        replay.disabled = false;
      }
    };
    const actions = node("div", "", "permission-actions");
    actions.append(replay, outcome);
    row.append(
      node(
        "h3",
        `Revoked on ${{ mainnet: "mainnet", devnet: "devnet" }[receipt.network] ?? "the test chain"}`,
      ),
      node("p", new Date(receipt.at).toLocaleString(), "remaining"),
      facts,
      actions,
    );
    receipts.append(row);
  }
};

const STATES: Record<ActionState, string> = {
  PREPARING: "Preparing",
  SIMULATED: "Review",
  AWAITING_SIGNATURE: "Waiting for wallet",
  SUBMITTING: "Submitting",
  FINALIZING: "Finalizing",
  VERIFIED: "Revoked",
  FAILED: "Not submitted",
};
// Once the helper reaches for sendTransaction, only finalized verification can settle the outcome.
let sendRequested = false;
// Whatever view is on screen knows how to load itself again after a revoke.
let reload: () => Promise<boolean | undefined> = () => scan();
let progress = 0;

// The verified mark draws itself once the chain has been read again.
function seal(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("class", "seal");
  svg.innerHTML = '<circle cx="24" cy="24" r="21" /><path d="M14 24.5 21.5 32 35 17" />';
  return svg;
}

// The diagram is the console's main view: the wallet in the centre, one node per permission.
// It is drawn from the cards on screen, so it can never show something the list does not.
const stage = document.querySelector<HTMLElement>("#stage")!;
const orbit = document.querySelector<SVGSVGElement>("#orbit")!;
const SPOTS = [
  [170, 90],
  [830, 90],
  [170, 290],
  [830, 290],
  [390, 40],
  [610, 340],
] as const;
function draw() {
  const cards = [...results.querySelectorAll<HTMLElement>(".permission[data-id]")].slice(0, SPOTS.length);
  const parts: string[] = [];
  for (const [index, item] of cards.entries()) {
    const [x, y] =
      cards.length === 1
        ? [190, 190]
        : cards.length === 2
          ? [
              [170, 190],
              [830, 190],
            ][index]!
          : SPOTS[index]!;
    const bend = x < 500 ? x + 170 : x - 170;
    const path = `M${x} ${y}C${bend} ${y} ${bend} 190 500 190`;
    const kind = ["spl-token", "token-2022"].includes(item.dataset.system ?? "") ? "spl" : "sub";
    const target = item.dataset.id === stage.dataset.target ? " target" : "";
    parts.push(
      `<g class="branch ${kind}${target}" data-index="${index}" tabindex="0" role="button">` +
        `<path class="link" d="${path}"/>` +
        `<circle class="dot" r="5"><animateMotion dur="${2.2 + index * 0.3}s" repeatCount="indefinite" path="${path}"/></circle>` +
        `<circle class="node" cx="${x}" cy="${y}" r="34"/>` +
        `<text class="amount" x="${x}" y="${y + 5}" text-anchor="middle">${item.dataset.amount || "·"}</text>` +
        `<text x="${x}" y="${y + 58}" text-anchor="middle">${item.dataset.who}</text></g>`,
    );
  }
  const owner = connected ? short(connected.account.address) : "";
  orbit.innerHTML =
    parts.join("") +
    `<rect class="wallet" x="440" y="130" width="120" height="120" rx="34"/>` +
    `<path class="tick" d="M472 184 493 216 530 166"/><text class="owner" x="500" y="290" text-anchor="middle">${owner}</text>`;
  stage.dataset.count = String(cards.length);
  for (const branch of orbit.querySelectorAll<SVGGElement>(".branch")) {
    const open = () => {
      const item = cards[Number(branch.dataset.index)]!;
      item.scrollIntoView({ block: "center", behavior: "smooth" });
      item.classList.add("picked");
      setTimeout(() => item.classList.remove("picked"), 1600);
    };
    branch.onclick = open;
    branch.onkeydown = (event) => event.key === "Enter" && open();
  }
}
new MutationObserver(draw).observe(results, { childList: true });
const browse = document.querySelector<HTMLButtonElement>("#browse")!;
const rail = document.querySelector<HTMLElement>(".rail-panel")!;
// On a live console the list is a drawer; while it is closed it is off screen, so it is
// also taken out of the tab order and away from the pointer.
function setBrowse(open: boolean) {
  document.body.classList.toggle("browsing", open);
  browse.setAttribute("aria-expanded", String(open));
  rail.inert = document.body.classList.contains("is-live") && !open;
}
browse.onclick = () => setBrowse(!document.body.classList.contains("browsing"));
addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && document.body.classList.contains("browsing")) {
    setBrowse(false);
    browse.focus();
  }
});
// Choosing an account closes the list so the result is not covered.
function closeBrowse() {
  setBrowse(false);
}

// Marks how far the visitor is in the three-step guide.
function guide(step: number) {
  for (const [index, item] of [...document.querySelectorAll<HTMLElement>(".guide li")].entries()) {
    item.classList.toggle("done", index + 1 < step);
    item.classList.toggle("now", index + 1 === step);
  }
}

function setAction(state: ActionState, message: string) {
  actionState = state;
  stage.dataset.state = state.toLowerCase();
  actionResult.hidden = false;
  const title = state === "FAILED" && sendRequested ? "Unconfirmed" : STATES[state];
  // Progress through the revoke; a failure leaves the bar where it stopped.
  const reached = [
    "PREPARING",
    "SIMULATED",
    "AWAITING_SIGNATURE",
    "SUBMITTING",
    "FINALIZING",
    "VERIFIED",
  ].indexOf(state);
  if (reached >= 0) progress = reached;
  const steps = node("ol", "", "steps");
  steps.dataset.state = state === "FAILED" ? "failed" : state === "VERIFIED" ? "done" : "busy";
  for (const [index, label] of ["Observe", "Review", "Sign", "Submit", "Finalize", "Verified"].entries()) {
    const step = node("li", label);
    if (index < progress || state === "VERIFIED") step.className = "done";
    else if (index === progress) step.className = "now";
    steps.append(step);
  }
  actionResult.replaceChildren(steps, node("h2", title), node("p", message));
  if (state === "VERIFIED") {
    guide(4);
    if (connected && control?.testBench)
      document.querySelector("#try-status")!.textContent =
        "Revoked and verified. Run it again, or replay the proof under Receipts.";
    actionResult.prepend(seal());
  }
  const busy = ["PREPARING", "AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(state);
  connectButton.disabled = busy;
  select.disabled = busy;
  scanButton.disabled = busy;
  document
    .querySelectorAll<HTMLButtonElement>(".action-button")
    .forEach((button) => (button.disabled = busy));
}

// Scopes that cover a batch of accounts. A revoke is reviewed against one account's own
// observation, so preparing one from a batch observes that account again first.
const batchScopes = new Set<string>();
// The most accounts the server accepts in one observation (observeBatch in server.ts).
const observeBatch = 25;

async function prepare(scanned: ObjectValue, scope: string) {
  if (
    !control ||
    !connected ||
    (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState))
  )
    return;
  actionAbort?.abort();
  actionAbort = new AbortController();
  const signal = actionAbort.signal;
  const session = connected;
  const config = control;
  const source = text(object(scanned.resource).id);
  const subscription = text(object(scanned.native_context).protocol) === "subscriptions";
  const key = revokeKey(scanned);
  stage.dataset.target = text(scanned.id);
  draw();
  sendRequested = false;
  try {
    setAction("PREPARING", "Observing the current finalized state...");
    if (!key) throw new Error("This permission has no account Velon can revoke it by.");
    if (batchScopes.has(scope)) {
      const observed = await call("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source: key }),
        signal,
      });
      scope = text(object(await result(observed)).scope_id);
    }
    const response = await action(`scopes/${scope}/actions/revoke/${key}`, signal);
    if (response.status === 409)
      throw new Error("The finalized state moved during simulation. Nothing was signed; try again.");
    const simulated = await result(response);
    // The runtime simulated a fresh observation; review that state, not the earlier scan.
    const view = object(await get(`scopes/${scope}/effective/${session.account.address}`, signal));
    signal.throwIfAborted();
    const grant = array(object(view.projection).authorizations ?? [])
      .map((entry) => authorization(object(entry).authorization))
      .find((current) => current.id === scanned.id);
    if (!grant || writeJson(semantic(grant)) !== writeJson(semantic(scanned)))
      throw new Error("This permission changed after the scan. Scan and review again.");
    const stateVersion = text(view.state_version);
    const path = `snapshots/${stateVersion}/actions/revoke/${key}/verify`;
    const prepared = reviewRevoke(simulated, view, grant, session.account.address, config);
    setAction("SIMULATED", "Review what your wallet will sign.");
    const title = node("h2", "You are removing");
    title.tabIndex = -1;
    review.replaceChildren(
      title,
      node(
        "p",
        "Your wallet will sign the reviewed revoke transaction. Check the network fee in your wallet before confirming.",
        "muted",
      ),
    );
    if (walletHint()) review.append(node("p", walletHint(), "notice"));
    if (config.network === "mainnet")
      review.append(
        node(
          "p",
          "This is mainnet. The fee is about 0.000015 SOL: the 5,000-lamport base fee plus a fixed 10,000-lamport priority fee. Nothing else leaves your wallet.",
          "notice",
        ),
      );
    const facts = node("dl", "", "facts");
    facts.append(
      field("Who", principalLabel(grant.principal)),
      field("Can", "Spend"),
      address("From", source),
      field("Limit", allowance(source, integer(object(grant.usage).remaining), mintOf(grant))),
      field("Native system", system(grant)),
      field("Network", network().label),
      field(
        "Executed by Velon",
        subscription
          ? "Subscription delegation closed, rent returned to you; the token approval to the subscription authority remains"
          : "Delegate and allowance cleared, nothing else changed",
      ),
      field("Deployment", "Verified"),
    );
    const confirm = node("button", "Confirm in wallet", "action-button");
    const cancel = node("button", "Cancel", "link-button");
    cancel.onclick = () => {
      invalidateReview();
      actionResult.hidden = true;
    };
    review.append(facts, raw("View technical evidence", prepared.evidence), confirm, cancel);
    review.showModal();
    title.focus({ preventScroll: true });
    review.scrollTop = 0;
    confirm.onclick = async () => {
      confirm.disabled = true;
      // Keep the diagram in view while it follows the transaction.
      scrollTo({ top: 0, behavior: "smooth" });
      let submittedSignature: string | undefined;
      try {
        const latest = object(await get(`scopes/${scope}`, signal));
        if (latest.id !== stateVersion)
          throw new Error("Permission evidence changed. Scan and review again.");
        signal.throwIfAborted();
        if (connected !== session) throw new Error("Wallet changed. Review again.");
        review.close();
        const sent = await signAndSubmitReviewedTransaction(
          new Proxy(createSolanaRpc(config.rpcUrl, { headers: rpcHeaders(config.rpcUrl) }), {
            get(rpc, method, receiver) {
              if (method === "sendTransaction") sendRequested = true;
              return Reflect.get(rpc, method, receiver);
            },
          }),
          prepared.bytes,
          async (bytes) => {
            signal.throwIfAborted();
            if (connected !== session) throw new Error("Wallet changed. Review again.");
            setAction("AWAITING_SIGNATURE", "Confirm the reviewed revoke in your wallet.");
            const signed = await session.wallet.features["solana:signTransaction"].signTransaction({
              account: session.account,
              transaction: bytes,
              ...chainFor(session.wallet),
            });
            signal.throwIfAborted();
            if (connected !== session || signed.length !== 1)
              throw new Error("Wallet signing response changed.");
            const current = object(await get(`scopes/${scope}`, signal));
            if (current.id !== stateVersion)
              throw new Error("Permission evidence changed while signing. Review again.");
            setAction("SUBMITTING", "Submitting the exact reviewed transaction...");
            return signed[0]!.signedTransaction;
          },
          { ...prepared, abortSignal: signal },
        );
        submittedSignature = sent.signature;
        setAction(
          "FINALIZING",
          sent.status === "unknown"
            ? "Submission response is uncertain. Checking finalization without resending."
            : "Waiting for finalized native verification...",
        );
        actionResult.append(link("Transaction", sent.signature));
        for (let attempt = 0; attempt < 60; attempt++) {
          signal.throwIfAborted();
          const response = await action(path, signal, sent.signedTransaction);
          if (response.status === 404) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          const verification = await result(response);
          const current = await get(`scopes/${scope}`, signal);
          const checked = verifiedRevoke(
            verification,
            current,
            stateVersion,
            text(grant.id),
            sent.signedTransaction,
          );
          // The revoked card leaves the page before the fresh state replaces it.
          const gone = [...results.querySelectorAll<HTMLElement>(".permission")].find(
            (item) => item.dataset.id === grant.id,
          );
          gone?.classList.add("leaving");
          stage.dataset.state = "cut";
          if (gone) await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          if (!(await reload()))
            throw new Error("Verification was retained, but current permissions could not be reloaded.");
          remember({
            id: checked.id,
            signature: sent.signature,
            slot: String(checked.slot),
            source: key,
            network: config.network,
            at: new Date().toISOString(),
          });
          signal.throwIfAborted();
          setAction("VERIFIED", `Revoked and verified on ${network().label.toLowerCase()}.`);
          actionResult.append(
            link("Transaction", sent.signature),
            field("Finalized slot", String(checked.slot)),
            field("Verification ID", checked.id),
          );
          // The next queued revoke opens only when the visitor asks for it.
          if (queue.length) {
            const next = labelled(
              node("button", `Review next · ${queue.length} left`, "action-button"),
              "revoke",
            );
            next.type = "button";
            next.onclick = () => queue.shift()?.();
            actionResult.append(next);
          }
          return;
        }
        throw new Error(
          "Finalization is still unconfirmed. Keep the transaction signature; do not assume either outcome or submit again.",
        );
      } catch (error) {
        review.close();

        const reason = error instanceof Error ? error.message : "Revoke verification failed.";
        setAction(
          "FAILED",
          /message|changed/i.test(reason) && !sendRequested
            ? `Your wallet altered the transaction before signing, so Velon did not send it. Set the wallet to ${network().label} and try again.`
            : reason,
        );
        if (submittedSignature) actionResult.append(field("Transaction signature", submittedSignature));
      }
    };
  } catch (error) {
    if (!signal.aborted) setAction("FAILED", error instanceof Error ? error.message : "Simulation failed.");
  }
}
review.addEventListener("cancel", invalidateReview);

// Mainnet and devnet consoles are for real wallets: a lookup first, no recorded fixtures.
function publicMode() {
  if (!control || control.testBench) return;
  lookup.hidden = false;
  document.querySelector<HTMLElement>("#recorded")!.hidden = true;
  document.body.classList.add("public");
}

// The first screen explains the three ideas the rest of the console relies on.
function lesson() {
  compareTab(false);
  results.replaceChildren();
  // On a public cluster the visitor's own wallet is the whole point; ask for it first.
  if (control && !control.testBench && !connected) {
    const start = labelled(node("button", "Connect your wallet", "action-button"), "wallet");
    start.onclick = () => connectButton.click();
    const panel = node("section", "", "start");
    panel.append(
      node("h2", "See who can spend your tokens"),
      node(
        "p",
        `Connect a wallet to list every SPL Token delegate on its accounts on ${network().label.toLowerCase()}. Connecting signs nothing. You choose what to revoke, and you approve every transaction in your wallet.`,
        "muted",
      ),
      start,
    );
    results.append(panel);
  }
  badge(network().label);
}

// A signature the visitor can open on Solana Explorer.
function link(title: string, signature: string): HTMLElement {
  const row = field(title, "");
  const anchor = labelled(node("a", short(signature)), "external");
  anchor.href = explorer("tx", signature);
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  row.querySelector("dd")!.append(anchor);
  return row;
}

// A row from another cluster is shown as its RPC reports it. This console holds evidence only
// for its own cluster, so nothing here is presented as a verified permission or revocable.
let publicNet: "devnet" | "mainnet" = "devnet";
function showMainnet(entry: ObjectValue) {
  const net = publicNet;
  closeBrowse();
  const unlimited = text(entry.amount) === "18446744073709551615";
  const row = node("article", "", "permission reported");
  const header = node("div", "", "permission-header");
  header.append(
    node("span", `Solana ${net}`, "badge"),
    node("span", "Reported, not verified", "availability"),
  );
  const facts = node("dl");
  facts.append(
    address("Who", text(entry.delegate)),
    address("From", text(entry.source)),
    field("Wallet", text(entry.owner)),
    address("Token", text(entry.mint)),
  );
  const link = labelled(node("a", "Open on Solana Explorer", "link-button"), "external");
  link.href = `https://explorer.solana.com/address/${text(entry.source)}${net === "devnet" ? "?cluster=devnet" : ""}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  const actions = node("div", "", "permission-actions");
  actions.append(link);
  row.append(
    header,
    node("h3", unlimited ? "Spend without any limit" : `Spend up to ${text(entry.ui)} tokens`),
    node(
      "p",
      `${short(text(entry.delegate))} can move tokens out of ${short(text(entry.source))} without asking the wallet again${unlimited ? ". The limit is the largest number the program allows." : "."}`,
      "explain",
    ),
    facts,
    actions,
    node(
      "p",
      `This is what ${net}'s RPC reported a moment ago. This console verifies and revokes on ${network().label.toLowerCase()}; open Velon on ${net} to act on it.`,
      "notice",
    ),
  );
  mode = "scan";
  diff.hidden = true;
  results.hidden = false;
  actionResult.hidden = true;
  notice.replaceChildren();
  compareTab(false);
  results.replaceChildren(node("h2", `Seen on ${net}`), row);
  badge(`${net === "devnet" ? "Devnet" : "Mainnet"}, read only`);
  guide(2);
  if (innerWidth < 960) results.scrollIntoView({ block: "start" });
}

async function watchMainnet() {
  const list = document.querySelector<HTMLElement>("#mainnet-feed")!;
  const mode = document.querySelector<HTMLElement>("#mainnet-mode")!;
  let shown = "";
  // Rows on the console's own cluster can be verified and revoked; others are only reported.
  const choose = (choice: HTMLButtonElement) => {
    publicNet = choice.dataset.net as typeof publicNet;
    shown = "";
    list.replaceChildren(node("p", `Reading recent ${publicNet} blocks…`, "muted"));
    for (const other of document.querySelectorAll(".segmented button"))
      other.classList.toggle("selected", other === choice);
    mode.textContent = control?.network === publicNet ? "Verify and revoke" : "Read only";
  };
  for (const choice of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    choice.onclick = () => choose(choice);
    if (choice.dataset.net === control?.network) choose(choice);
  }
  for (;;) {
    try {
      const response = await call(`/api/${publicNet}/delegated`);
      if (response.status === 404) {
        // A network the server was not given is removed from the choice, not shown empty.
        const missing = document.querySelector<HTMLElement>(`.segmented [data-net="${publicNet}"]`)!;
        if (missing.hidden) return;
        missing.hidden = true;
        choose(
          document.querySelector<HTMLButtonElement>(
            `.segmented [data-net="${publicNet === "devnet" ? "mainnet" : "devnet"}"]`,
          )!,
        );
        continue;
      }
      const raw = await response.text();
      if (response.ok && raw !== shown) {
        shown = raw;
        document.querySelector<HTMLElement>("#mainnet")!.hidden = false;
        const rows = array(readJson(raw)).map(object);
        list.replaceChildren(
          ...rows.map((entry) => {
            const row = node("button", "", "feed-row");
            row.type = "button";
            const amount = text(entry.amount) === "18446744073709551615" ? "without limit" : text(entry.ui);
            row.append(
              node("span", short(text(entry.owner)), "address"),
              node("span", `${short(text(entry.delegate))} can spend ${amount}`, "muted"),
            );
            row.onclick = () => {
              for (const other of document.querySelectorAll(".feed-row"))
                other.removeAttribute("aria-current");
              row.setAttribute("aria-current", "");
              // On the cluster this console runs on, the row opens the verified flow.
              if (control?.network === publicNet) openLive(text(entry.source));
              else showMainnet(entry);
            };
            return row;
          }),
        );
        if (!rows.length)
          list.append(
            node("p", `No token approvals in the recent ${publicNet} blocks read so far.`, "muted"),
          );
      }
    } catch {
      /* The next poll retries. */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
  }
}

// A listed account is only a lead: opening it observes it through the runtime first.
function openLive(source: string) {
  const live = scenarios.findIndex((scenario) => scenario.live);
  if (live < 0 || select.disabled) return;
  closeBrowse();
  select.value = String(live);
  selectScenario();
  input.value = source;
  setMode("scan", true);
}

const feed = document.querySelector<HTMLElement>("#feed")!;
const bench = document.querySelector<HTMLButtonElement>("#new-permission")!;
// Lists what the validator reports as delegated right now. Discovery is not evidence:
// choosing a row observes that account through the runtime before anything is shown.
async function watch() {
  document.querySelector<HTMLElement>("#live")!.hidden = false;
  bench.hidden = !control?.testBench || !!connected;
  tryPanel.hidden = !control?.testBench;
  let shown = "";
  for (;;) {
    try {
      const response = await call("/api/live/spl/delegated");
      if (response.status === 404) return;
      const raw = await response.text();
      if (response.ok && raw !== shown) {
        const before = new Set(
          [...feed.querySelectorAll<HTMLElement>(".feed-row")].map((row) => row.dataset.source),
        );
        const first = shown === "";
        shown = raw;
        const rows = array(readJson(raw)).map(object);
        feed.replaceChildren(
          ...rows.map((entry) => {
            const row = node("button", "", "feed-row");
            row.type = "button";
            row.dataset.source = text(entry.source);
            if (!first && !before.has(row.dataset.source)) row.classList.add("fresh");
            row.toggleAttribute("aria-current", input.value === row.dataset.source);
            const amount = integer(readJson(text(entry.amount))).toLocaleString("en-US");
            row.append(
              node("span", short(text(entry.source)), "address"),
              node("span", `${short(text(entry.delegate))} can spend ${amount}`, "muted"),
            );
            if (connected && entry.owner === connected.account.address)
              row.append(node("span", "Yours", "badge"));
            row.onclick = () => openLive(text(entry.source));
            return row;
          }),
        );
        if (!rows.length) feed.append(node("p", "No delegated token accounts right now.", "muted"));
      }
    } catch {
      /* The next poll retries. */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
}

bench.onclick = async () => {
  bench.disabled = true;
  bench.textContent = "Approving on chain…";
  try {
    const response = await call("/api/live/spl/approve", {
      method: "POST",
      headers: { "X-Velon-Action": "test" },
    });
    const outcome = object(await result(response));
    status(`Approving ${text(outcome.allowance)} base units on chain. It appears below once finalized.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "The test approval failed.", true);
  } finally {
    bench.disabled = false;
    bench.textContent = "Add a demo permission";
  }
};

form.onsubmit = (event) => {
  event.preventDefault();
  closeBrowse();
  setMode("scan", true);
};
// On a public cluster the first thing a visitor can do is look up any wallet.
const lookup = document.querySelector<HTMLFormElement>("#lookup")!;
const lookupInput = document.querySelector<HTMLInputElement>("#lookup-address")!;
lookup.onsubmit = (event) => {
  event.preventDefault();
  const address = lookupInput.value.trim();
  if (!isAddress(address)) return status("Enter a valid Solana address.", true);
  openLive(address);
};
select.onchange = selectScenario;
document.querySelector<HTMLButtonElement>("#scan-tab")!.onclick = () => setMode("scan");
document.querySelector<HTMLButtonElement>("#diff-tab")!.onclick = () => setMode("diff");
try {
  const [scenarioData, controlData] = await Promise.all([get("scenarios"), get("control")]);
  if (controlData !== null) {
    const config = object(controlData);
    if (config.network !== "mainnet" && config.network !== "devnet" && config.network !== "localnet")
      throw new Error("Unsupported control network.");
    const rpcUrl = new URL(text(config.rpcUrl));
    if (!["http:", "https:"].includes(rpcUrl.protocol)) throw new Error("Invalid public RPC URL.");
    control = {
      cluster: text(config.cluster),
      rpcUrl: rpcUrl.href,
      network: config.network,
      testBench: config.testBench === true,
    };
  }
  const manifest = array(scenarioData);
  scenarios = manifest.map((value) => {
    const scenario = object(value);
    return {
      name: text(scenario.name),
      scope: text(scenario.scope),
      live: scenario.live === true,
      snapshots: array(scenario.snapshots).map((value) => ({
        id: text(object(value).id),
        slot: text(object(value).slot),
      })),
      examples: array(scenario.examples).map((value) => ({
        label: text(object(value).label),
        address: text(object(value).address),
      })),
    };
  });
  if (scenarios.length === 0) throw new Error("No native observations have been loaded.");
  select.replaceChildren(
    ...scenarios.map((scenario, index) => {
      const option = node("option", scenario.name);
      option.value = String(index);
      return option;
    }),
  );
  select.disabled = false;
  scanButton.disabled = false;
  refreshWallets();
  // A link from the product page names the account to open.
  const linked = decodeURIComponent(location.hash.slice(1));
  const live = scenarios.findIndex((scenario) => scenario.live);
  if (live >= 0 && isAddress(linked)) {
    document.body.classList.add("is-live");
    setBrowse(false);
    publicMode();
    select.value = String(live);
    selectScenario();
    input.value = linked;
    setMode("scan", true);
  } else if (live >= 0) {
    select.value = String(live);
    document.body.classList.add("is-live");
    setBrowse(false);
    publicMode();
    lesson();
    draw();
  } else {
    // Without a live chain the recorded examples are the whole console, so show them open.
    for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.search-panel"))
      panel.open = true;
    selectScenario();
  }
  if (control?.network === "localnet") void watch();
  void watchMainnet();
} catch (error) {
  status(error instanceof Error ? error.message : "Observations are unavailable.", true);
}

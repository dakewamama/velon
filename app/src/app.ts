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
import {
  array,
  authorization,
  compare,
  grants,
  integer,
  object,
  permissionLabel,
  principalLabel,
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
  const response = await fetch(`/api/${path}`, { signal });
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
    field("From", text(object(grant.resource).id)),
    field("Native system", system(grant)),
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
          : `${integer(usage.remaining).toLocaleString("en-US")} base units`,
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

function card(grant: ObjectValue, view: ObjectValue, availability: string, scope?: string): HTMLElement {
  const row = node("article", "", "permission");
  row.dataset.id = text(grant.id);
  const actor = object(grant.principal);
  row.dataset.who = actor.kind === "identity" ? short(text(actor.value)) : "several keys";
  const left = object(grant.usage).remaining;
  row.dataset.amount = left == null ? "" : integer(left).toLocaleString("en-US");
  row.dataset.system = text(object(grant.native_context).protocol);
  const header = node("div", "", "permission-header");
  const state = node("span", STATUS[availability] ?? availability, "availability");
  state.dataset.state = availability;
  const kind = text(object(grant.authority_kind).kind);
  header.append(node("span", KINDS[kind] ?? kind, "badge"), state);
  row.append(
    header,
    node("h3", permissionLabel(grant)),
    node("p", meaning(grant, connected?.account.address), "explain"),
  );
  const usage = object(grant.usage);
  if (usage.remaining !== undefined)
    row.append(
      node(
        "p",
        usage.remaining === null
          ? "Remaining allowance is unknown."
          : `${integer(usage.remaining).toLocaleString("en-US")} base units remain at this observation.`,
        "remaining",
      ),
    );
  const facts = node("dl");
  facts.append(
    field("Who", principalLabel(grant.principal)),
    field("From", text(object(grant.resource).id)),
    field("Native system", system(grant)),
  );
  // The wallet that owns the account the permission applies to.
  const holder = object(grant.subject);
  if (holder.kind === "identity") facts.prepend(field("Owner", text(holder.value)));
  const actions = node("div", "", "permission-actions");
  const button = node("button", "View details", "link-button");
  button.setAttribute("aria-expanded", "false");
  button.onclick = () => toggleDetail(row, button, grant);
  actions.append(button);
  row.append(facts, actions);
  if (
    control &&
    scope &&
    connected &&
    object(view.observation).origin === "finalized" &&
    grant.observability === "exact" &&
    object(grant.native_context).protocol === "spl-token" &&
    grant.capability === "spend" &&
    object(grant.authority_kind).kind === "direct" &&
    object(grant.lifecycle).kind === "active" &&
    object(grant.subject).kind === "identity" &&
    object(grant.subject).value === connected.account.address
  ) {
    const revoke = node("button", "Revoke", "action-button");
    revoke.onclick = () => void prepare(grant, scope);
    actions.prepend(revoke);
  } else if (scope && grant.capability === "spend") {
    // Only the token account's owner can sign a revoke; that is the chain's rule, not a setting.
    const holder = object(grant.subject);
    const owner = holder.kind === "identity" ? text(holder.value) : "";
    if (!connected) {
      const start = node("button", "Connect to revoke", "action-button");
      start.onclick = () => connectButton.click();
      actions.prepend(start);
    } else if (owner && owner !== connected.account.address)
      actions.append(node("span", `Only wallet ${short(owner)} can revoke this.`, "muted"));
  }
  return row;
}

function currentScenario(): Scenario {
  const scenario = scenarios[Number(select.value)];
  if (!scenario) throw new Error("No native observation selected.");
  return scenario;
}

async function scan(historical = false, refresh = false) {
  invalidateReview();
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const address = input.value.trim();
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
    if (live && (refresh || !scenario.scope)) {
      status("Observing the finalized token account...");
      const observed = await fetch("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source: address }),
        signal,
      });
      scenario.scope = text(object(await result(observed)).scope_id);
    }
    document.querySelector(".header-links .badge")!.textContent = live
      ? control!.network === "devnet"
        ? "Devnet observation"
        : "Local validator"
      : "Recorded native evidence";
    document.querySelector(".scope-note")!.textContent = live
      ? "Read from a finalized observation of this token account. Coverage is partial."
      : "Read from accounts captured in executed native tests. Coverage is partial.";
    const path = historical
      ? `snapshots/${scenario.snapshots[0]!.id}/authorizations/${address}`
      : `scopes/${scenario.scope}/effective/${address}`;
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
      row.append(
        node("span", change.kind, "badge"),
        node("h3", `${text(object(grant.authority_kind).kind)} authority: ${permissionLabel(grant)}`),
      );
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
  input.value = scenario.examples[0]?.address ?? "";
  if (mode === "diff") void showDiff();
  else void scan();
}

let control: Control | null = null;
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
        (control?.network !== "devnet" || account.chains.includes("solana:devnet")),
    );
    if (!account) throw new Error("This wallet has no compatible Solana signing account.");
    unsubscribe?.();
    connected = { wallet, account };
    unsubscribe = wallet.features["standard:events"].on("change", disconnected);
    walletStatus.textContent = `${account.address.slice(0, 4)}…${account.address.slice(-4)}`;
    walletStatus.title = `${wallet.name}: ${account.address}`;
    disconnectButton.hidden = false;
    refreshWallets();
    document.querySelector("#app")!.scrollIntoView();
    bench.hidden = true;
    tryPanel.dataset.state = "connected";
    draw();
    document.querySelector("#try-status")!.textContent = "Test tokens arrive, then you sign one approval.";
    const live = scenarios.findIndex((scenario) => scenario.live);
    if (live >= 0) select.value = String(live);
    if (control?.network === "localnet" && (await scanWallet())) return;
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
  const chain = control?.network === "devnet" ? ("solana:devnet" as const) : ("solana:localnet" as const);
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

// Every permission across the connected wallet's token accounts on the test chain.
// Each account is observed through the runtime; the chain's own list only says where to look.
async function scanWallet(): Promise<boolean | undefined> {
  if (!connected) return false;
  const owner = connected.account.address;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const listed = await fetch("/api/live/spl/delegated", { signal });
  if (!listed.ok) return false;
  mode = "scan";
  diff.hidden = true;
  receipts.hidden = true;
  results.hidden = false;
  const owned = array(readJson(await listed.text()))
    .map(object)
    .filter((entry) => entry.owner === owner);
  const content = document.createDocumentFragment();
  const cards: HTMLElement[] = [];
  let last: ObjectValue | undefined;
  try {
    for (const entry of owned) {
      const source = text(entry.source);
      const observed = await fetch("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
        signal,
      });
      const scope = text(object(await result(observed)).scope_id);
      const view = object(await get(`scopes/${scope}/effective/${source}`, signal));
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
  input.value = text(owned[0]?.source ?? "");
  document.querySelector(".header-links .badge")!.textContent = "Local validator";
  content.append(node("h2", "Who can act on your wallet"));
  if (last) content.append(metadata(last));
  if (cards.length) content.append(...cards);
  else
    content.append(
      node(
        "p",
        control?.testBench
          ? "No classic SPL token delegates found on this wallet. Get a test permission above, then revoke it here."
          : "No classic SPL token delegates found on this wallet. Other kinds of permission were not checked.",
        "empty",
      ),
    );
  compareTab(false);
  results.replaceChildren(content);
  notice.replaceChildren();
  reload = scanWallet;
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
    const funded = await fetch("/api/test/account", {
      method: "POST",
      headers: { "X-Velon-Action": "test", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: session.account.address }),
    });
    const account = object(await result(funded));
    const source = toAddress(text(account.source));
    const rpc = createSolanaRpc(control.rpcUrl);
    for (let attempt = 0; ; attempt++) {
      const held = await rpc
        .getTokenAccountBalance(source, { commitment: "confirmed" })
        .send()
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
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
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
      .send();
    say("Granted. Waiting for the chain to finalize it…");
    // Live means the finalized chain reports this delegate with this allowance, not that time passed.
    let finalized = false;
    for (let attempt = 0; attempt < 60 && connected === session && !finalized; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      const listed = await fetch("/api/live/spl/delegated");
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
    }
    if (!finalized)
      throw new Error(
        "The approval was sent but is not finalized yet, so it is not shown as live. Try again shortly.",
      );
    await scanWallet();
    say("Your permission is live. Revoke it below.");
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
        const response = await fetch(`/api/verifications/revoke/${receipt.id}`);
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
      node("h3", `Revoked on ${receipt.network === "devnet" ? "devnet" : "the test chain"}`),
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
    const [x, y] = SPOTS[index]!;
    const bend = x < 500 ? x + 170 : x - 170;
    const path = `M${x} ${y}C${bend} ${y} ${bend} 190 500 190`;
    const kind = item.dataset.system === "spl-token" ? "spl" : "sub";
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
document.querySelector<HTMLButtonElement>("#browse")!.onclick = (event) => {
  const open = document.body.classList.toggle("browsing");
  (event.currentTarget as HTMLElement).setAttribute("aria-expanded", String(open));
};

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
  stage.dataset.target = text(scanned.id);
  draw();
  sendRequested = false;
  try {
    setAction("PREPARING", "Observing the current finalized state...");
    const response = await action(`scopes/${scope}/actions/revoke/${source}`, signal);
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
    const path = `snapshots/${stateVersion}/actions/revoke/${source}/verify`;
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
    const facts = node("dl", "", "facts");
    facts.append(
      field("Who", principalLabel(grant.principal)),
      field("Can", "Spend"),
      field("From", source),
      field("Limit", `${integer(object(grant.usage).remaining).toLocaleString("en-US")} base units`),
      field("Native system", system(grant)),
      field("Network", config.network === "devnet" ? "Devnet" : "Local validator"),
      field("Simulation", "Verified"),
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
          new Proxy(createSolanaRpc(config.rpcUrl), {
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
        actionResult.append(field("Transaction signature", sent.signature));
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
            source,
            network: config.network,
            at: new Date().toISOString(),
          });
          signal.throwIfAborted();
          setAction(
            "VERIFIED",
            config.network === "devnet" ? "Verified on chain (devnet)." : "Verified on the local validator.",
          );
          actionResult.append(
            field("Transaction signature", sent.signature),
            field("Finalized slot", String(checked.slot)),
            field("Verification ID", checked.id),
          );
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
            ? "Your wallet altered the transaction before signing, so Velon did not send it. Set the wallet to this network (in Phantom: Settings, Developer Settings, Testnet Mode, Localnet) and try again."
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

// The first screen explains the three ideas the rest of the console relies on.
function lesson() {
  compareTab(false);
  results.replaceChildren();
  document.querySelector(".header-links .badge")!.textContent =
    control?.network === "devnet" ? "Devnet" : "Local validator";
}

// A mainnet row is shown as its RPC reports it. This runtime holds no mainnet evidence,
// so nothing here is presented as a verified permission and nothing can be revoked.
let publicNet: "devnet" | "mainnet" = "devnet";
function showMainnet(entry: ObjectValue) {
  const net = publicNet;
  const unlimited = text(entry.amount) === "18446744073709551615";
  const row = node("article", "", "permission reported");
  const header = node("div", "", "permission-header");
  header.append(
    node("span", `Solana ${net}`, "badge"),
    node("span", "Reported, not verified", "availability"),
  );
  const facts = node("dl");
  facts.append(
    field("Who", text(entry.delegate)),
    field("From", text(entry.source)),
    field("Wallet", text(entry.owner)),
    field("Token", text(entry.mint)),
  );
  const link = node("a", "Open on Solana Explorer ↗", "link-button");
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
      `This is what ${net}'s RPC reported a moment ago. Velon can only verify and revoke where it holds evidence for the chain's runtime, which in this build is the test chain.`,
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
  document.querySelector(".header-links .badge")!.textContent =
    `${net === "devnet" ? "Devnet" : "Mainnet"}, read only`;
  guide(2);
  if (innerWidth < 960) results.scrollIntoView({ block: "start" });
}

async function watchMainnet() {
  const list = document.querySelector<HTMLElement>("#mainnet-feed")!;
  let shown = "";
  for (const choice of document.querySelectorAll<HTMLButtonElement>(".segmented button"))
    choice.onclick = () => {
      publicNet = choice.dataset.net as typeof publicNet;
      shown = "";
      list.replaceChildren(node("p", `Reading recent ${publicNet} blocks…`, "muted"));
      for (const other of document.querySelectorAll(".segmented button"))
        other.classList.toggle("selected", other === choice);
    };
  for (;;) {
    try {
      const response = await fetch(`/api/${publicNet}/delegated`);
      if (response.status === 404) {
        // A network the server was not given is removed from the choice, not shown empty.
        const missing = document.querySelector<HTMLElement>(`.segmented [data-net="${publicNet}"]`)!;
        if (missing.hidden) return;
        missing.hidden = true;
        publicNet = publicNet === "devnet" ? "mainnet" : "devnet";
        document.querySelector(`.segmented [data-net="${publicNet}"]`)!.classList.add("selected");
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
              showMainnet(entry);
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
      const response = await fetch("/api/live/spl/delegated");
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
            row.onclick = () => {
              const live = scenarios.findIndex((scenario) => scenario.live);
              if (live < 0 || select.disabled) return;
              select.value = String(live);
              selectScenario();
              input.value = text(entry.source);
              setMode("scan", true);
            };
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
    const response = await fetch("/api/live/spl/approve", {
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
  setMode("scan", true);
};
select.onchange = selectScenario;
document.querySelector<HTMLButtonElement>("#scan-tab")!.onclick = () => setMode("scan");
document.querySelector<HTMLButtonElement>("#diff-tab")!.onclick = () => setMode("diff");
try {
  const [scenarioData, controlData] = await Promise.all([get("scenarios"), get("control")]);
  if (controlData !== null) {
    const config = object(controlData);
    if (config.network !== "devnet" && config.network !== "localnet")
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
    select.value = String(live);
    selectScenario();
    input.value = linked;
    setMode("scan", true);
  } else if (live >= 0) {
    select.value = String(live);
    document.body.classList.add("is-live");
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

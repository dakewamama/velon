const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("js");

// Sections fade in once as they enter the viewport; siblings stagger slightly.
const reveals = [...document.querySelectorAll<HTMLElement>(".reveal")];
const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      seen.unobserve(entry.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px" },
);
for (const element of reveals) {
  const siblings = [...(element.parentElement?.children ?? [])].filter((child) =>
    child.classList.contains("reveal"),
  );
  element.style.setProperty("--delay", `${Math.min(siblings.indexOf(element), 5) * 70}ms`);
  seen.observe(element);
}

// The navigation gains a backdrop once the page has scrolled.
const nav = document.querySelector<HTMLElement>("[data-nav]")!;
const onScroll = () => nav.classList.toggle("is-scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// The hero steps through three real captures: the permission, the review, the proof.
const stage = document.querySelector<HTMLElement>("[data-stage]")!;
const tabs = [...stage.querySelectorAll<HTMLButtonElement>("[data-go]")];
const frames = [...stage.querySelectorAll<HTMLElement>(".frame")];
const STEP_MS = 4200;
stage.style.setProperty("--step-ms", `${STEP_MS}ms`);
let step = 0;
let timer: number | undefined;
let visible = true;
let held = false;

function show(next: number) {
  step = (next + tabs.length) % tabs.length;
  stage.dataset.step = String(step);
  for (const [index, frame] of frames.entries()) frame.classList.toggle("is-front", index === step);
  for (const [index, tab] of tabs.entries()) {
    tab.setAttribute("aria-selected", String(index === step));
    tab.tabIndex = index === step ? 0 : -1;
  }
}
function schedule() {
  clearTimeout(timer);
  stage.classList.toggle("is-paused", held || reduced || !visible);
  if (held || reduced || !visible) return;
  // Restart the progress bar on the selected tab before counting down.
  const current = tabs[step]!;
  current.setAttribute("aria-selected", "false");
  void current.offsetWidth;
  current.setAttribute("aria-selected", "true");
  timer = window.setTimeout(() => {
    show(step + 1);
    schedule();
  }, STEP_MS);
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => {
    held = true;
    show(index);
    schedule();
  });
  tab.addEventListener("keydown", (event) => {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!move) return;
    event.preventDefault();
    held = true;
    show(step + move);
    tabs[step]!.focus();
    schedule();
  });
}
stage.addEventListener("pointerenter", () => {
  held = true;
  schedule();
});
stage.addEventListener("pointerleave", () => {
  held = false;
  schedule();
});
new IntersectionObserver(([entry]) => {
  visible = entry!.isIntersecting;
  schedule();
}).observe(stage);
show(reduced ? 2 : 0);
schedule();

// The timeline line fills as "How it works" passes through the viewport.
const steps = document.querySelector<HTMLElement>("[data-steps]")!;
const items = [...steps.querySelectorAll<HTMLElement>(".step")];
function progress() {
  const box = steps.getBoundingClientRect();
  const start = innerHeight * 0.85;
  const end = innerHeight * 0.35;
  const amount = reduced ? 1 : Math.min(1, Math.max(0, (start - box.top) / (start - end)));
  steps.style.setProperty("--progress", amount.toFixed(3));
  for (const [index, item] of items.entries())
    item.classList.toggle("is-on", amount >= index / items.length + 0.01);
}
addEventListener("scroll", progress, { passive: true });
addEventListener("resize", progress);
progress();

// Copies the commands without the prompt characters.
const copy = document.querySelector<HTMLButtonElement>("[data-copy]")!;
const code = document.querySelector<HTMLElement>("[data-code]")!;
copy.addEventListener("click", async () => {
  const text = code.innerText.replace(/^\$ /gm, "");
  try {
    await navigator.clipboard.writeText(text);
    copy.textContent = "Copied";
  } catch {
    // Clipboard access can be refused; selecting the text lets the visitor copy it by hand.
    getSelection()?.selectAllChildren(code);
    copy.textContent = "Selected";
  }
  setTimeout(() => (copy.textContent = "Copy"), 1600);
});

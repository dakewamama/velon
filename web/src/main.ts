const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

const nav = $(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const revealer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      revealer.unobserve(e.target);
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
);
$$(".reveal, .ledger").forEach((el) => revealer.observe(el));

// Hero loop. Step 0 resets the card, steps 1-4 are observe, execute, sign, verify.
function hero() {
  const spec = $("#spec");
  const toggle = $<HTMLButtonElement>("#spec-toggle");
  if (!spec || !toggle) return;
  const steps = $$<HTMLButtonElement>(".rail-step", spec);
  const stepMs = [700, 2400, 2800, 2300, 5200];
  let step = 4;
  let timer = 0;
  let startedAt = 0;
  let remaining = 0;
  let userPaused = false;
  let visible = true;

  const show = (n: number) => {
    step = n;
    spec.dataset.step = String(n);
    spec.style.setProperty("--step-dur", `${stepMs[n]}ms`);
    steps.forEach((b) => {
      if (Number(b.dataset.go) === n) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
  };
  const schedule = (ms: number) => {
    clearTimeout(timer);
    startedAt = performance.now();
    remaining = ms;
    timer = window.setTimeout(next, ms);
  };
  const next = () => {
    const n = (step + 1) % stepMs.length;
    // Restart CSS animations for the new step.
    spec.classList.remove("playing");
    void spec.offsetWidth;
    spec.classList.add("playing");
    show(n);
    schedule(stepMs[n]);
  };
  const running = () => spec.classList.contains("playing") && !spec.classList.contains("paused");
  const pause = () => {
    if (!running()) return;
    clearTimeout(timer);
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
    spec.classList.add("paused");
  };
  const resume = () => {
    if (userPaused || !visible || document.hidden || reduced.matches) return;
    if (!spec.classList.contains("playing")) {
      spec.classList.add("playing");
      show(0);
      schedule(stepMs[0]);
      return;
    }
    if (!spec.classList.contains("paused")) return;
    spec.classList.remove("paused");
    schedule(remaining);
  };
  const setLabel = () => {
    toggle.setAttribute("aria-label", userPaused ? "Play animation" : "Pause animation");
  };

  toggle.addEventListener("click", () => {
    userPaused = !userPaused;
    setLabel();
    if (userPaused) pause();
    else resume();
  });
  steps.forEach((b) =>
    b.addEventListener("click", () => {
      // Picking a step stops the loop on that step.
      clearTimeout(timer);
      userPaused = true;
      setLabel();
      spec.classList.remove("playing", "paused");
      show(Number(b.dataset.go));
    }),
  );

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) resume();
    else pause();
  }).observe(spec);
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : resume()));

  const applyMotionPref = () => {
    if (reduced.matches) {
      clearTimeout(timer);
      spec.classList.remove("playing", "paused");
      toggle.hidden = true;
      show(4);
    } else {
      toggle.hidden = false;
      if (!userPaused) {
        show(0);
        resume();
      }
    }
  };
  reduced.addEventListener("change", applyMotionPref);
  applyMotionPref();
}

// How it works: on wide screens the plates move into a sticky stage driven by the steps.
function flow() {
  const flowEl = $("#flow");
  const stage = $("#flow-stage");
  if (!flowEl || !stage) return;
  const items = $$(".step", flowEl);
  const plates = items.map((s) => $(".plate", s)!);
  const wide = matchMedia("(min-width: 1024px)");

  const setActive = (n: number) => {
    stage.dataset.plate = String(n);
    items.forEach((s, i) => s.classList.toggle("on", i + 1 === n));
    plates.forEach((p, i) => p.classList.toggle("lit", i + 1 === n));
  };

  const stepWatch = new IntersectionObserver(
    (entries) => {
      if (!wide.matches) return;
      for (const e of entries)
        if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.plate));
    },
    { rootMargin: "-48% 0px -48% 0px" },
  );
  const plateWatch = new IntersectionObserver(
    (entries) => {
      if (wide.matches) return;
      for (const e of entries) if (e.isIntersecting) e.target.classList.add("lit");
    },
    { threshold: 0.35 },
  );

  const arrange = () => {
    if (wide.matches) {
      plates.forEach((p) => stage.appendChild(p));
      flowEl.classList.add("staged");
      setActive(Number(stage.dataset.plate) || 1);
    } else {
      flowEl.classList.remove("staged");
      plates.forEach((p, i) => {
        items[i].appendChild(p);
        p.classList.remove("lit");
      });
      items.forEach((s) => s.classList.remove("on"));
    }
  };
  items.forEach((s) => stepWatch.observe(s));
  plates.forEach((p) => plateWatch.observe(p));
  wide.addEventListener("change", arrange);
  arrange();
}

// Receipt replay: highlights each recorded check in order.
function replay() {
  const btn = $<HTMLButtonElement>("#replay");
  const status = $("#replay-status");
  const rows = $$("#receipt .r-rows div[data-n]");
  if (!btn || !status) return;
  let timers: number[] = [];
  btn.addEventListener("click", () => {
    timers.forEach(clearTimeout);
    timers = [];
    rows.forEach((r) => r.classList.remove("hl", "ok"));
    status.textContent = "Replaying recorded evidence.";
    const gap = reduced.matches ? 0 : 360;
    rows.forEach((r, i) => {
      timers.push(
        window.setTimeout(
          () => {
            rows.forEach((x) => x.classList.remove("hl"));
            r.classList.add("hl", "ok");
          },
          gap * (i + 1),
        ),
      );
    });
    timers.push(
      window.setTimeout(
        () => {
          rows.forEach((x) => x.classList.remove("hl"));
          status.textContent = "All recorded checks replayed. The delegate is absent.";
        },
        gap * (rows.length + 2),
      ),
    );
  });
}

function copy() {
  const btn = $<HTMLButtonElement>("#copy");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? "");
      btn.textContent = "Copied";
      btn.classList.add("done");
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); point people at manual copy.
      btn.textContent = "Select and copy";
    }
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("done");
    }, 1800);
  });
}

hero();
flow();
replay();
copy();

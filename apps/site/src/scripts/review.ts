// The page's one orchestrated motion: it reviews itself. Each section with [data-ink] gets inspected and circled as it
// scrolls into view, its Change Item arrives in the dock, and the agents section resolves them in turn. Everything
// starts visible in the HTML; this script only holds back what hasn't happened yet, and does nothing under reduced
// motion but show the end state.

const root = document.documentElement;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sections = [...document.querySelectorAll<HTMLElement>('[data-section]')];
const dockItems = [...document.querySelectorAll<HTMLElement>('[data-dock-item]')];
const count = document.querySelector<HTMLElement>('[data-count]');
const sectionOrder = sections.map((s) => s.dataset.section);

// Live sizes in the inspector tags, like the real one.
const measure = (box: HTMLElement) => {
  const target = [...box.children].find(
    (el) => !el.classList.contains('box') && !el.classList.contains('inspect-tag'),
  ) as HTMLElement | undefined;
  const size = box.querySelector<HTMLElement>('[data-size]');
  if (!target || !size) return;
  const { width, height } = target.getBoundingClientRect();
  size.textContent = ` ${Math.round(width)} × ${Math.round(height)}`;
};
const resize = new ResizeObserver((entries) => {
  for (const entry of entries) measure(entry.target as HTMLElement);
});
for (const box of document.querySelectorAll<HTMLElement>('[data-inspect]')) resize.observe(box);

// The pen loops draw on with a dash as long as the path on screen. Their stroke ignores the loop's stretch, so the
// length is summed in screen pixels, not read from the path.
const measureLoop = (path: SVGPathElement) => {
  const ctm = path.getScreenCTM();
  if (!ctm) return;
  const total = path.getTotalLength();
  const steps = 96;
  let length = 0;
  let prev: DOMPoint | null = null;
  for (let i = 0; i <= steps; i++) {
    const point = path.getPointAtLength((total * i) / steps).matrixTransform(ctm);
    if (prev) length += Math.hypot(point.x - prev.x, point.y - prev.y);
    prev = point;
  }
  path.style.setProperty('--len', `${Math.ceil(length) + 2}px`);
};
const loops = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const path = entry.target.querySelector('path');
    if (path) measureLoop(path);
  }
});
if (!reduced) for (const svg of document.querySelectorAll('.pen-loop')) loops.observe(svg);

const setCount = () => {
  if (count) count.textContent = String(dockItems.filter((li) => li.classList.contains('arrived')).length);
};

const setStatus = (id: string, status: 'open' | 'working' | 'done') => {
  const label = { open: 'Open', working: 'In work', done: 'Done' }[status];
  for (const card of document.querySelectorAll<HTMLElement>(`[data-item="${id}"]`)) {
    card.dataset.status = status;
    const pill = card.querySelector('[data-status-label]');
    if (pill) pill.textContent = label;
  }
  const row = document.querySelector<HTMLElement>(`[data-run="${id}"]`);
  if (row) {
    row.dataset.status = status;
    const pill = row.querySelector('[data-run-status]');
    if (pill) pill.textContent = label;
    const note = row.querySelector<HTMLElement>('[data-run-note]');
    if (note && status !== 'open') note.textContent = note.dataset.resolution ?? '';
  }
};

const endOf = (li: HTMLElement) => (li.dataset.ends === 'working' ? 'working' : 'done');
const resolveAll = () => {
  for (const li of dockItems) setStatus(li.dataset.dockItem!, endOf(li));
};

if (reduced) {
  // The end state, all at once: every section inspected, every item made and resolved.
  for (const s of document.querySelectorAll('[data-ink]')) s.classList.add('is-inked');
  for (const li of dockItems) li.classList.add('arrived');
  setCount();
  resolveAll();
} else {
  setCount();

  // Arriving at a section makes its item, and any skipped earlier ones, in page order.
  const reached = new Set<string>();
  const arrive = (section: string) => {
    const upTo = sectionOrder.indexOf(section);
    for (const s of sections.slice(0, upTo + 1)) {
      const name = s.dataset.section!;
      if (reached.has(name)) continue;
      reached.add(name);
      if (s.hasAttribute('data-ink')) s.classList.add('is-inked');
      const li = dockItems.find((d) => d.dataset.section === name);
      li?.classList.add('arrived');
      if (s.hasAttribute('data-agents')) runAgents();
    }
    setCount();
  };

  let ran = false;
  const runAgents = () => {
    if (ran) return;
    ran = true;
    // Every item on the page is on the agents' list, even ones made further down.
    for (const li of dockItems) li.classList.add('arrived');
    setCount();
    dockItems.forEach((li, i) => {
      const id = li.dataset.dockItem!;
      setTimeout(() => setStatus(id, 'working'), 350 + i * 520);
      if (endOf(li) === 'done') setTimeout(() => setStatus(id, 'done'), 1100 + i * 520);
    });
  };

  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        arrive((entry.target as HTMLElement).dataset.section!);
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -35% 0px', threshold: 0.2 },
  );
  // The hero is already on screen: give the load a beat, then review it.
  requestAnimationFrame(() => setTimeout(() => arrive('top'), 350));
  for (const s of sections.slice(1)) seen.observe(s);
}

// The nav gets its hairline once the page moves.
const onScroll = () => root.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Real captures play when they're on screen, never under reduced motion.
const players = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const video = entry.target as HTMLVideoElement;
    if (entry.isIntersecting && !reduced) video.play().catch(() => {});
    else video.pause();
  }
});
for (const video of document.querySelectorAll<HTMLVideoElement>('video[data-autoplay]')) players.observe(video);

// Copy buttons.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const label = button.querySelector('[data-copy-label]');
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.classList.add('copied');
      if (label) label.textContent = 'Copied';
    } catch {
      if (label) label.textContent = 'Select and copy';
    }
    setTimeout(() => {
      button.classList.remove('copied');
      if (label) label.textContent = 'Copy';
    }, 1800);
  });
}

// Hold Alt to inspect anything on the page.
const probe = document.querySelector<HTMLElement>('[data-probe]');
const probeBox = probe?.querySelector<HTMLElement>('.probe-box');
const probeTag = probe?.querySelector<HTMLElement>('.probe-tag');
let altDown = false;
let last: Element | null = null;

const describe = (el: Element) => {
  const cls = [...el.classList].find((c) => !c.startsWith('astro-')) ?? '';
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : cls ? `.${cls}` : '');
};

const show = (el: Element | null) => {
  if (!probe || !probeBox || !probeTag || !el || probe.contains(el)) return;
  const r = el.getBoundingClientRect();
  Object.assign(probeBox.style, {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  probeTag.innerHTML = '';
  probeTag.append(describe(el));
  const dim = document.createElement('span');
  dim.className = 'dim';
  dim.textContent = ` ${Math.round(r.width)} × ${Math.round(r.height)}`;
  probeTag.append(dim);
  const above = r.top > 36;
  Object.assign(probeTag.style, {
    left: `${Math.max(8, r.left)}px`,
    top: above ? `${r.top - 30}px` : `${r.bottom + 6}px`,
  });
  probe.hidden = false;
};

addEventListener('keydown', (e) => {
  if (e.key !== 'Alt' || altDown) return;
  altDown = true;
  show(last);
});
addEventListener('keyup', (e) => {
  if (e.key !== 'Alt') return;
  altDown = false;
  if (probe) probe.hidden = true;
});
addEventListener('blur', () => {
  altDown = false;
  if (probe) probe.hidden = true;
});
addEventListener(
  'pointermove',
  (e) => {
    last = e.target as Element;
    if (altDown) show(last);
  },
  { passive: true },
);

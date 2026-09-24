// A stand-in for the Process model that reads the script like the real one would, for the long-Session proof
// (tests/unit/adapters/long-session.test.ts). It is not a language model: it makes one Change Item per Annotation
// it sees (overlap included, so neighbouring windows produce duplicates for the merge to find), names the Annotation's
// PICK as the subject, takes the paired SPEECH as the transcript, keeps PINNED DRAFT ITEMS as pinned items, and lists
// the Annotations it was told to account for but has no speech for in `dropped_annotations`.
export interface ScriptModelOptions {
  /** Leave these Annotations out entirely, to prove the coverage check sends a repair. */
  omit?: readonly number[];
}

interface SeenAnnotation {
  index: number;
  screenshot: string | null;
  start: number;
  end: number;
  pick: string | null;
  discarded: boolean;
}

const secs = (stamp: string) => {
  const [m, s] = stamp.split(':');
  return Number(m) * 60 + Number(s);
};

export function scriptModel(script: string, opts: ScriptModelOptions = {}) {
  const lines = script.split('\n');
  const owned = (/^ANNOTATIONS TO ACCOUNT FOR: (.*?)\. /m.exec(script)?.[1] ?? '').match(/\d+/g)?.map(Number) ?? [];
  const seen = new Map<number, SeenAnnotation>();
  const speech = new Map<number, string>();
  let current: SeenAnnotation | null = null;
  for (const line of lines) {
    const a = /ANNOTATION #(\d+) .*? · (\d\d:\d\d\.\d)–(\d\d:\d\d\.\d) · .*? screenshot (s\d+|none)/.exec(line);
    if (a) {
      current = {
        index: Number(a[1]),
        start: secs(a[2]!),
        end: secs(a[3]!),
        screenshot: a[4] === 'none' ? null : a[4]!,
        pick: null,
        discarded: line.includes('DISCARDED'),
      };
      seen.set(current.index, current);
      continue;
    }
    const c = /^\s+c\d+ (\S+) · .* · PICK · /.exec(line);
    if (c && current && current.pick === null) current.pick = c[1]!;
    const s = /SPEECH "(.*?)" · .* near #(\d+)/.exec(line);
    if (s) speech.set(Number(s[2]), s[1]!);
  }

  const items: unknown[] = [];
  const dropped: { annotation: number; reason: string }[] = [];
  for (const a of [...seen.values()].sort((x, y) => x.index - y.index)) {
    if (a.discarded || opts.omit?.includes(a.index)) continue;
    const said = speech.get(a.index);
    if (!said) {
      if (owned.includes(a.index))
        dropped.push({ annotation: a.index, reason: 'The reviewer drew it but said nothing about it.' });
      continue;
    }
    const color = /should be (\w+)/.exec(said)?.[1] ?? 'different';
    const shots = a.screenshot ? [a.screenshot] : [];
    items.push({
      id: `item_${String(items.length + 1).padStart(4, '0')}`,
      title: `Make ${a.pick ?? 'the page'} ${color}`,
      category: 'style',
      intent: `The reviewer wants ${a.pick ?? 'the page'} to be ${color}.`,
      locations: [
        {
          role: 'subject',
          selector: a.pick,
          element: a.pick ?? 'page',
          url: '/pricing.html',
          screenshot: a.screenshot,
          annotation: a.index,
        },
      ],
      evidence: { video: { start: a.start, end: a.end + 2 }, screenshots: shots },
      transcript: said,
      confidence: 0.9,
      agent_prompt: `On /pricing.html change ${a.pick} to ${color}.${shots.map((s) => ` See screenshots/${s}.png.`).join('')}`,
      pinned: false,
    });
  }
  // PINNED DRAFT ITEMS: - d1 "Title" (style) · intent: "…" · subject element (selector) #13
  const pinnedAt = lines.findIndex((l) => l.startsWith('PINNED DRAFT ITEMS'));
  if (pinnedAt >= 0) {
    for (const line of lines.slice(pinnedAt + 1)) {
      const p = /^- (d\d+) "(.*?)" \((\w+)\) · intent: "(.*?)".*?\((\S+)\) #(\d+)/.exec(line);
      if (!p) break;
      const a = seen.get(Number(p[6]));
      const shots = a?.screenshot ? [a.screenshot] : [];
      items.push({
        id: `item_${String(items.length + 1).padStart(4, '0')}`,
        title: p[2],
        category: p[3],
        intent: p[4],
        locations: [
          {
            role: 'subject',
            selector: p[5],
            element: p[5],
            url: '/pricing.html',
            screenshot: a?.screenshot ?? null,
            annotation: Number(p[6]),
          },
        ],
        evidence: { video: a ? { start: a.start, end: a.end } : null, screenshots: shots },
        transcript: speech.get(Number(p[6])) ?? '',
        confidence: 0.95,
        agent_prompt: `${p[2]}.${shots.map((s) => ` See screenshots/${s}.png.`).join('')}`,
        pinned: true,
      });
    }
  }
  return { items, dropped_annotations: dropped };
}

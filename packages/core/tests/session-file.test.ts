import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadZip } from 'client-zip';
import { describe, expect, it } from 'vitest';
import { readSessionFile, SessionFileError, UPGRADES, upgradeSessionDocument } from '../src/session-file';
import { SCHEMA_VERSION } from '../src/timeline';

const FIXTURES = join(__dirname, '../../../fixtures/sessions');
const load = (f: string) =>
  JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Record<string, unknown> & {
    events: Record<string, unknown>[];
  };
const current = () => load('a-move-here.word.json');
const json = (doc: unknown) => new Blob([JSON.stringify(doc)], { type: 'application/json' });
const zip = (files: { name: string; input: string | Uint8Array }[]) => downloadZip(files).blob();
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

async function rejection(p: Promise<unknown>): Promise<SessionFileError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(SessionFileError);
  return e as SessionFileError;
}

describe('readSessionFile', () => {
  it('reads a bare session.json, with no media', async () => {
    const r = await readSessionFile(json(current()));
    expect(r.source).toBe('json');
    expect(r.doc.session.id).toBe('fixture-a-move-here-word');
    expect(r.doc.events).toHaveLength(10);
    expect(r.files.size).toBe(0);
  });

  it('reads an export zip and returns its files by export path', async () => {
    const doc = current();
    const blobs = doc.blobs as { path: string }[];
    const file = await zip([
      { name: 'review.md', input: '# Review' },
      { name: 'session.json', input: JSON.stringify(doc) },
      { name: blobs[0]!.path, input: png(1) },
      { name: blobs[1]!.path, input: png(2) },
    ]);
    const r = await readSessionFile(file);
    expect(r.source).toBe('zip');
    expect([...r.files.keys()].sort()).toEqual(['review.md', blobs[0]!.path, blobs[1]!.path].sort());
    const shot = r.files.get(blobs[1]!.path)!;
    expect(shot.type).toBe('image/png');
    expect([...new Uint8Array(await shot.arrayBuffer())]).toEqual([...png(2)]);
  });

  it('finds session.json one folder down in a re-zipped export folder', async () => {
    const doc = current();
    const path = (doc.blobs as { path: string }[])[0]!.path;
    const r = await readSessionFile(
      await zip([
        { name: 'review-x/session.json', input: JSON.stringify(doc) },
        { name: `review-x/${path}`, input: png(3) },
      ]),
    );
    expect([...r.files.keys()]).toEqual([path]);
  });

  it('refuses a zip without session.json, garbage, and JSON that is not a Session', async () => {
    expect((await rejection(readSessionFile(await zip([{ name: 'notes.txt', input: 'hi' }])))).message).toMatch(
      /no session\.json/,
    );
    expect((await rejection(readSessionFile(new Blob(['\x00\x01garbage'])))).message).toMatch(
      /neither an export zip nor a session\.json/,
    );
    expect((await rejection(readSessionFile(json({ hello: 'world' })))).message).toMatch(/not a Session export/);
  });

  it('refuses a document that does not validate, naming the first problems', async () => {
    const doc = current();
    delete (doc.session as Record<string, unknown>).start_url;
    expect((await rejection(readSessionFile(json(doc)))).message).toMatch(/session\.start_url/);
  });

  it('drops fields the schema does not know, so nothing like a key rides along', async () => {
    const doc: Record<string, unknown> = { ...current(), settings: { anthropicKey: 'sk-ant-secret' } };
    (doc.session as Record<string, unknown>).anthropic_key = 'sk-ant-secret';
    const r = await readSessionFile(json(doc));
    expect(JSON.stringify(r.doc)).not.toContain('sk-ant-secret');
  });
});

describe('upgradeSessionDocument', () => {
  it('has a step for every version below the current one', () => {
    for (let v = 1; v < SCHEMA_VERSION; v++) expect(UPGRADES[v], `step ${v}→${v + 1}`).toBeTypeOf('function');
  });

  it('reads a real schema v2 capture', () => {
    const doc = upgradeSessionDocument(load('captured/pricing-annotations.session.json'));
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.media.audio?.path).toBe('audio.webm');
    expect(doc.process_runs).toEqual([]);
  });

  it('gives a v2 voice_command an end where it starts', () => {
    const doc = current();
    const end = doc.events.findIndex((e) => e.type === 'session_end');
    const t = doc.events[end - 1]!.t as number;
    doc.events.splice(end, 0, {
      id: 'vc1',
      type: 'voice_command',
      t,
      command: 'next',
      phrase: 'next',
      segment_id: null,
    });
    const up = upgradeSessionDocument({ ...doc, schema_version: 2 });
    expect(up.events.find((e) => e.type === 'voice_command')).toMatchObject({ t, t_end: t, target: null });
  });

  it('reads a v7 export: session_start and navigation gain overlay "page" (U5)', () => {
    const doc = current();
    const strip = (e: Record<string, unknown>) => {
      const { overlay: _, ...rest } = e;
      return rest;
    };
    doc.events = doc.events.map((e) => (e.type === 'session_start' || e.type === 'navigation' ? strip(e) : e));
    doc.events.splice(1, 0, {
      id: 'nav7',
      type: 'navigation',
      t: 1,
      url: 'http://localhost:4401/docs.html',
      title: 'Docs',
    });
    const up = upgradeSessionDocument({ ...doc, schema_version: 7 });
    expect(up.schema_version).toBe(SCHEMA_VERSION);
    expect(up.events.find((e) => e.type === 'session_start')).toMatchObject({ overlay: 'page' });
    expect(up.events.find((e) => e.type === 'navigation')).toMatchObject({ overlay: 'page' });
  });

  it('refuses v4 Draft Items, which lack what v5 needs', () => {
    const doc = current();
    doc.events.push({
      id: 'd1',
      type: 'draft_item',
      t: 99_999,
      draft_id: 'd1',
      title: 'x',
      category: 'copy',
      location_names: [],
      annotation_ids: [],
    });
    expect(() => upgradeSessionDocument({ ...doc, schema_version: 4 })).toThrow(/schema version 4 and has Draft Items/);
  });

  it('refuses a newer or unknown version', () => {
    expect(() => upgradeSessionDocument({ ...current(), schema_version: SCHEMA_VERSION + 1 })).toThrow(
      /newer version of the extension/,
    );
    expect(() => upgradeSessionDocument({ ...current(), schema_version: 0 })).toThrow(/unknown schema version/);
  });
});

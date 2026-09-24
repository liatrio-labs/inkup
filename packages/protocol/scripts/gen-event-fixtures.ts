// `pnpm fixtures:events`: writes one `event` message fixture for every timeline event type (packages/core
// timeline.ts), and a variant per shape the Host reads differently, into contract/fixtures/ as `event.<type>[.<variant>].json`;
// and the `items.json` Change Item push. Together they are one Session as the extension would stream it: every
// optional field filled, so the Host's contract test (host/crates/server/src/contract.rs) sees every field it could
// read. test/event-fixtures.test.ts fails when the files are stale, when a type has no fixture, or when a field of
// the schema is in none of a type's fixtures.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChangeItem } from '@inkup/core/process/change-item';
import type { EventOf, EventType } from '@inkup/core/timeline';
import type { EventMessage, ItemsMessage } from '../src/index.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contract', 'fixtures');

export const SESSION_ID = '3f6c1d2e-8a4b-4c7e-9f10-2b5d6e7a8c90';
const URL = 'http://localhost:4401/pricing.html';
const page = { url: URL, scroll: { x: 0, y: 120 }, viewport: { width: 1280, height: 720 }, dpr: 2 };
const cta = {
  selector: 'main .hero button.cta',
  tag: 'button',
  role: 'button',
  name: 'Get started',
  text: 'Get started',
  testid: 'cta',
  id: 'get-started',
  classes: ['cta', 'btn-primary'],
  bbox: { x: 820, y: 330, width: 160, height: 48 },
  relation: 'pick' as const,
  coverage: 0.92,
  source: { file: 'src/components/Hero.tsx', line: 42, components: ['CallToAction', 'Hero', 'PricingPage'] },
};
const card = {
  ...cta,
  selector: 'main .hero',
  tag: 'section',
  role: 'region',
  name: 'Pricing',
  text: 'Pricing Get started',
  testid: null,
  id: null,
  classes: ['hero'],
  bbox: { x: 0, y: 200, width: 1280, height: 400 },
  relation: 'ancestor' as const,
  coverage: 1,
};

/** Every fixture: its file variant (none: the type's main one), message id and event. */
type Sample<T extends EventType> = { variant?: string; event: EventOf<T> };
type Samples = { [T in EventType]: Sample<T>[] };

export const SAMPLES: Samples = {
  session_start: [
    // The ids and values the older hand-written fixture had, which the host tests match on.
    {
      event: {
        id: '8d023b2f-7764-497f-841b-25da2c96a4d5',
        type: 'session_start',
        t: 0,
        tab_id: 101737479,
        url: 'http://localhost:4401/pricing.html',
        title: 'Pricing Fixture',
        t0: 1790124349836,
        clicked_at: 1790124349512,
        overlay: 'page',
        voice: true,
      },
    },
  ],
  voice_on: [{ event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c01', type: 'voice_on', t: 300 } }],
  session_pause: [
    { event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c02', type: 'session_pause', t: 12000, via: 'voice' } },
  ],
  session_resume: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c03',
        type: 'session_resume',
        t: 15000,
        gap_ms: 3000,
        via: 'button',
      },
    },
  ],
  mic_muted: [{ event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c04', type: 'mic_muted', t: 16000, via: 'shortcut' } }],
  mic_unmuted: [
    { event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c05', type: 'mic_unmuted', t: 17000, via: 'button' } },
  ],
  stroke: [
    {
      event: {
        id: 'cec8e54e-a7f6-418a-b1dd-59be9f43d7ee',
        type: 'stroke',
        t: 1000,
        stroke_id: '2973b096-3fdc-4d09-855a-3188bdb3a819',
        t_end: 1804,
        points: [
          { x: 971.8, y: 234.5, t: 1001 },
          { x: 971.1, y: 238, t: 1017 },
          { x: 969, y: 241.5, t: 1034 },
          { x: 971.8, y: 234.5, t: 1804 },
        ],
        bbox: { x: 812.2164306640625, y: 207.5500030517578, width: 159.551513671875, height: 53.90000915527344 },
        url: 'http://localhost:4401/pricing.html',
        scroll: { x: 0, y: 0 },
        viewport: { width: 1280, height: 720 },
        dpr: 1,
        shape: 'circle',
        color: '#e5484d',
      },
    },
  ],
  annotation: [
    {
      // Drawn: a circle round the button and an arrow to the header, with its crop.
      event: {
        id: 'a1b2c3d4-0001-4e5f-8a9b-0c1d2e3f4a51',
        type: 'annotation',
        t: 1000,
        annotation_id: 'a1',
        index: 1,
        t_end: 2600,
        stroke_ids: ['2973b096-3fdc-4d09-855a-3188bdb3a819', 'f3a1c2d4-5b6e-4f70-8a9b-1c2d3e4f5a60'],
        close_reason: 'time_gap',
        bbox: { x: 812, y: 207, width: 160, height: 54 },
        ...page,
        resolution: 'element',
        candidates: [cta, card],
        pick: 0,
        screenshot_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d41',
        connector: {
          stroke_ids: ['f3a1c2d4-5b6e-4f70-8a9b-1c2d3e4f5a60'],
          tail: { point: { x: 900, y: 354 }, bbox: cta.bbox, resolution: 'element', candidates: [cta], pick: 0 },
          head: {
            point: { x: 640, y: 40 },
            bbox: { x: 600, y: 0, width: 80, height: 80 },
            resolution: 'element',
            candidates: [
              {
                ...card,
                selector: 'header nav',
                tag: 'nav',
                role: 'navigation',
                name: 'Main',
                text: 'Docs Pricing',
                testid: 'main-nav',
                id: 'main-nav',
                relation: 'pick',
              },
            ],
            pick: 0,
          },
        },
        comment: 'Move this into the header',
        crop: {
          blob_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d41.crop',
          path: 'screenshots/b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d41.crop.png',
          rect: { x: 1624, y: 388, width: 384, height: 160 },
        },
        source: 'reviewer',
      },
    },
    {
      // An Object Select pick with its typed comment: the Annotation "scratch that" targets.
      variant: 'object_select',
      event: {
        id: 'a1b2c3d4-0002-4e5f-8a9b-0c1d2e3f4a52',
        type: 'annotation',
        t: 4000,
        annotation_id: 'a2',
        index: 2,
        t_end: 5200,
        stroke_ids: [],
        close_reason: 'object_select',
        bbox: cta.bbox,
        ...page,
        resolution: 'element',
        candidates: [cta],
        pick: 0,
        screenshot_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d42',
        connector: null,
        comment: 'Make this roomier',
        crop: {
          blob_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d42.crop',
          path: 'screenshots/b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d42.crop.png',
          rect: { x: 1624, y: 388, width: 384, height: 160 },
        },
        source: 'reviewer',
      },
    },
    {
      // Made by a script on the page through window.__inkup.annotate (E5).
      variant: 'page_api',
      event: {
        id: 'a1b2c3d4-0003-4e5f-8a9b-0c1d2e3f4a53',
        type: 'annotation',
        t: 6000,
        annotation_id: 'a3',
        index: 3,
        t_end: 6000,
        stroke_ids: [],
        close_reason: 'page_api',
        bbox: card.bbox,
        ...page,
        resolution: 'element',
        candidates: [card],
        pick: 0,
        screenshot_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d43',
        connector: null,
        comment: null,
        source: 'page_api',
        page_api: { comment: 'The hero needs more padding on small screens' },
      },
    },
  ],
  style_edit: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c06',
        type: 'style_edit',
        t: 6000,
        annotation_id: 'a3',
        selector: 'main .hero',
        changes: { padding: { from: '16px', to: '32px 24px' } },
        text: { from: 'Pricing', to: 'Plans and pricing' },
      },
    },
  ],
  click: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c07',
        type: 'click',
        t: 7000,
        ...page,
        point: { x: 900, y: 354 },
        selector: cta.selector,
        tag: 'button',
        name: 'Get started',
      },
    },
  ],
  navigation: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c08',
        type: 'navigation',
        t: 7200,
        url: 'http://localhost:4401/signup.html',
        title: 'Sign up',
        overlay: 'page',
      },
    },
  ],
  tab_switch: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c09',
        type: 'tab_switch',
        t: 8000,
        to_tab_id: 101737480,
        to_title: 'Docs',
        away: true,
      },
    },
  ],
  scroll_settle: [{ event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c10', type: 'scroll_settle', t: 8500, ...page } }],
  overlay_cleared: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c11',
        type: 'overlay_cleared',
        t: 9000,
        url: URL,
        strokes: 3,
        picks: 1,
        comments: 1,
      },
    },
  ],
  viewport_change: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c12',
        type: 'viewport_change',
        t: 9500,
        width: 390,
        height: 844,
        scale: 0.85,
        mechanism: 'frame_host',
      },
    },
  ],
  screenshot: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c13',
        type: 'screenshot',
        t: 2600,
        screenshot_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d41',
        path: 'screenshots/b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d41.png',
        mime: 'image/png',
        trigger: 'annotation',
        annotation_id: 'a1',
        ...page,
      },
    },
  ],
  transcript_segment: [
    {
      // The live transcript: what was said around Annotation 1.
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c14',
        type: 'transcript_segment',
        t: 900,
        segment_id: 'seg-1',
        t_end: 2400,
        text: 'this button should go in the header',
        engine: 'webspeech',
        local: false,
        timestamp_quality: 'word',
        words: [
          { text: 'this', t: 900, t_end: 1100 },
          { text: 'button', t: 1100, t_end: 1400 },
        ],
        confidence: 0.93,
        run_id: null,
        target: null,
      },
    },
    {
      // Dictated into Annotation 2's comment box (E11): its comment, not the transcript.
      variant: 'dictation',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c15',
        type: 'transcript_segment',
        t: 4200,
        segment_id: 'seg-2',
        t_end: 5000,
        text: 'make this roomier',
        engine: 'webspeech',
        local: false,
        timestamp_quality: 'approximate',
        words: null,
        confidence: null,
        run_id: null,
        target: { annotation_id: 'a2' },
      },
    },
    {
      variant: 'dictation_comment',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c16',
        type: 'transcript_segment',
        t: 10100,
        segment_id: 'seg-4',
        t_end: 10600,
        text: 'this should say plans',
        engine: 'webspeech',
        local: false,
        timestamp_quality: 'approximate',
        words: null,
        confidence: null,
        run_id: null,
        target: { comment_id: 'c1' },
      },
    },
    {
      // A re-transcription from the review page.
      variant: 'rerun',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c17',
        type: 'transcript_segment',
        t: 900,
        segment_id: 'run1-seg-1',
        t_end: 2400,
        text: 'This button should go in the header.',
        engine: 'whisper',
        local: true,
        timestamp_quality: 'word',
        words: [{ text: 'This', t: 900, t_end: 1100 }],
        confidence: 0.88,
        run_id: 'run-1',
        target: null,
      },
    },
  ],
  transcription_fallback: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c18',
        type: 'transcription_fallback',
        t: 200,
        from: 'deepgram',
        to: 'webspeech',
        reason: 'no API key',
      },
    },
  ],
  transcription_run: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c19',
        type: 'transcription_run',
        t: 30000,
        run_id: 'run-1',
        engine: 'whisper',
        local: true,
        timestamp_quality: 'word',
        model: 'onnx-community/whisper-base_timestamped',
        segment_count: 1,
        created_at: '2026-09-23T10:05:00.000Z',
      },
    },
  ],
  transcript_select: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c20',
        type: 'transcript_select',
        t: 30000,
        run_id: 'run-1',
        edited_at: '2026-09-23T10:06:00.000Z',
      },
    },
  ],
  transcript_edit: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c21',
        type: 'transcript_edit',
        t: 30000,
        segment_id: 'seg-1',
        text: 'this button should go in the site header',
        edited_at: '2026-09-23T10:07:00.000Z',
      },
    },
  ],
  speech_activity: [
    { event: { id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c22', type: 'speech_activity', t: 880, t_end: 2450 } },
  ],
  voice_command: [
    {
      // The ids the older hand-written fixture had: "scratch that" aimed at Annotation a2.
      event: {
        id: '5b1e0c9a-2f4d-4a8e-9c3b-7d6e5f4a3b21',
        type: 'voice_command',
        t: 5300,
        t_end: 5900,
        command: 'scratch_that',
        phrase: 'scratch that',
        segment_id: 'seg-2',
        target: { kind: 'annotation', id: 'a2' },
      },
    },
    {
      variant: 'pin_that',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c23',
        type: 'voice_command',
        t: 11000,
        t_end: 11400,
        command: 'pin_that',
        phrase: 'pin that',
        segment_id: 'seg-5',
        target: { kind: 'draft_item', id: 'd1' },
      },
    },
    {
      // Heard while paused: no segment, no target.
      variant: 'resume',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c24',
        type: 'voice_command',
        t: 14900,
        t_end: 15000,
        command: 'resume',
        phrase: 'resume',
        segment_id: null,
        target: null,
      },
    },
  ],
  text_comment: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c25',
        type: 'text_comment',
        t: 10000,
        comment_id: 'c1',
        index: 1,
        t_end: 10800,
        selected_text: 'Ship reviews',
        anchor: { exact: 'Ship reviews', prefix: 'Pricing ', suffix: ' faster' },
        element: {
          selector: 'main .hero h1',
          tag: 'h1',
          role: 'heading',
          name: 'Pricing Ship reviews faster',
          text: 'Pricing Ship reviews faster',
          testid: 'hero-title',
          id: 'hero-title',
          classes: ['title'],
          bbox: { x: 100, y: 220, width: 600, height: 60 },
        },
        comment: 'This should say Plans',
        bbox: { x: 180, y: 230, width: 140, height: 40 },
        ...page,
        screenshot_id: 'b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d44',
      },
    },
  ],
  draft_item: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c26',
        type: 'draft_item',
        t: 3000,
        draft_id: 'd1',
        pass_id: 'pass-1',
        model: 'claude-haiku-4-5-20251001',
        title: "Move 'Get started' into the header",
        category: 'layout',
        intent: 'The primary CTA should sit in the site header.',
        transcript: 'this button should go in the header',
        locations: [
          { role: 'subject', element: "button 'Get started'", selector: cta.selector, annotation: 1 },
          { role: 'destination', element: 'site header', selector: null, annotation: null },
        ],
        annotation_ids: ['a1'],
      },
    },
  ],
  draft_action: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c27',
        type: 'draft_action',
        t: 11400,
        draft_id: 'd1',
        action: 'pin',
        source: 'voice',
      },
    },
  ],
  item_edit: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c28',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:08:00.000Z',
        edit: {
          op: 'edit',
          item_id: 'item_0001',
          changes: {
            title: 'Make Get started larger',
            intent: 'Make the CTA the most prominent element.',
            category: 'style',
            agent_prompt: 'Enlarge the CTA. See screenshots/shot-1.png.',
            ambiguity: 'How much larger is not said.',
          },
          origin: 'combine',
        },
      },
    },
    {
      variant: 'delete',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c29',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:09:00.000Z',
        edit: { op: 'delete', item_id: 'item_0003' },
      },
    },
    {
      variant: 'merge',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c30',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:10:00.000Z',
        edit: { op: 'merge', into: 'item_0001', from: 'item_0002' },
      },
    },
    {
      variant: 'split',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c31',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:11:00.000Z',
        edit: { op: 'split', item_id: 'item_0001', new_id: 'item_0004' },
      },
    },
    {
      variant: 'reorder',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c32',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:12:00.000Z',
        edit: { op: 'reorder', order: ['item_0004', 'item_0001'] },
      },
    },
    {
      variant: 'undo',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c3a',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:13:00.000Z',
        edit: { op: 'undo' },
      },
    },
    {
      variant: 'redo',
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c3b',
        type: 'item_edit',
        t: 30000,
        run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
        edited_at: '2026-09-23T10:14:00.000Z',
        edit: { op: 'redo' },
      },
    },
  ],
  session_end: [
    {
      event: {
        id: 'e1a4c1d2-0b6f-4d52-9d64-5e3a2f1b0c33',
        type: 'session_end',
        t: 29000,
        reason: 'stop',
        duration_ms: 29000,
      },
    },
  ],
};

/** A Change Item with every optional field filled: the `items` push. */
export const ITEM: ChangeItem = {
  id: 'item_0001',
  title: 'Make the Get started button larger',
  category: 'style',
  intent: 'The primary call to action is too small to notice; make it the most prominent element in the hero.',
  locations: [
    {
      role: 'subject',
      selector: 'main .hero a.cta',
      element: "link 'Get started'",
      url: '/',
      screenshot: 'shot-1',
      annotation: 1,
      source: { file: 'src/components/Hero.tsx', line: 42, components: ['CallToAction', 'Hero'] },
    },
    { role: 'reference', selector: null, element: 'the header links', url: '/', screenshot: null, annotation: null },
  ],
  evidence: { video: { start: 2.5, end: 7 }, screenshots: ['shot-1'], crops: ['shot-1.crop'] },
  transcript: 'this button is way too small ... make it bigger',
  confidence: 0.55,
  ambiguity: 'How much larger is not said.',
  agent_prompt:
    "On the home page, enlarge the hero link 'Get started' (main .hero a.cta) so it is the most prominent element. See screenshots/shot-1.png.",
  pinned: false,
  style_changes: [
    {
      annotation: 1,
      selector: 'main .hero a.cta',
      changes: { 'font-size': { from: '14px', to: '18px' } },
      text: { from: 'Get started', to: 'Start free' },
    },
  ],
  source: 'reviewer',
};

/** File name → message, in a stable order. */
export function eventFixtures(): Map<string, EventMessage | ItemsMessage> {
  const files = new Map<string, EventMessage | ItemsMessage>();
  let n = 10;
  // The three older fixtures keep their message ids.
  const kept: Record<string, string> = {
    'event.session_start.json': 'm-2',
    'event.stroke.json': 'm-3',
    'event.voice_command.json': 'm-4',
  };
  for (const [type, samples] of Object.entries(SAMPLES) as [EventType, Sample<EventType>[]][]) {
    for (const { variant, event } of samples) {
      const file = `event.${type}${variant ? `.${variant}` : ''}.json`;
      files.set(file, { v: 1, type: 'event', id: kept[file] ?? `m-${n++}`, session_id: SESSION_ID, event });
    }
  }
  files.set('items.json', {
    v: 1,
    type: 'items',
    id: 'c-9',
    session_id: '0b5f7d4e-3f0e-4a8e-9a57-6e1f2d0c9b11',
    run_id: '5a1c9e2b-8d4f-4b7a-a3c6-2f9e0d1b7c44',
    items: [ITEM],
  });
  return files;
}

export const render = (message: unknown) => `${JSON.stringify(message, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [file, message] of eventFixtures()) writeFileSync(join(FIXTURES, file), render(message));
  console.log(`wrote ${eventFixtures().size} fixtures to ${FIXTURES}`);
}

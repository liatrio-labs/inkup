// LLM adapter interface (docs/PLAN.md: Anthropic behind an adapter; P1-3 adds OpenAI-compatible). The Vercel AI
// Gateway serves the same Messages API, so the Anthropic adapter covers it with another base URL and key.
// Adapters are plain TypeScript: the service worker runs them for the extension and `pnpm eval` runs the same
// code in Node.
import type { ChangeItem } from '@inkup/core/process/change-item';
import type { CombinedChanges } from '@inkup/core/process/combine';
import type { CostEstimate } from '@inkup/core/process/cost';
import type { DraftOutputItem, DraftPromptInput } from '@inkup/core/process/draft';
import type { SessionDocument } from '@inkup/core/session-document';

export interface ScreenshotImage {
  media_type: 'image/png' | 'image/jpeg' | 'image/webp';
  /** base64, no data: prefix. */
  data: string;
}

/**
 * The Messages API's `output_config.effort` (platform.claude.com/docs/en/build-with-claude/effort). Absent: not
 * sent, so the model runs at its own default. A model without effort support answers 400, shown as any API error.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One recording sent with a video-grounded Process call. */
export interface MediaFile {
  /** e.g. video/webm, audio/webm. */
  media_type: string;
  /** The file part's name, e.g. video.webm. */
  filename: string;
  /** base64, no data: prefix. */
  data: string;
  /** Decoded size. */
  bytes: number;
  /** Recorder start, ms since t0. */
  start_offset_ms: number;
  duration_ms: number | null;
}

/** The Session's recording, for a Process model that takes video. */
export interface ProcessMedia {
  video: MediaFile;
  /** The microphone; null when the Session has none. */
  audio: MediaFile | null;
}

export interface ProcessInput {
  doc: SessionDocument;
  model: string;
  effort?: Effort;
  /**
   * Screenshot and element-crop bytes by stored id, for vetting against screenshots. Absent or null for an id: that
   * image is left out.
   */
  loadScreenshot?: (screenshotId: string) => Promise<ScreenshotImage | null>;
  /**
   * The recording, when the Process model takes video (the Gateway's chat endpoint): each window's main call and its
   * vetting call carry it. Absent: the script alone, and screenshots for vetting.
   */
  media?: ProcessMedia | null;
  /** Check every item against the recording after Process (vetting). Default false. */
  vet?: boolean;
  /** Called as chunks are planned, stream items, finish or split (the review page's in-progress cards). */
  onProgress?: (progress: ChunkProgress) => void;
}

/** Where one Process chunk is. Items are those complete so far (`streaming`) or the chunk's answer (`done`). */
export interface ChunkProgress {
  /** Stable id within the run; a split chunk's halves get new ids. */
  chunk: number;
  /** Core range in ms; `end` null for the last chunk. */
  start: number;
  end: number | null;
  status: 'queued' | 'streaming' | 'done' | 'split';
  items: ChangeItem[];
}

export interface CallRecord {
  /** `truncated`: the answer stopped at max_tokens and was dropped (a Process chunk is then split). */
  kind:
    | 'main'
    | 'repair'
    | 'second_pass'
    | 'second_pass_repair'
    | 'draft'
    | 'draft_repair'
    | 'combine'
    | 'combine_repair'
    | 'vet'
    | 'vet_repair'
    | 'truncated';
  input_tokens: number;
  output_tokens: number;
  /** Process: the chunk this call ran for (vetting: the window). */
  chunk?: number;
  /** The call went to the Gateway's chat endpoint with the recording attached. */
  video?: boolean;
  /** Process: estimateOutputTokens for the chunk, to calibrate it against output_tokens. */
  estimated_output?: number;
}

export interface ProcessResult {
  items: ChangeItem[];
  model: string;
  calls: CallRecord[];
  /** Ids of items that went through the old low-confidence screenshot pass; vetting replaced it, so always empty. */
  second_pass: string[];
  /** The recording went with the calls (video-grounded Process). */
  video: boolean;
  /** Pinned Draft Items the model left out, added in code (packages/core/src/process/pins.ts). */
  pins_converted: string[];
  /** Model items dropped as rewrites of a pinned Draft Item. */
  pins_dropped: string[];
  /** Process chunks the answer came from (packages/core/src/process/sections.ts), after any split. */
  windows: number;
  /** Items merged away as duplicates from a window's overlap. */
  duplicates_merged: { kept: string; dropped: { window: number; id: string } }[];
  /** Annotations the model said no item comes from, with its reason. */
  dropped_annotations: { annotation: number; reason: string }[];
  /** Live Annotations no item uses and the model did not list as dropped. Empty for windowed runs. */
  unaccounted_annotations: number[];
}

export interface DraftInput extends DraftPromptInput {
  model: string;
  effort?: Effort;
}

export interface DraftResult {
  /** Each proposed Draft Item with the ids of the Annotations it covers. */
  items: (DraftOutputItem & { annotation_ids: string[] })[];
  calls: CallRecord[];
  /** Nothing new to draft: no call was made. */
  skipped: boolean;
}

export interface CombineInput {
  /** The two items as they were before the merge; `into` keeps its id. */
  into: ChangeItem;
  from: ChangeItem;
  model: string;
  effort?: Effort;
}

export interface CombineResult {
  /** The merged item's new words, stored ids restored; logged as an `edit` op with `origin: 'combine'`. */
  changes: CombinedChanges;
  calls: CallRecord[];
}

export type ProcessErrorCode = 'invalid_output' | 'refusal' | 'max_tokens' | 'auth' | 'rate_limit' | 'api' | 'network';

export class ProcessError extends Error {
  constructor(
    readonly code: ProcessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
}

export interface EstimateInput extends Omit<ProcessInput, 'loadScreenshot' | 'media' | 'onProgress'> {
  /** The recording will go with the calls: its length is added as media tokens. */
  video?: boolean;
}

export interface LlmAdapter {
  /** Token count from the provider's counter × the dated price table, with vetting and media when set. */
  estimate(input: EstimateInput): Promise<CostEstimate>;
  process(input: ProcessInput): Promise<ProcessResult>;
  /** One live Draft Item pass (P0-10): text only, small model, same structured output and repair retry. */
  draft(input: DraftInput): Promise<DraftResult>;
  /** Two merged Change Items rewritten as one request (E12): text only, small model, one repair retry. */
  combine(input: CombineInput): Promise<CombineResult>;
  /** A cheap real call per model: proves the key and the model IDs work. */
  test(models: readonly string[]): Promise<ConnectionTest>;
}

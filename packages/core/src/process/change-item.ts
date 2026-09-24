// Change Item (PRD P0-11, §12): the implementer-facing output of Process. The same schema validates the
// model's structured output, what the review page stores, and `change_items` in session.json.
//
// Screenshot ids: inside the prompt and the model's output they are short aliases (s1, s2, …) so the model
// never has to copy a UUID. restoreScreenshotIds() (script.ts) maps them back to the stored ids before an item
// is saved, so a stored item cites `screenshots/<screenshot_id>.png`, the path inside an export folder.
import { z } from 'zod';
import { AnnotationSource, Category, LocationRole, SourceSchema, ValueChangeSchema } from '../timeline.ts';

export const LOW_CONFIDENCE = 0.6;

// The role enum lives with the timeline, because Draft Items carry Locations too.
export { LocationRole } from '../timeline.ts';

export const LocationSchema = z.object({
  role: LocationRole.describe(
    'subject: what changes; reference: what it should match or relate to; destination: where it goes',
  ),
  selector: z
    .string()
    .nullable()
    .describe('CSS selector of the chosen Candidate; null when only a region or the whole page is meant'),
  element: z.string().describe("short human description, e.g. button 'Get started' or nav region right of link 'Docs'"),
  url: z.string().describe('page path (or full URL when on another origin) where the Location is'),
  screenshot: z.string().nullable().describe('screenshot id showing this Location'),
  annotation: z.number().int().positive().nullable().describe('Annotation number (#n) this Location came from'),
});
export type Location = z.infer<typeof LocationSchema>;

export const EvidenceSchema = z.object({
  video: z
    .object({ start: z.number().nonnegative(), end: z.number().nonnegative() })
    .nullable()
    .describe('Session time range in seconds covering the speech and Annotations of this item'),
  screenshots: z.array(z.string()).describe('ids of every screenshot that shows this item'),
});

/** Exact changes recorded for an Annotation's element, passed through from its latest `style_edit` event, never written by the model. */
export const StyleChangeSchema = z.object({
  annotation: z.number().int().positive().describe('the Annotation (#n) whose element the changes are for'),
  selector: z.string().describe("the element's selector"),
  changes: z.record(z.string(), ValueChangeSchema).describe('CSS property (kebab-case) → from/to'),
  text: ValueChangeSchema.optional().describe("the element's text, when it should say something else"),
});
export type StyleChange = z.infer<typeof StyleChangeSchema>;

/** Screenshot references an agent_prompt must contain, e.g. `screenshots/s7.png`. */
export const screenshotCitation = (id: string) => `screenshots/${id}.png`;

const ChangeItemObject = z.object({
  id: z.string().min(1).describe('item_0001, item_0002, … in output order'),
  title: z.string().min(1).describe('imperative, under ~80 chars'),
  category: Category,
  intent: z.string().min(1).describe('what the reviewer wants and why, one or two sentences'),
  locations: z.array(LocationSchema).min(1),
  evidence: EvidenceSchema,
  transcript: z.string().describe('the reviewer words this item came from, verbatim, joined with " ... "'),
  confidence: z.number().min(0).max(1),
  ambiguity: z
    .string()
    .optional()
    .describe(`required when confidence < ${LOW_CONFIDENCE}: what is unclear, one sentence`),
  agent_prompt: z
    .string()
    .min(1)
    .describe('self-contained instruction for a coding agent; cites every evidence screenshot as screenshots/<id>.png'),
  pinned: z.boolean().default(false),
  style_changes: z
    .array(StyleChangeSchema)
    .optional()
    .describe('exact style and text changes recorded for elements this item covers; agent_prompt states each one'),
});

// Grounding (./grounding.ts): after Process, the extension copies what the Session recorded onto each item: a
// Location's `source` from its Candidate, the element crops of its Annotations. The model is never asked for these,
// so its output schema (ChangeItemsOutputSchema) leaves them out; stored items and session.json carry them.
export const GroundedLocationSchema = LocationSchema.extend({
  source: SourceSchema.optional().describe(
    "the chosen Candidate's source (file, line, components), when the page reported one",
  ),
});
export type GroundedLocation = z.infer<typeof GroundedLocationSchema>;

const GroundedEvidenceSchema = EvidenceSchema.extend({
  crops: z
    .array(z.string())
    .optional()
    .describe('ids of element crops (screenshots/<id>.png) of the Annotations this item uses'),
});

const StoredChangeItemObject = ChangeItemObject.extend({
  locations: z.array(GroundedLocationSchema).min(1),
  evidence: GroundedEvidenceSchema,
  source: AnnotationSource.optional().describe(
    "'page_api': every Annotation it comes from was made by a script on the page, not the reviewer; absent: the reviewer",
  ),
});

/** Rules structured output cannot express. The repair retry sends these messages back to the model. */
function refine(item: z.infer<typeof ChangeItemObject>, ctx: z.RefinementCtx) {
  if (item.confidence < LOW_CONFIDENCE && !item.ambiguity?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['ambiguity'],
      message: `ambiguity is required when confidence < ${LOW_CONFIDENCE}`,
    });
  }
  if (!item.locations.some((l) => l.role === 'subject')) {
    ctx.addIssue({ code: 'custom', path: ['locations'], message: 'at least one Location must have role "subject"' });
  }
  item.evidence.screenshots.forEach((id, i) => {
    if (!item.agent_prompt.includes(screenshotCitation(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['agent_prompt'],
        message: `agent_prompt must cite evidence screenshot ${i} as ${screenshotCitation(id)}`,
      });
    }
  });
  const v = item.evidence.video;
  if (v && v.end < v.start)
    ctx.addIssue({ code: 'custom', path: ['evidence', 'video'], message: 'video.end must be >= video.start' });
}

/** A Change Item as stored, pushed to the Host and exported: the model's item plus its grounding. */
export const ChangeItemSchema = StoredChangeItemObject.superRefine(refine);
/** What the model answers: no grounding fields and no style_changes. */
export const ModelChangeItemSchema = ChangeItemObject.omit({ style_changes: true }).superRefine(refine);
export type ChangeItem = z.infer<typeof ChangeItemSchema>;
export type ChangeItemInput = z.input<typeof ChangeItemSchema>;

export const DroppedAnnotationSchema = z.object({
  annotation: z.number().int().positive().describe('Annotation number (#n) no item uses'),
  reason: z.string().min(1).describe('one sentence: why no Change Item comes from it'),
});

/**
 * Structured output root: the API needs an object, so the array is wrapped. `dropped_annotations` lets the model say
 * which Annotations it used for nothing and why, so a long Session is never truncated silently (./windows.ts).
 */
export const ChangeItemsOutputSchema = z.object({
  // style_changes come from the timeline, not the model (./style-changes.ts).
  items: z.array(ModelChangeItemSchema),
  dropped_annotations: z
    .array(DroppedAnnotationSchema)
    .optional()
    .describe('Annotations (not DISCARDED) that no item uses, each with a reason'),
});
export type ChangeItemsOutput = z.infer<typeof ChangeItemsOutputSchema>;

export const isLowConfidence = (item: Pick<ChangeItem, 'confidence'>) => item.confidence < LOW_CONFIDENCE;

/** Review order (P0-12): low-confidence items first, otherwise the model's order. Stable. */
export function sortForReview<T extends Pick<ChangeItem, 'confidence'>>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => Number(isLowConfidence(b.item)) - Number(isLowConfidence(a.item)) || a.i - b.i)
    .map((x) => x.item);
}

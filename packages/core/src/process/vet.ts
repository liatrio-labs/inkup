// Vetting: after Process, every Change Item is checked against the recording and flagged (confirmed, corrected or
// unverified). With a model that takes video the check watches the footage and hears the audio; otherwise it looks
// at each item's screenshots and element crops. One call per Process window, all of that window's items at once.
//
// The model answers a verdict per item and, for `corrected`, the whole rewritten item. A correction goes through
// the same checks as the Process answer (the item rules and checkAgainstSession); one that fails keeps the original,
// marked unverified with the reason. Pinned items are the reviewer's own: they can be flagged, never rewritten.
import { z } from 'zod';
import {
  type ChangeItem,
  ModelChangeItemObject,
  ModelChangeItemSchema,
  type Vetting,
  VetVerdict,
} from './change-item.ts';
import { checkAgainstSession, restoreScreenshotIds, type ScriptContext } from './script.ts';

export const VetResultSchema = z.object({
  id: z.string().min(1).describe('the id of the item checked, exactly as given'),
  verdict: VetVerdict,
  reason: z.string().min(1).describe('one sentence: what the recording shows, or what could not be confirmed'),
  // The item rules (ambiguity, citations) are checked in code, so a bad correction is rejected instead of repaired.
  item: ModelChangeItemObject.optional().describe(
    'required when verdict is corrected: the whole item rewritten to match the recording, same id',
  ),
});
export type VetResult = z.infer<typeof VetResultSchema>;

export const VetOutputSchema = z.object({
  results: z.array(VetResultSchema).describe('one result per item checked, in the order given'),
});
export type VetOutput = z.infer<typeof VetOutputSchema>;

/** The vetting call's system prompt. `video`: the recording is attached; otherwise screenshots are. */
export function buildVetSystemPrompt(video: boolean): string {
  const evidence = video
    ? `The recording is attached: the reviewed tab's video (the page, the pointer, and the reviewer's red ink Strokes as they are drawn) and the microphone audio. The MEDIA block says how file time maps to the Session time used in the script and in each item's evidence.video.`
    : `Screenshots are attached, each labelled with its id: the page as it was when an Annotation closed, with the reviewer's Strokes in red, and close-ups cropped to the marked element. Not every item has one.`;
  return `You check Change Items against the recording of the review they were written from. The Change Items were written by another pass from a text script of the review (speech, Annotations, clicks), which can pair the wrong words with the wrong mark, pick the wrong element, or mishear.

## Evidence
${evidence}
The script of the review is included too, for the selectors (Candidates) and times.

## For each item
- confirmed: the recording shows the reviewer asking for this, about these elements. Minor wording differences are fine.
- corrected: something the recording shows is wrong: the element (subject, reference or destination), the request itself, the category, or the transcript. Return the whole item rewritten in "item", with the same id and the same rules as the original: Locations use selectors from the script's Candidates, every evidence screenshot is cited in the agent_prompt as screenshots/<id>.png, and ambiguity is set when confidence < 0.6.
- unverified: the recording cannot confirm it: the moment is not visible or audible, or no screenshot shows it. Do not guess.
- "reason": one sentence saying what you saw or heard, or what is missing.
- Items marked "pinned": true were confirmed by the reviewer: never correct them. Answer confirmed or unverified.
- Answer exactly one result per item, with its id. Do not add, merge or drop items.

Answer with JSON only: {"results": [{"id": "...", "verdict": "...", "reason": "...", "item": {...}}]} ("item" only for corrected).`;
}

/** The user turn's text: the script, then the items (screenshot ids as aliased in the script). */
export function buildVetMessage(
  script: string,
  items: readonly ChangeItem[],
  opts: { media?: string; attached?: readonly string[] } = {},
): string {
  const parts: string[] = [];
  if (opts.media) parts.push(opts.media);
  if (opts.attached)
    parts.push(
      opts.attached.length
        ? `Screenshots attached above, in order: ${opts.attached.join(', ')}.`
        : 'No screenshots are available: answer unverified unless the script alone settles it.',
    );
  parts.push(`The script of the review:\n\n${script}`);
  parts.push(`The Change Items to check (${items.length}):\n\n${JSON.stringify(items, null, 2)}`);
  return parts.join('\n\n');
}

const unverified = (reason: string): Vetting => ({ verdict: 'unverified', reason });

/**
 * The window's items with their verdicts applied. `items` carry stored screenshot ids; a correction's are aliases
 * (as in `ctx`) and are restored. Pinned items keep every word.
 */
export function applyVetResults(
  items: readonly ChangeItem[],
  results: readonly VetResult[],
  ctx: ScriptContext,
): ChangeItem[] {
  return items.map((item) => {
    const r = results.find((x) => x.id === item.id);
    if (!r) return { ...item, vetting: unverified('The check gave no verdict for this item.') };
    if (r.verdict !== 'corrected') return { ...item, vetting: { verdict: r.verdict, reason: r.reason } };
    if (item.pinned)
      return {
        ...item,
        vetting: unverified(`Pinned during the Session, so it was not rewritten. The check said: ${r.reason}`),
      };
    if (!r.item) return { ...item, vetting: unverified(`The check sent no corrected item. It said: ${r.reason}`) };
    const parsed = ModelChangeItemSchema.safeParse({ ...r.item, id: item.id, pinned: false });
    const issues = parsed.success
      ? checkAgainstSession([parsed.data], ctx)
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (!parsed.success || issues.length)
      return {
        ...item,
        vetting: unverified(`The correction was rejected (${issues[0]}). The check said: ${r.reason}`),
      };
    const corrected = restoreScreenshotIds(parsed.data, ctx);
    return { ...corrected, id: item.id, pinned: false, vetting: { verdict: 'corrected', reason: r.reason } };
  });
}

/** Every item unverified with one reason (the check failed, or was not possible). */
export const markUnverified = (items: readonly ChangeItem[], reason: string): ChangeItem[] =>
  items.map((item) => ({ ...item, vetting: unverified(reason) }));

/** The vetting call's repair turn (its root is `results`, not `items`). */
export function buildVetRepairMessage(issues: readonly string[]): string {
  return `Your answer did not pass validation:\n${issues.map((i) => `- ${i}`).join('\n')}\nReturn the complete corrected JSON ({"results": [...]}), fixing only what is listed.`;
}

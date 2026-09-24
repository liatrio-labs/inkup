// Which Strokes the review page draws over an evidence screenshot. Several Annotations can share one screenshot;
// a Change Item's screenshot shows only the Strokes of the Annotations its Locations cite (feedback batch 1, U2).
// An item that cites no Annotation shows every Annotation on the screenshot.

export interface ShotAnnotation {
  index: number;
  screenshot_id: string | null;
  stroke_ids: readonly string[];
}

export function strokeIdsForShot(
  screenshotId: string,
  cited: readonly number[],
  annotations: readonly ShotAnnotation[],
): string[] {
  const onShot = annotations.filter((a) => a.screenshot_id === screenshotId);
  const shown = cited.length > 0 ? onShot.filter((a) => cited.includes(a.index)) : onShot;
  return shown.flatMap((a) => a.stroke_ids);
}

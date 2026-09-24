// Chrome's media context, the offscreen document (ADR 0001): mic, audio recorder and transcription live there
// because it has an unbounded lifetime; it cannot prompt for the mic, so onboarding obtains the grant first.
export const OFFSCREEN_PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

async function exists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen(): Promise<void> {
  if (await exists()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Records the reviewer microphone and transcribes it during a review Session.',
    })
    .finally(() => (creating = null));
  await creating;
}

export async function closeOffscreen(): Promise<void> {
  if (await exists()) await chrome.offscreen.closeDocument();
}

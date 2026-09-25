// getUserMedia for every extension page that opens the microphone: the offscreen document (capture and the ORT
// self-test) and onboarding. Chromium sometimes aborts a request it has already granted: the browser opens the
// device, the page's promise rejects with AbortError "Failed due to shutdown", and the renderer closes the device
// it no longer has a request for (ADR 0010). The page itself stays
// alive, and asking again succeeds. Only AbortError is retried; NotAllowedError, NotFoundError and the rest are real
// answers and are returned at once.

export const MIC_ABORT_RETRIES = 3;

/** Called before each retry, with the attempt that failed (0-based) and the error's message. */
export type MicRetryLog = (attempt: number, message: string) => void;

const defaultLog: MicRetryLog = (attempt, message) =>
  console.warn(`[var] getUserMedia aborted (${message}); retry ${attempt + 1} of ${MIC_ABORT_RETRIES}`);

export async function getUserMediaWithRetry(
  constraints: MediaStreamConstraints,
  opts: {
    gum?: (c: MediaStreamConstraints) => Promise<MediaStream>;
    wait?: (ms: number) => Promise<void>;
    log?: MicRetryLog;
  } = {},
): Promise<MediaStream> {
  const gum = opts.gum ?? ((c) => navigator.mediaDevices.getUserMedia(c));
  const wait = opts.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? defaultLog;
  for (let attempt = 0; ; attempt++) {
    try {
      return await gum(constraints);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError') || attempt >= MIC_ABORT_RETRIES) throw e;
      log(attempt, e.message);
      await wait(250 * (attempt + 1));
    }
  }
}

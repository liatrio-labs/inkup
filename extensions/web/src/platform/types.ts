// The browser-specific seams behind one interface. One WXT app builds every browser, each with a thin adapter in
// platform/<browser>/; the rest of the extension calls these instead of the browser's own APIs, so another
// browser's adapter swaps in without touching the Session code.

/** What this browser can do. A missing capability hides its UI instead of offering a broken control. */
export interface PlatformCapabilities {
  /** A long-lived context with a DOM for the mic, speech-to-text and voice detection (Chrome: offscreen document). */
  mediaContext: boolean;
  /** A browser-owned control surface the toolbar icon opens (Chrome: side panel). */
  controlSurface: boolean;
  /** Tab video from a user-picked surface (Chrome: getDisplayMedia). */
  tabVideo: boolean;
  /** PNG screenshots of a window's visible tab (Chrome: captureVisibleTab). */
  screenshots: boolean;
  /** The Web Speech API, the free default's live captions (absent in Firefox: Whisper or a paid tier instead). */
  speechRecognition: boolean;
  /**
   * How a Session started from the page's toolbar or the shortcut gets video, with no control-surface click
   * (docs/spikes/toolbar-start.md). 'tab_capture': the background mints a capture id for the tab and the media context
   * records it (Chrome; needs the extension invoked on the tab: the toolbar icon or Alt+Shift+R). 'frame_picker': the
   * toolbar's Start is an extension frame whose click opens the screen picker, and the frame records (Firefox).
   * 'none': audio, Strokes and screenshots only.
   */
  toolbarVideo: 'tab_capture' | 'frame_picker' | 'none';
  /**
   * The toolbar's viewport control can resize pages here (plan E6, docs/spikes/viewport.md): the page reloads into a
   * sized frame of our own page (the frame host), on sites that allow framing. False hides the control.
   */
  viewport: boolean;
  /**
   * Scan a Host's pairing QR code with the camera (ADR 0006): BarcodeDetector with QR support and a camera API, in
   * the page that asks. Chrome has BarcodeDetector on macOS, ChromeOS and Android; Firefox has none. False hides
   * Scan QR; typing the code or pasting the pair link still works.
   */
  qrScan: boolean;
}

/** Whether this page can scan a QR code with the camera: see `PlatformCapabilities.qrScan`. */
export function canScanQr(): boolean {
  return 'BarcodeDetector' in globalThis && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * A long-lived channel between the control surface and the background. It drops when either end goes away, which
 * is how closing the panel stops the Session (ADR 0001). `postMessage` throws once the channel is gone.
 */
export interface SurfacePort<Out, In> {
  postMessage(msg: Out): void;
  onMessage(listener: (msg: In) => void): void;
  onDisconnect(listener: () => void): void;
  disconnect(): void;
}

/** How a save ended. `downloadId` is the browser's download id where it has a downloads API, else null. */
export type SavedFile = { ok: true; downloadId: number | null } | { ok: false; error: string };

export interface Platform {
  capabilities(): PlatformCapabilities;

  /** The media context's lifetime: created at Start, closed at Stop. Idempotent both ways. */
  mediaContext: {
    ensure(): Promise<void>;
    close(): Promise<void>;
    /**
     * Where the user can close the media context (Safari's recorder window): `listener` runs when they do, but not
     * on `close()`. The microphone went with it, so the background stops the Session (#9). Absent elsewhere: an
     * offscreen document or a background frame cannot be closed by the user.
     */
    onClosed?(listener: () => void): void;
    /**
     * How often its recorder writes the audio, in ms, where that differs from the default (30 s). A media context the
     * user can close writes more often, since a close loses what was not written yet.
     */
    audioChunkMs?: number;
  };

  controlSurface: {
    /**
     * Makes the toolbar icon call `listener` (it toggles the page's floating toolbar) instead of opening the control
     * surface, which the toolbar's Open panel button and Alt+Shift+P still reach.
     */
    onActionClick(listener: (tab: chrome.tabs.Tab) => void): Promise<void>;
    /** Opens it in a window. Call it synchronously from the user gesture that asked (a command, a click). */
    open(windowId: number): Promise<void>;
  };

  /** Background ↔ control surface channels, by name. */
  surfacePort: {
    connect<Out, In>(name: string): SurfacePort<Out, In>;
    onConnect<Out, In>(name: string, listener: (port: SurfacePort<Out, In>) => void): void;
  };

  tabVideo: {
    /** False where this context has no screen picker. */
    available(): boolean;
    /**
     * Opens the screen picker with tabs offered first and the extension's own surfaces left out. Call it before
     * anything slow, while the click's transient activation is fresh. Rejects with NotAllowedError on cancel.
     */
    pick(limits: { maxWidth: number; maxFps: number }): Promise<MediaStream>;
    /**
     * 'tab_capture' only: a capture id for the tab's video, for the media context to open. Rejects unless the
     * extension was invoked on the tab (its icon or a shortcut) since the tab last navigated.
     */
    captureId?(tabId: number): Promise<string>;
  };

  /** A PNG data URL of the window's visible tab. */
  captureVisibleTab(windowId: number): Promise<string>;

  /**
   * Saves `blob` to the user's downloads as `filename`, from an extension page. Resolves when it has landed, or,
   * where the browser reports no download state (Safari), once it has been handed to the browser.
   */
  saveFile(blob: Blob, filename: string): Promise<SavedFile>;
}

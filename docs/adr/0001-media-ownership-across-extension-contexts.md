---
status: accepted; superseded in part by 0004 (Session ownership and the panel-close-is-Stop rule)
date: 2026-09-22
---

# Microphone and audio live in the offscreen document; video lives in the side panel; closing the panel stops the Session

A Manifest V3 extension has no single long-lived context with user activation. The offscreen document has unbounded
lifetime and survives service-worker termination, but can never hold a user gesture and cannot show permission prompts.
The side panel has gestures but its document is destroyed whenever the panel closes. We split media by what each context
can do: the offscreen document owns the microphone stream, speech recognition, the audio recorder and the silence
detector; the window-scoped side panel owns `getDisplayMedia` and the video recorder, because the Start click there
satisfies the user-activation requirement Chrome is moving to enforce. A one-time onboarding tab obtains the microphone
grant, since neither context can prompt for it. Closing the side panel is treated as Stop rather than as a failure, so
the only way to lose the panel's video is a deliberate act that also finalizes everything.

**Which microphone.** The media context also owns the choice of input. Its device list is its own
(`enumerateDevices` there, never in the page, whose permissions and deviceIds are another origin's), sent to the service
worker at the microphone's start, on `devicechange` and after a switch, and pushed to the toolbar's picker
(`ToolbarState.mic`). Before a Session the picker lists on demand: on Chrome the offscreen document is opened to list
the inputs and closed again unless a Session started meanwhile; where the browser hides their names from a document
that has not used the microphone, the default opens for as long as the list takes. Without the grant the picker says
so and offers setup instead of a list. The choice is `micDevice` (`storage.local`); a Start opens it with
`deviceId: { exact }`, and one that is gone (OverconstrainedError, NotFoundError) opens the system default with a
warning, never failing the Session. The chosen device feeds a Web Audio graph whose `MediaStreamAudioDestinationNode`
track is the Session's stable mic stream (`offscreen/mic-source.ts`): the recorder and the transcription adapter (Web
Speech through `start(track)`) hold that track, so a pick mid-Session swaps only the graph's source node and releases
the old device; nothing restarts and the audio file is not split. The 16 kHz PCM graph (VAD, streaming tiers) is
another AudioContext, and a track carried between contexts arrives in gaps, so it reads the raw device stream and
swaps its own source node on a switch. Mute disables the stable track and the raw one. Where the graph's context does
not run by 250 ms after the device opened (Firefox with no sound server), the raw device stream is used as before and
the picker hides mid-Session. The picker is offered where `PlatformCapabilities.micPicker` says so: Chrome and
Firefox, not Safari, whose media context is a visible window.

## Considered options

- Everything in the offscreen document: simplest lifetime, but `getDisplayMedia` there has no activation and will break
  when Chrome enforces it (chromestatus 5090735022407680), and the picker cannot target the reviewed tab from there.
- Everything in the side panel: one context, but a panel close or crash ends audio too, and long-lived work has no home.

## Consequences

- Session state must be owned by the service worker and rebuilt in the panel on reopen.
- Firefox has no offscreen document; the port will move the offscreen role to the background page.

## History

- 2026-10-13: the media context always opened the system default microphone, and the reviewer could not tell which
  input live transcription heard. The toolbar's microphone picker and the stable graph stream above replaced that.

## Sources

- Offscreen lifetime and reasons: <https://developer.chrome.com/docs/extensions/reference/api/offscreen> ; <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/sDNbgeVHEEw>
- Offscreen cannot prompt for the microphone: <https://github.com/GoogleChrome/chrome-extensions-samples/issues/821> ; <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM>
- SpeechRecognition allowed in offscreen and side panel: <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/speech/chrome_speech_recognition_manager_delegate.cc>
- Side panel view destroyed on close: <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/extensions/extension_side_panel_coordinator.h>
- Activation requirement flag: <https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5>

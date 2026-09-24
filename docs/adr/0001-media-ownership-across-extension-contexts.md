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

## Considered options

- Everything in the offscreen document: simplest lifetime, but `getDisplayMedia` there has no activation and will break
  when Chrome enforces it (chromestatus 5090735022407680), and the picker cannot target the reviewed tab from there.
- Everything in the side panel: one context, but a panel close or crash ends audio too, and long-lived work has no home.

## Consequences

- Session state must be owned by the service worker and rebuilt in the panel on reopen.
- Firefox has no offscreen document; the port will move the offscreen role to the background page.

## Sources

- Offscreen lifetime and reasons: <https://developer.chrome.com/docs/extensions/reference/api/offscreen> ; <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/sDNbgeVHEEw>
- Offscreen cannot prompt for the microphone: <https://github.com/GoogleChrome/chrome-extensions-samples/issues/821> ; <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM>
- SpeechRecognition allowed in offscreen and side panel: <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/speech/chrome_speech_recognition_manager_delegate.cc>
- Side panel view destroyed on close: <https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/ui/extensions/extension_side_panel_coordinator.h>
- Activation requirement flag: <https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5>

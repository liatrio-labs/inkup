# InkUp privacy policy

InkUp is a browser extension for reviewing a web page out loud: you talk and draw on the page, and it turns the
recording into a list of changes. This page says what it collects, where that data goes and how to delete it. It
covers the extension (Chrome, Firefox, Safari) and the optional InkUp host (the `inkup` CLI and desktop app).

## What InkUp records

Only while you run a Session, which you start and stop yourself:

- your microphone audio and a transcript of it;
- the tab's video, where the browser allows it, and screenshots of the page;
- the Strokes you draw, the page elements under them and the page URLs you visit during the Session;
- the text you type into InkUp's own comment boxes.

Keystrokes on the page are never captured. The extension does not read or change the page's content beyond the
elements you point at, and it records nothing when no Session is running.

## Where it goes

Everything stays on your device by default. Sessions are stored in the browser's local storage (IndexedDB) until
you delete them. InkUp has no server and no account, and it sends no analytics or telemetry.

Data leaves your device only when you turn on a feature that needs it, with your own key or host:

| You turn on | What is sent | To whom |
| --- | --- | --- |
| Paid transcription (Deepgram or ElevenLabs key) | Microphone audio while a Session is live | That provider |
| Processing with an Anthropic key | The Session's transcript, the element descriptions, and screenshots of low-confidence items | Anthropic |
| Pairing with an InkUp host | Sessions and Change Items | The host you paired with, on your own machine or network |
| The local Whisper model or a language pack | Nothing from you; the model is downloaded once | The model's host (Hugging Face) |

Each provider's own privacy policy covers what it does with the data it receives. InkUp shows a notice the first time
you turn on each of these.

## Sharing and sale

InkUp's authors never receive your data, and do not sell or share it. Nothing is used for advertising, credit
decisions or any purpose other than the feature you turned on.

## Deleting your data

Delete a Session from the Session list, or remove the extension to delete everything it stored. A paired host keeps
its copy in its own data directory until you delete it there.

## Contact

Questions: open an issue at <https://github.com/liatrio-labs/inkup/issues>.

Last updated 2026-09-25.

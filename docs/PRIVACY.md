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
| Models set to Anthropic, with an Anthropic key | Review text for live Draft Items, Process and Merge; screenshots and element close-ups when Process checks items | Anthropic |
| Models set to Vercel AI Gateway, with a Gateway key | The same review text and conditional images; recorded tab video and microphone audio when Process uses a video-capable model and the recording fits the size limit | Vercel AI Gateway, then the provider serving the selected model |
| Send Change Items to GitHub | The selected items' issue text and available evidence screenshots and element close-ups | GitHub, in the repository you choose |
| Send Change Items to Linear | The selected items' issue text and available evidence screenshots and element close-ups | Linear, in the team you choose; images go to the upload address returned by Linear |
| Send Change Items to Jira | The selected items' issue text and available evidence screenshots and element close-ups | Atlassian, on the Jira Cloud site and project you choose |
| Pairing with an InkUp host | Sessions and Change Items | The host you paired with, on your own machine or network |
| The local Whisper model or a language pack | Nothing from you; the model is downloaded once | The model's host (Hugging Face) |

### Model requests

Process, Draft and Merge each use their own configured provider and model. Without a key for that role, it makes
no model request; Process can build items locally. With a Draft key saved, starting a Session enables periodic live
Draft requests. Process estimates can already send review text for token counting before confirmation. The full run
asks for confirmation unless your saved auto-run threshold allows it. Merging items can send the selected items to
the configured Merge model.

Review text includes transcript excerpts, typed comments, page URLs, marked element descriptions and selectors,
drawing context and existing item text as needed for the operation. Draft and Merge are text-only. Process sends
images when the optional item check is enabled (enabled by default), rather than only for low-confidence items.
For Gateway video processing, an available recording at or below 20 MiB (video plus audio) accompanies Process and
its item checks. Otherwise Process uses text and, when checking items, screenshots and element close-ups.

The selected provider receives these requests using your saved key. Gateway requests also reach the model provider
through Vercel. InkUp does not control their storage, retention or access policies; consult the policies and account
settings of Vercel and the model provider you use.

### Tracker sharing and screenshot visibility

The extension and desktop app use the same tracker payloads. Saving tracker credentials does not send a Session
as an issue. Sending one or more Change Items creates issues
in the destination you choose. Issue text includes the title, intent, category, locations (page URLs, elements and
selectors), the item's transcript excerpt, agent prompt, ambiguity if present, Session name and item ID. Only the
available screenshots and element close-ups referenced by those items are uploaded; recordings are not attached.

- **GitHub:** screenshots are committed to the destination repository's `inkup-assets` branch and embedded in the
  issue. Their visibility follows repository access: anyone can see them in a public repository; a private
  repository requires repository access. They remain repository files and history, not just issue attachments.
- **Linear:** screenshots are uploaded through Linear's file-upload service and embedded using its returned asset
  URLs. Issue visibility follows the team's workspace permissions. Treat asset URLs as shared links; InkUp adds
  no access restriction to them and cannot promise they have the same access rules as the issue.
- **Jira:** screenshots are uploaded as attachments after the issue is created, then linked in its description.
  Access depends on the Jira site's project, issue and attachment permissions.

Uploads can succeed even if a later step fails. An unsuccessful send can therefore leave external images or an
issue behind. Tracker setup, destination lists, permission tests and linked-issue status checks also contact the
tracker with your credentials and destination or issue identifiers; they do not upload review recordings.

### Settings notices

The extension shows a one-time disclosure in Processing settings when you first save an Anthropic or Gateway key,
and in Trackers settings when you first save a tracker's credential field. These are settings notices, not a new
consent prompt before every request. Saving a key can also fetch the provider's model list. Each recipient's own
policies govern what it does with received data.

## Sharing and sale

InkUp sends no review data to its authors and includes no advertising or data-sale service. Configured providers,
paired hosts and tracker destinations receive data as described above; their handling and sharing rules apply to
those copies.

## Deleting your data

Delete a Session from the Session list, or remove the extension to delete everything it stored. A paired host keeps
its copy in its own data directory until you delete it there. Local Session deletion does not delete provider
records, tracker issues, uploaded images or GitHub's `inkup-assets` files and history. Manage those copies with the
recipient's own deletion and retention controls.

## Contact

Questions: open an issue at <https://github.com/liatrio-labs/inkup/issues>.

Last updated 2026-10-11.

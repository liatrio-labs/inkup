# InkUp

A browser extension that records a spoken, drawn-on review of a web page and turns it into a list of located changes an
implementer (human or agent) can act on.

## Language

### Capture

**Session**:
One recorded review, bound to one browser tab from Start to Stop, whatever URLs that tab visits in between.
_Avoid_: Recording, review cycle, run

**Toolbar**:
The floating control bar the extension adds to the page under review (the timer; Draw, Object Select, Select Text, Snap
and the viewport sizes; then Mute, Pause, Stop and Cancel), the main way to run a Session in every browser. It is never
in a screenshot. The panel is optional. From Start until the page has the Session it says "Starting…", so it never says
Recording while the page's modes would not answer.
_Avoid_: Widget, HUD, controls, floating panel

**Cancel**:
Ending a Session by throwing it away: capture stops at once and, unless the reviewer undoes it within a few seconds, the
Session is deleted everywhere, the Host included. Undo keeps it as if it had been stopped.
_Avoid_: Discard (the button says Cancel), abort, delete

**Mute**:
Turning the microphone off during a Session without pausing it: the audio records silence and nothing said is
transcribed or heard as a Voice Command, while drawing, picks, screenshots and video go on. The timeline logs
`mic_muted` and `mic_unmuted`.
_Avoid_: Pause (which stops everything), silence

**Voice-less Session**:
A Session recorded without a microphone, because setup never granted one or the reviewer skipped it: ink, picks, Text
Comments, typed notes, screenshots and video, but no audio, transcript or Voice Commands. The Toolbar shows "No mic" and
a "Turn on voice" button in place of Mute; turning voice on upgrades the running Session (`voice_on`). A drawn
Annotation opens a comment box for an optional typed note, since nothing says what it is about. `session_start.voice` is
false.
_Avoid_: Silent Session, text-only mode

**Box dictation**:
Speech that goes into an open Object Select or Select Text comment box instead of the Session transcript. In `auto` (the
default) a box dictates from the moment it opens; in `push` only while its mic button is on. Either way it works while
muted and the words become the comment's text; their segments carry a `target` (the Annotation or Text Comment) and are
never read as speech or Voice Commands.
_Avoid_: Voice typing, speech-to-comment

**Viewport size**:
The width and height, in CSS px, the page under review is resized to from the Toolbar (a preset, Fit to tab, a drag or a
typed size), so it lays out as it would on that screen. Annotations, screenshots and Change Items record the size they
were made at; `viewport_change` logs each change.
_Avoid_: Device, breakpoint, emulation (the Chrome mechanism, not the idea)

**Stroke**:
One continuous freehand mark, from pointer-down to pointer-up, drawn on the page overlay.
_Avoid_: Line, drawing, mark

**Annotation**:
A group of Strokes drawn close together in time and place, together with the screenshot taken of them and the Candidates
they resolve to. An Annotation closes on a time gap, a scroll or navigation, a Speech Boundary, a draw-mode toggle, or a
Voice Command.
_Avoid_: Note, highlight, drawing

**Object Select**:
The Toolbar mode where the reviewer picks one element exactly (hover, ↑/↓ to the parent and back, click or ⏎) instead of
drawing, then types what should change in a small comment box next to it, or just says it. A pick is an Annotation with
no Strokes and one definite Candidate, spanning the pick to the reviewer's Enter, with the typed comment if any. The
page is never modified. Esc in the box drops the pick, and the screenshot taken at the pick is deleted with it, on the
Host too. Draw, Object Select and Select Text are one at a time; Esc turns them all off.
_Avoid_: Inspect, picker, element selector, devtools

**Select Text**:
The Toolbar mode (a caret icon) in which selecting text on the page opens the comment box for a Text Comment. While it
is off, selecting text does nothing special.
_Avoid_: Text mode, highlight mode

**Text Comment**:
A comment the reviewer types on text they selected on the page while Select Text is on, recorded with the selected text,
the words around it and the element holding it. It becomes a `copy` Change Item; one that states the new text outright
("This should say …") needs no model.
_Avoid_: Note, highlight, annotation, text note

**Connector**:
A Stroke recognized as an arrow joining two marks, which links them into one Annotation with a subject and a destination.
_Avoid_: Arrow, link

**Candidate**:
A page element an Annotation might refer to: the element the Strokes enclose (or, when they enclose nothing, the
smallest element covering most of the Annotation), its ancestors, the siblings the Strokes cover and the elements
enclosed inside it. Speech picks the winner at processing time.
_Avoid_: Target, match, hit

**Speech Boundary**:
A point in the transcript where a new demonstrative ("this", "here", "that") or a new sentence begins; used to split
Annotations and to pair speech with drawing.
_Avoid_: Utterance break

**Voice Command**:
A spoken phrase, surrounded by silence, that the live transcript watcher acts on instead of treating as review content:
`scratch that`, `next` (alias `new note`), `pin that`, `snap`, `pause`, `resume`.
_Avoid_: Hotword, trigger

### Output

**Draft Item**:
A provisional Change Item produced during a live Session from the speech and Annotations so far, shown in the side panel
for the reviewer to discard or pin; replaced or refined by Process.
_Avoid_: Live item, preview, suggestion

**Process**:
The explicit, reviewer-triggered pass over a finished Session that produces its final Change Items.
_Avoid_: Analyze, generate, run AI

**Change Item**:
One processed, implementer-facing request produced from a Session: what should change, where, and the evidence for it.
_Avoid_: Note, ticket, task, finding

**Category**:
The kind of change a Change Item asks for: `layout`, `style`, `copy`, `content`, `behavior`, `bug`, or `question`.
_Avoid_: Type, tag

**Location**:
A place on a page that a Change Item refers to, resolved to an element or region, with one of three roles: `subject`
(what changes), `reference` (what it should match or relate to), or `destination` (where it goes).
_Avoid_: Target, anchor, source

**Evidence**:
The screenshots and video time range that show what the reviewer was looking at when a Change Item was spoken.
_Avoid_: Proof, attachment

**Combine**:
The merge model's rewrite of two Change Items the reviewer merged on the review page into one coherent title, intent and
Agent Prompt. The merge itself (Locations, Evidence) is done in code; Combine only rewrites the words, and a merge
without it keeps both items' words joined.
_Avoid_: AI merge, smart merge

**Undo (review page)**:
Taking back the latest step of the reviewer's Change Item edits: an edit, delete, split, reorder, or a merge with its
Combine as one step. Redo puts it back. Both are logged as edits, so the log only grows. Not the red Cancel's undo,
which keeps a thrown-away Session.
_Avoid_: Revert, rollback

**Agent Prompt**:
A self-contained instruction attached to a Change Item, written so a coding agent working inside the exported folder can
act on it and open its Evidence.
_Avoid_: Task prompt, instruction

### Host and clients

**Host**:
The `inkup` desktop app (Rust). While a Client is paired, it is the system of record for Sessions, and it serves agents
over MCP. It is optional: without it, a browser extension works on its own.
_Avoid_: Server, daemon, backend, companion

**Client**:
A browser extension or other surface that captures a Session and talks to the Host over its WebSocket.
_Avoid_: Plugin, agent

**Pairing**:
The reviewer approving a Client once in the Host, which issues the token the Client uses to connect from then on. A
Client on another machine (Network mode) pairs by typing, scanning or pasting the 6-digit code the Host shows.
_Avoid_: Login, registration

**Network mode**:
The Host listening on the LAN, not just on this machine: opt-in, unencrypted, for trusted networks only. It answers to
`inkup.local` (or `-2`…`-5`) and its LAN addresses, and wants a token from every other machine. A Client finds one with
Find hubs, which probes those names and the addresses it has paired with before. The extension's UI calls a paired Host
on another machine an "Unencrypted network hub".
_Avoid_: Remote mode, server mode, LAN hub

**Pair link**:
`inkup://pair?url=…&code=…`: a Host's address and a waiting 6-digit code in one string, shown by the Host as text and as
a QR code. Pasting or scanning it into a Client pairs without typing the code.
_Avoid_: Invite, pairing URL, deep link

**Agent token**:
A secret an agent on another machine sends as its Bearer token to the Host's MCP in Network mode. The Host shows it once
when it is made and can revoke it. Agents on the Host's own machine need none.
_Avoid_: API key, MCP token

**Signal**:
A live Annotation, Text Comment or Draft Item that agents can see before Process has produced Change Items; superseded
by the Change Items that cover it.
_Avoid_: Event, finding, live item

**Resolution**:
An agent's word on a Change Item: `in_progress` (it has started, shown as In work with the agent's name), then
`resolved` (shown as Done), `wont_fix` or `needs_info`, with a note. The latest one is the item's status; every one is
kept. Change Items are resolved, never deleted.
_Avoid_: Done, close, delete

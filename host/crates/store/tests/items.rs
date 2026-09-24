mod common;

use common::event;
use inkup_store::{ItemFilter, ItemStatus, ResolutionStatus, SignalFilter, StartItem, Store, StoreError};
use serde_json::{Value, json};

fn item(id: &str, title: &str) -> Value {
    common::item(
        json!({ "id": id, "title": title, "agent_prompt": format!("Do {title}. See screenshots/shot-1.png.") }),
    )
}

/// A store with two paired Clients.
fn open() -> (tempfile::TempDir, Store, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let c1 = store.pair_client("chrome", "one").unwrap().client.id;
    let c2 = store.pair_client("firefox", "two").unwrap().client.id;
    (dir, store, c1, c2)
}

fn start(url: &str) -> Value {
    event("session_start", json!({ "id": format!("start-{url}"), "url": url, "title": "t", "t0": 1 }))
}

#[test]
fn a_push_replaces_the_sessions_items_and_withdraws_the_rest() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    store.upsert_event(c1, "s1", &start("http://localhost:3000/")).unwrap();

    let first = store.put_items(c1, "s1", "run-1", &[item("item_0001", "A"), item("item_0002", "B")]).unwrap();
    assert_eq!(first.added.len(), 2);
    assert_eq!(first.withdrawn, 0);
    let items = store.items(&ItemFilter::default()).unwrap();
    assert_eq!(items.iter().map(|i| i.item_id.as_str()).collect::<Vec<_>>(), ["item_0001", "item_0002"]);
    assert!(items.iter().all(|i| i.status() == ItemStatus::Open));

    // A review edit: B deleted, A renamed and moved after a split copy. The same push again changes nothing.
    let edited = [item("item_0003", "A2"), item("item_0001", "A renamed")];
    let second = store.put_items(c1, "s1", "run-1", &edited).unwrap();
    assert_eq!((second.added.len(), second.withdrawn), (1, 1));
    assert_eq!(store.put_items(c1, "s1", "run-1", &edited).unwrap().added.len(), 0);
    let items = store.items(&ItemFilter::default()).unwrap();
    assert_eq!(items.iter().map(|i| i.body["title"].as_str().unwrap()).collect::<Vec<_>>(), ["A2", "A renamed"]);
    assert_eq!(items[1].seq, first.added[0], "an item keeps its Host id across edits");
    // Withdrawn, not deleted.
    assert!(store.item(first.added[1]).unwrap().unwrap().withdrawn_at.is_some());

    // A second Process run supersedes the first run's items.
    let third = store.put_items(c1, "s1", "run-2", &[item("item_0001", "C")]).unwrap();
    assert_eq!((third.added.len(), third.withdrawn), (1, 2));
    // A run belongs to one Session.
    assert!(matches!(store.put_items(None, "s2", "run-2", &[]), Err(StoreError::RunConflict { .. })));
    assert!(matches!(
        store.put_items(None, "s1", "run-3", &[item("x", "X"), item("x", "Y")]),
        Err(StoreError::InvalidItems(_))
    ));
}

#[test]
fn resolutions_set_the_status_and_reach_the_owning_client() {
    let (_dir, store, c1, c2) = open();
    let (c1, c2) = (Some(c1.as_str()), Some(c2.as_str()));
    store.upsert_event(c1, "s1", &start("http://localhost:3000/")).unwrap();
    store.upsert_event(c2, "s2", &start("https://example.com/")).unwrap();
    let a = store.put_items(c1, "s1", "run-1", &[item("item_0001", "A")]).unwrap().added[0];
    let b = store.put_items(c2, "s2", "run-2", &[item("item_0001", "B")]).unwrap().added[0];

    let resolved = store.resolve_item(a, ResolutionStatus::NeedsInfo, "Which size?", "mcp", None).unwrap().unwrap();
    assert_eq!((resolved.run_id.as_str(), resolved.item_id.as_str()), ("run-1", "item_0001"));
    store.resolve_item(a, ResolutionStatus::Resolved, "Done in Hero.tsx", "mcp", None).unwrap();
    assert!(store.resolve_item(999, ResolutionStatus::Resolved, "", "mcp", None).unwrap().is_none());

    assert_eq!(store.item(a).unwrap().unwrap().status(), ItemStatus::Resolved);
    assert_eq!(store.resolutions(a).unwrap().len(), 2);
    let open = store.items(&ItemFilter { status: Some(ItemStatus::Open), ..Default::default() }).unwrap();
    assert_eq!(open.iter().map(|i| i.seq).collect::<Vec<_>>(), [b]);
    let local = store.items(&ItemFilter { origin: Some("http://localhost:3000/pricing".into()), ..Default::default() });
    assert_eq!(local.unwrap().iter().map(|i| i.seq).collect::<Vec<_>>(), [a]);

    let for_c1 = store.client_resolutions(c1.unwrap()).unwrap();
    assert_eq!(
        for_c1.iter().map(|r| r.resolution.note.as_str()).collect::<Vec<_>>(),
        ["Which size?", "Done in Hero.tsx"]
    );
    assert!(store.client_resolutions(c2.unwrap()).unwrap().is_empty());
}

#[test]
fn start_item_marks_an_item_in_progress_once_and_never_reopens_a_done_one() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    store.upsert_event(c1, "s1", &start("http://localhost:3000/")).unwrap();
    let added = store.put_items(c1, "s1", "run-1", &[item("item_0001", "A"), item("item_0002", "B")]).unwrap().added;
    let (a, b) = (added[0], added[1]);

    let StartItem::Started(started) = store.start_item(a, "", "mcp", Some("claude-code")).unwrap() else {
        panic!("not started")
    };
    assert_eq!(started.resolution.status, ResolutionStatus::InProgress);
    assert_eq!(started.resolution.agent.as_deref(), Some("claude-code"));
    // Idempotent: the same record comes back and nothing new is stored.
    assert_eq!(
        store.start_item(a, "", "mcp", Some("claude-code")).unwrap(),
        StartItem::Unchanged(started.resolution.clone())
    );
    assert_eq!(store.resolutions(a).unwrap().len(), 1);

    let in_progress = store.items(&ItemFilter { status: Some(ItemStatus::InProgress), ..Default::default() }).unwrap();
    assert_eq!(in_progress.iter().map(|i| i.seq).collect::<Vec<_>>(), [a]);
    assert_eq!(in_progress[0].resolution.as_ref().unwrap().agent.as_deref(), Some("claude-code"));
    let open = store.items(&ItemFilter { status: Some(ItemStatus::Open), ..Default::default() }).unwrap();
    assert_eq!(open.iter().map(|i| i.seq).collect::<Vec<_>>(), [b]);

    // Latest wins; the history keeps both.
    store.resolve_item(a, ResolutionStatus::Resolved, "Done in Hero.tsx", "mcp", Some("claude-code")).unwrap();
    assert_eq!(store.item(a).unwrap().unwrap().status(), ItemStatus::Resolved);
    let history = store.resolutions(a).unwrap();
    assert_eq!(
        history.iter().map(|r| r.status).collect::<Vec<_>>(),
        [ResolutionStatus::InProgress, ResolutionStatus::Resolved]
    );
    assert!(
        matches!(store.start_item(a, "", "mcp", None).unwrap(), StartItem::Refused(r) if r.status == ResolutionStatus::Resolved)
    );

    // Needs info can be picked up again; an unknown item is said so.
    store.resolve_item(b, ResolutionStatus::NeedsInfo, "Which size?", "mcp", None).unwrap();
    assert!(matches!(store.start_item(b, "", "mcp", None).unwrap(), StartItem::Started(_)));
    assert_eq!(store.start_item(999, "", "mcp", None).unwrap(), StartItem::NoItem);
}

#[test]
fn an_object_select_pick_is_a_signal_with_its_comment_and_latest_style_edit() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    let edit = |id: &str, t: i64, to: &str| {
        event(
            "style_edit",
            json!({ "id": id, "t": t, "annotation_id": "p1", "changes": { "padding": { "from": "14px 28px", "to": to } },
                    "text": { "from": "Go", "to": "Start" } }),
        )
    };
    let events = [
        start("http://localhost:3000/"),
        event(
            "annotation.object_select",
            json!({ "id": "pick-1", "t": 1000, "t_end": 1000, "annotation_id": "p1", "index": 1, "comment": "Make this roomier",
                    "url": "http://localhost:3000/pricing", "screenshot_id": "shot-1" }),
        ),
        edit("se-1", 2000, "18px"),
        edit("se-2", 3000, "20px 32px"),
    ];
    for event in &events {
        store.upsert_event(c1, "s1", event).unwrap();
    }
    let signals = store.signals(&SignalFilter::default()).unwrap();
    assert_eq!(signals.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["pick-1"]);
    assert_eq!(signals[0].selector.as_deref(), Some("main .hero button.cta"));
    assert_eq!(signals[0].element.as_deref(), Some("button 'Get started'"));
    assert_eq!(signals[0].crop.as_deref(), Some("b7c1e2d3-4f5a-4b6c-8d7e-9f0a1b2c3d42.crop"));
    assert_eq!(signals[0].intent.as_deref(), Some("Make this roomier"));
    assert_eq!(
        signals[0].style_changes,
        Some(
            json!({ "changes": { "padding": { "from": "14px 28px", "to": "20px 32px" } }, "text": { "from": "Go", "to": "Start" } })
        )
    );
}

#[test]
fn speech_dictated_into_a_comment_box_is_the_comment_not_the_signals_transcript() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    let events = [
        start("http://localhost:3000/"),
        event(
            "transcript_segment.dictation",
            json!({ "id": "seg-1", "t": 1200, "t_end": 2400, "text": "make this roomier", "target": { "annotation_id": "p1" } }),
        ),
        event("transcript_segment", json!({ "id": "seg-2", "t": 1500, "t_end": 2600, "text": "and the colour too" })),
        event(
            "annotation.object_select",
            json!({ "id": "pick-1", "t": 1000, "t_end": 3000, "annotation_id": "p1", "index": 1, "comment": "make this roomier",
                    "url": "http://localhost:3000/pricing", "screenshot_id": "shot-1" }),
        ),
    ];
    for event in &events {
        store.upsert_event(c1, "s1", event).unwrap();
    }
    let signals = store.signals(&SignalFilter::default()).unwrap();
    assert_eq!(signals[0].intent.as_deref(), Some("make this roomier"));
    assert_eq!(signals[0].transcript, "and the colour too");
}

#[test]
fn signals_are_live_annotations_and_drafts_until_items_arrive() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    let events = [
        start("http://localhost:3000/"),
        event("transcript_segment", json!({ "id": "seg-1", "t": 900, "t_end": 2500, "text": "make this bigger" })),
        event(
            "annotation",
            json!({ "id": "ann-1", "t": 1000, "t_end": 1500, "annotation_id": "a1", "index": 1,
                    "url": "http://localhost:3000/pricing", "screenshot_id": "shot-1" }),
        ),
        event(
            "annotation",
            json!({ "id": "ann-2", "t": 5000, "t_end": 5200, "annotation_id": "a2", "index": 2, "resolution": "region",
                    "pick": null, "candidates": [], "screenshot_id": null, "connector": null }),
        ),
        // "scratch that" aimed at a2, exactly as the extension sends it: a field rename on either side fails here
        // rather than silently keeping a scratched Signal.
        event("voice_command", json!({})),
        event(
            "draft_item",
            json!({ "id": "d-1", "t": 6000, "draft_id": "d1", "title": "Bigger CTA", "category": "style",
                    "intent": "Make it bigger", "transcript": "make this bigger" }),
        ),
        event(
            "draft_item",
            json!({ "id": "d-2", "t": 7000, "draft_id": "d2", "title": "Nope", "category": "copy", "locations": [] }),
        ),
        event(
            "draft_action",
            json!({ "id": "da-1", "t": 7100, "draft_id": "d2", "action": "discard", "source": "click" }),
        ),
    ];
    for event in &events {
        store.upsert_event(c1, "s1", event).unwrap();
    }
    let signals = store.signals(&SignalFilter::default()).unwrap();
    assert_eq!(signals.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["ann-1", "d-1"]);
    assert_eq!(signals[0].element.as_deref(), Some("button 'Get started'"));
    assert_eq!(signals[1].element.as_deref(), Some("button 'Get started'"));
    assert_eq!(signals[0].transcript, "make this bigger");
    assert_eq!(signals[0].url.as_deref(), Some("http://localhost:3000/pricing"));
    assert_eq!(signals[1].title.as_deref(), Some("Bigger CTA"));
    let after = store.signals(&SignalFilter { after_seq: Some(signals[0].seq), ..Default::default() }).unwrap();
    assert_eq!(after.len(), 1);
    assert!(
        store
            .signals(&SignalFilter { origin: Some("https://example.com".into()), ..Default::default() })
            .unwrap()
            .is_empty()
    );

    let overview = &store.session_overviews(None).unwrap()[0];
    assert!(overview.live && !overview.paused);
    assert_eq!((overview.annotations, overview.draft_items, overview.items), (2, 2, 0));

    store.put_items(c1, "s1", "run-1", &[item("item_0001", "A")]).unwrap();
    assert!(store.signals(&SignalFilter::default()).unwrap().is_empty(), "Change Items supersede the Signals");
    let (items, events_seq) = store.cursor().unwrap();
    assert!(items >= 1 && events_seq >= 8);

    // The live timeline leaves Strokes and actions out, and pause state follows the latest pause or resume.
    store.upsert_event(c1, "s1", &event("session_pause", json!({ "id": "p-1", "t": 8000 }))).unwrap();
    assert!(store.session_overviews(None).unwrap()[0].paused);
    let timeline = store.timeline("s1", 3).unwrap();
    assert_eq!(timeline.iter().map(|e| e["id"].as_str().unwrap()).collect::<Vec<_>>(), ["d-1", "d-2", "p-1"]);
    store.upsert_event(c1, "s1", &event("session_resume", json!({ "id": "r-1", "t": 9000 }))).unwrap();
    assert!(!store.session_overviews(None).unwrap()[0].paused);
}

#[test]
fn a_page_api_annotation_is_a_signal_tagged_with_its_source_and_comment() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    store.upsert_event(c1, "s1", &start("http://localhost:3000/")).unwrap();
    let events = [
        event(
            "annotation.page_api",
            json!({ "id": "ann-1", "t": 1000, "t_end": 1000, "annotation_id": "a1", "index": 1, "url": "http://localhost:3000/",
                    "screenshot_id": "shot-1", "page_api": { "comment": "Make the CTA purple" } }),
        ),
        // Its style change, as a style_edit on the Annotation.
        event(
            "style_edit",
            json!({ "id": "se-1", "t": 1000, "annotation_id": "a1", "selector": "main .hero",
                    "changes": { "color": { "from": "red", "to": "purple" } } }),
        ),
    ];
    for event in &events {
        store.upsert_event(c1, "s1", event).unwrap();
    }
    let signals = store.signals(&SignalFilter::default()).unwrap();
    assert_eq!(signals[0].source.as_deref(), Some("page_api"));
    assert_eq!(signals[0].intent.as_deref(), Some("Make the CTA purple"));
    assert_eq!(signals[0].page_api, Some(json!({ "comment": "Make the CTA purple" })));
    assert_eq!(signals[0].selector.as_deref(), Some("main .hero"));
    assert_eq!(signals[0].style_changes.as_ref().unwrap()["changes"]["color"]["to"], "purple");
}

#[test]
fn text_comments_are_signals_with_their_element_comment_and_speech_until_items_arrive() {
    let (_dir, store, c1, _) = open();
    let c1 = Some(c1.as_str());
    let events = [
        start("http://localhost:3000/"),
        event(
            "transcript_segment",
            json!({ "id": "seg-1", "t": 2500, "t_end": 3500, "text": "the headline sells the wrong thing" }),
        ),
        event(
            "transcript_segment",
            json!({ "id": "seg-2", "t": 7000, "t_end": 8000, "text": "later, about something else" }),
        ),
        event(
            "text_comment",
            json!({ "id": "tc-1", "t": 2000, "t_end": 5000, "comment_id": "c1", "index": 1,
                    "url": "http://localhost:3000/pricing", "screenshot_id": "shot-tc", "selected_text": "Ship reviews in minutes",
                    "anchor": { "exact": "Ship reviews in minutes", "prefix": "", "suffix": " Simple pricing" },
                    "element": { "selector": "#hero-title", "tag": "h1", "role": "heading", "name": "Ship reviews in minutes", "text": "Ship reviews in minutes" },
                    "comment": "This should say Pricing plans" }),
        ),
    ];
    for event in &events {
        store.upsert_event(c1, "s1", event).unwrap();
    }
    let signals = store.signals(&SignalFilter::default()).unwrap();
    assert_eq!(signals.len(), 1);
    let signal = &signals[0];
    assert_eq!((signal.id.as_str(), signal.kind.as_str(), signal.number), ("tc-1", "text_comment", Some(1)));
    assert_eq!(signal.element.as_deref(), Some("heading 'Ship reviews in minutes'"));
    assert_eq!(signal.selector.as_deref(), Some("#hero-title"));
    assert_eq!(signal.screenshot.as_deref(), Some("shot-tc"));
    assert_eq!(signal.title.as_deref(), Some("Comment on \"Ship reviews in minutes\""));
    assert_eq!(signal.category.as_deref(), Some("copy"));
    assert_eq!(signal.intent.as_deref(), Some("This should say Pricing plans"));
    assert_eq!(
        signal.transcript, "the headline sells the wrong thing",
        "only what was said while the text was selected"
    );
    assert_eq!(signal.url.as_deref(), Some("http://localhost:3000/pricing"));

    store.put_items(c1, "s1", "run-1", &[item("item_0001", "A")]).unwrap();
    assert!(store.signals(&SignalFilter::default()).unwrap().is_empty(), "Change Items supersede the Signal");
}

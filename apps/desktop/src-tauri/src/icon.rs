//! The menu bar and Dock icons, drawn at run time from the bundled PNG.
//!
//! - **The Clients dot.** None while no Client is paired, a steady dot while one or more are, and a slow pulse
//!   (about once a second) while any has a live Session. It is the extension's host dot
//!   (extensions/web/src/background/host-dot.ts): green with a white ring, in the bottom-right corner, the same
//!   geometry.
//! - **Development stripes.** A build the release workflow did not make (`INKUP_RELEASE_BUILD` unset at compile
//!   time: debug builds, `desktop:dev`, a local release build) draws the icon on diagonal black-and-yellow bands, the
//!   same bands as the extension's development icon. The dot goes on top.
//!
//! The pure functions here work on pixel buffers; lib.rs puts the result on the tray and the Dock.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use image::imageops::{self, FilterType};
use image::{Rgba, RgbaImage};
use inkup_protocol::control::{ControlState, HostState};

/// Whether this is a development build: anything the release workflow did not build. Its `tauri build`
/// (`.github/workflows/desktop-macos.yml`) sets `INKUP_RELEASE_BUILD=1`, read at compile time.
pub const DEVELOPMENT: bool = is_development(option_env!("INKUP_RELEASE_BUILD"));

/// `INKUP_RELEASE_BUILD` unset: development. Set to anything: the release workflow's build.
pub const fn is_development(release_build: Option<&str>) -> bool {
    release_build.is_none()
}

/// The dot's green and ring: the extension's `HOST_DOT_COLORS.connected` on white.
const GREEN: [u8; 3] = [0x16, 0xa3, 0x4a];
const RING: [u8; 3] = [0xff, 0xff, 0xff];
/// How much of the green shows on the pulse's off beat: a pale dot inside the same white ring.
const FAINT: f32 = 0.35;
/// The development bands: near-black and yellow.
const DARK: [u8; 3] = [0x11, 0x11, 0x11];
const YELLOW: [u8; 3] = [0xfa, 0xcc, 0x15];

/// Half the pulse: the dot is full this long, then faint this long.
pub const PULSE_BEAT: Duration = Duration::from_millis(500);

/// What the paired Clients are doing, as the dot says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clients {
    /// No Client is paired: no dot.
    Unpaired,
    /// One or more are paired, none has a live Session: a steady dot.
    Paired,
    /// Some Client has a live Session (not ended yet, paused or not): the dot pulses.
    Live,
}

impl Clients {
    pub fn of(state: &HostState) -> Self {
        if state.clients.is_empty() {
            Self::Unpaired
        } else if state.sessions.iter().any(|s| s.live) {
            Self::Live
        } else {
            Self::Paired
        }
    }

    /// The frame the icons rest on: no dot, or the full one (the pulse's on beat while live).
    pub fn resting(self) -> Dot {
        if self == Self::Unpaired { Dot::None } else { Dot::Full }
    }
}

/// One frame of the dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dot {
    None,
    /// Steady, and the pulse's on beat.
    Full,
    /// The pulse's off beat.
    Faint,
}

impl Dot {
    pub const ALL: [Dot; 3] = [Dot::None, Dot::Full, Dot::Faint];

    fn index(self) -> usize {
        self as usize
    }
}

/// Where the dot sits on an icon of `size` px: `dotGeometry` in host-dot.ts. Centre, radius and ring width, in
/// pixels from the top-left corner.
pub fn dot_geometry(size: u32) -> (f32, f32, f32) {
    let size = size as f32;
    let r = (size * 0.13 * 2.0).round() / 2.0;
    let ring = (size / 16.0).round().max(1.0);
    let inset = r + ring;
    (size - inset, r, ring)
}

/// The width of one development band on an icon of `size` px, measured along an edge.
pub fn band_width(size: u32) -> u32 {
    ((size as f32 / 8.0).round() as u32).max(1)
}

/// The development bands at pixel (`x`, `y`): 45°, running bottom-left to top-right, dark first at the top-left
/// corner.
pub fn stripe_at(size: u32, x: u32, y: u32) -> [u8; 3] {
    if ((x + y) / band_width(size)).is_multiple_of(2) { DARK } else { YELLOW }
}

/// The icon at `size` px: `base` scaled to fit, on the development bands when `development`, with `dot` on top.
/// On the bands the icon is inset by one band width on every side, so the bands show all round its shape.
pub fn compose(base: &RgbaImage, size: u32, development: bool, dot: Dot) -> RgbaImage {
    let mut out = if development {
        RgbaImage::from_fn(size, size, |x, y| opaque(stripe_at(size, x, y)))
    } else {
        RgbaImage::new(size, size)
    };
    let inset = if development && size > 2 * band_width(size) { band_width(size) } else { 0 };
    let inner = size - 2 * inset;
    let icon = if base.dimensions() == (inner, inner) {
        base.clone()
    } else {
        imageops::resize(base, inner, inner, FilterType::Lanczos3)
    };
    imageops::overlay(&mut out, &icon, inset.into(), inset.into());
    draw_dot(&mut out, dot);
    out
}

fn draw_dot(img: &mut RgbaImage, dot: Dot) {
    let alpha = match dot {
        Dot::None => return,
        Dot::Full => 1.0,
        Dot::Faint => FAINT,
    };
    let size = img.width();
    let (c, r, ring) = dot_geometry(size);
    let outer = r + ring;
    let from = (c - outer).floor().max(0.0) as u32;
    for y in from..size {
        for x in from..size {
            blend(img.get_pixel_mut(x, y), RING, coverage(x, y, c, outer));
            blend(img.get_pixel_mut(x, y), GREEN, coverage(x, y, c, r) * alpha);
        }
    }
}

/// How much of pixel (`x`, `y`) the circle at (`c`, `c`) of radius `r` covers, from 4×4 samples: the edge
/// anti-aliased, as a canvas `arc` fill is.
fn coverage(x: u32, y: u32, c: f32, r: f32) -> f32 {
    const N: u32 = 4;
    let mut inside = 0;
    for sy in 0..N {
        for sx in 0..N {
            let dx = x as f32 + (sx as f32 + 0.5) / N as f32 - c;
            let dy = y as f32 + (sy as f32 + 0.5) / N as f32 - c;
            if dx * dx + dy * dy <= r * r {
                inside += 1;
            }
        }
    }
    inside as f32 / (N * N) as f32
}

/// `color` over `px` at opacity `a` (source-over).
fn blend(px: &mut Rgba<u8>, color: [u8; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let [r, g, b, da] = px.0.map(|v| v as f32 / 255.0);
    let out_a = a + da * (1.0 - a);
    let mix = |s: u8, d: f32| ((s as f32 / 255.0 * a + d * da * (1.0 - a)) / out_a * 255.0).round() as u8;
    *px = Rgba([mix(color[0], r), mix(color[1], g), mix(color[2], b), (out_a * 255.0).round() as u8]);
}

fn opaque([r, g, b]: [u8; 3]) -> Rgba<u8> {
    Rgba([r, g, b, 255])
}

/// Each frame of an icon, drawn once on first use and kept: the pulse only swaps them.
pub struct Frames<T> {
    frames: [std::sync::OnceLock<T>; 3],
    draw: Box<dyn Fn(Dot) -> T + Send + Sync>,
}

impl<T> Frames<T> {
    pub fn new(draw: impl Fn(Dot) -> T + Send + Sync + 'static) -> Self {
        Self { frames: Default::default(), draw: Box::new(draw) }
    }

    pub fn get(&self, dot: Dot) -> &T {
        self.frames[dot.index()].get_or_init(|| (self.draw)(dot))
    }
}

type Show = Arc<dyn Fn(Dot) + Send + Sync>;

/// The dot as the Clients change: shows the frame for each change, and runs the pulse while a Session is live.
/// Nothing ticks otherwise, so an idle app does no timer work.
pub struct DotDriver {
    show: Show,
    state: Arc<Mutex<DriverState>>,
}

struct DriverState {
    clients: Clients,
    /// Counts the changes, so a pulse beat that lost the race with a change does not show.
    change: u64,
    pulse: Option<tokio::task::JoinHandle<()>>,
}

impl DotDriver {
    /// `show` puts a frame on the icons; it is called on a Tokio task while the dot pulses, never two at once.
    pub fn new(show: impl Fn(Dot) + Send + Sync + 'static) -> Self {
        let state = DriverState { clients: Clients::Unpaired, change: 0, pulse: None };
        Self { show: Arc::new(show), state: Arc::new(Mutex::new(state)) }
    }

    pub fn clients(&self) -> Clients {
        lock(&self.state).clients
    }

    /// Whether the pulse is running.
    pub fn pulsing(&self) -> bool {
        lock(&self.state).pulse.is_some()
    }

    /// Follows a read of the host's state: the Clients it has, or none when the host did not answer.
    pub fn follow<E>(&self, state: &Result<ControlState, E>) {
        self.set(state.as_ref().map_or(Clients::Unpaired, |s| Clients::of(&s.state)));
    }

    /// The Clients as the host last said. Shows the new frame when they changed; starting the pulse needs a Tokio
    /// runtime, which the app's commands run on.
    pub fn set(&self, clients: Clients) {
        let mut state = lock(&self.state);
        if state.clients == clients {
            return;
        }
        state.clients = clients;
        state.change += 1;
        if let Some(pulse) = state.pulse.take() {
            pulse.abort();
        }
        (self.show)(clients.resting());
        if clients == Clients::Live {
            let (show, shared, change) = (Arc::clone(&self.show), Arc::clone(&self.state), state.change);
            // Each beat shows under the lock, and only while no change came after this pulse started.
            let beat = move |dot| {
                let state = lock(&shared);
                if state.change == change {
                    show(dot);
                }
            };
            state.pulse = Some(tokio::spawn(async move {
                loop {
                    tokio::time::sleep(PULSE_BEAT).await;
                    beat(Dot::Faint);
                    tokio::time::sleep(PULSE_BEAT).await;
                    beat(Dot::Full);
                }
            }));
        }
    }
}

fn lock(state: &Mutex<DriverState>) -> std::sync::MutexGuard<'_, DriverState> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for DotDriver {
    fn drop(&mut self) {
        if let Some(pulse) = lock(&self.state).pulse.take() {
            pulse.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for the app icon: opaque blue with transparent 2px corners, like the real one's rounded ones.
    fn base(size: u32) -> RgbaImage {
        RgbaImage::from_fn(size, size, |x, y| {
            let corner = |v: u32| v < 2 || v >= size - 2;
            if corner(x) && corner(y) { Rgba([0, 0, 0, 0]) } else { Rgba([0x1f, 0x2a, 0x44, 255]) }
        })
    }

    fn rgb(px: &Rgba<u8>) -> [u8; 3] {
        [px[0], px[1], px[2]]
    }

    #[test]
    fn the_geometry_is_the_extensions() {
        // host-dot.ts: dotGeometry(16) = { cx: 13, r: 2, ring: 1 }, (32) = { cx: 26, r: 4, ring: 2 },
        // (128) = { cx: 103.5, r: 16.5, ring: 8 }.
        assert_eq!(dot_geometry(16), (13.0, 2.0, 1.0));
        assert_eq!(dot_geometry(32), (26.0, 4.0, 2.0));
        assert_eq!(dot_geometry(128), (103.5, 16.5, 8.0));
    }

    #[test]
    fn no_dot_leaves_the_icon_alone() {
        let icon = compose(&base(32), 32, false, Dot::None);
        assert_eq!(icon, base(32));
    }

    #[test]
    fn the_full_dot_is_green_in_a_white_ring_in_the_bottom_right() {
        for size in [16, 32, 128, 512] {
            let icon = compose(&base(size), size, false, Dot::Full);
            let (c, r, ring) = dot_geometry(size);
            let centre = icon.get_pixel(c as u32, c as u32);
            assert_eq!(rgb(centre), GREEN, "{size}: centre");
            assert_eq!(centre[3], 255);
            let on_ring = (c + r + ring / 2.0) as u32;
            if ring >= 2.0 {
                assert_eq!(rgb(icon.get_pixel(on_ring, c as u32)), RING, "{size}: ring");
            }
            // The top-left is untouched.
            assert_eq!(icon.get_pixel(size / 4, size / 4), base(size).get_pixel(size / 4, size / 4));
        }
    }

    #[test]
    fn the_pulse_off_beat_is_a_pale_dot_in_the_same_ring() {
        let full = compose(&base(128), 128, false, Dot::Full);
        let faint = compose(&base(128), 128, false, Dot::Faint);
        let (c, r, ring) = dot_geometry(128);
        let centre = faint.get_pixel(c as u32, c as u32);
        // 35 % green over white.
        let expected = GREEN.map(|g| (g as f32 * FAINT + 255.0 * (1.0 - FAINT)).round() as u8);
        assert_eq!(rgb(centre), expected);
        let on_ring = ((c + r + ring / 2.0) as u32, c as u32);
        assert_eq!(faint.get_pixel(on_ring.0, on_ring.1), full.get_pixel(on_ring.0, on_ring.1));
    }

    #[test]
    fn stripes_run_at_45_degrees_in_bands_an_eighth_of_the_icon_wide() {
        assert_eq!(band_width(16), 2);
        assert_eq!(band_width(32), 4);
        assert_eq!(band_width(4), 1);
        assert_eq!(band_width(1), 1);
        // Size 32, bands 4 px: x + y in 0..4 dark, 4..8 yellow, 8..12 dark.
        assert_eq!(stripe_at(32, 0, 0), DARK);
        assert_eq!(stripe_at(32, 3, 0), DARK);
        assert_eq!(stripe_at(32, 4, 0), YELLOW);
        assert_eq!(stripe_at(32, 0, 4), YELLOW);
        assert_eq!(stripe_at(32, 2, 2), YELLOW);
        assert_eq!(stripe_at(32, 8, 0), DARK);
        // Bottom-left to top-right: the same band along x + y = constant.
        assert_eq!(stripe_at(32, 1, 6), stripe_at(32, 6, 1));
    }

    #[test]
    fn a_development_icon_shows_the_stripes_all_round_the_icon() {
        let size = 32;
        let icon = compose(&base(size), size, true, Dot::None);
        let band = band_width(size);
        // The margin, one band wide, is all stripes.
        for (x, y) in [(0, 0), (4, 0), (31, 0), (0, 31), (31, 3), (16, 31), (0, 16)] {
            assert_eq!(rgb(icon.get_pixel(x, y)), stripe_at(size, x, y), "({x}, {y})");
            assert_eq!(icon.get_pixel(x, y)[3], 255);
        }
        // The icon's transparent corners show the stripes too.
        assert_eq!(rgb(icon.get_pixel(band, band)), stripe_at(size, band, band));
        // The icon itself is on top.
        assert_eq!(rgb(icon.get_pixel(16, 16)), [0x1f, 0x2a, 0x44]);
    }

    #[test]
    fn the_dot_goes_on_top_of_the_stripes() {
        let icon = compose(&base(128), 128, true, Dot::Full);
        let (c, ..) = dot_geometry(128);
        assert_eq!(rgb(icon.get_pixel(c as u32, c as u32)), GREEN);
        assert_eq!(rgb(icon.get_pixel(0, 0)), DARK);
    }

    #[test]
    fn a_release_build_has_no_stripes() {
        let icon = compose(&base(32), 32, false, Dot::Full);
        assert_eq!(icon.get_pixel(0, 0)[3], 0, "the transparent corner stays transparent");
        assert_eq!(rgb(icon.get_pixel(4, 4)), [0x1f, 0x2a, 0x44]);
    }

    #[test]
    fn the_release_flag_turns_the_stripes_off() {
        assert!(is_development(None));
        assert!(!is_development(Some("1")));
        // Only the release workflow's `tauri build` sets it, so `cargo test` builds a development app.
        assert_eq!(DEVELOPMENT, option_env!("INKUP_RELEASE_BUILD").is_none());
    }

    #[test]
    fn frames_draw_once() {
        let calls = Arc::new(Mutex::new(0));
        let frames = {
            let calls = Arc::clone(&calls);
            Frames::new(move |dot| {
                *calls.lock().unwrap() += 1;
                dot
            })
        };
        assert_eq!(*frames.get(Dot::Full), Dot::Full);
        assert_eq!(*frames.get(Dot::Full), Dot::Full);
        assert_eq!(*frames.get(Dot::Faint), Dot::Faint);
        assert_eq!(*calls.lock().unwrap(), 2);
    }
}

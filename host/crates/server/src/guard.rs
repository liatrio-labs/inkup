//! DNS-rebinding, cross-site and off-machine guard (ADR 0005, ADR 0006). Binding 127.0.0.1 keeps other machines
//! out; in network mode they get in, and must bring a token. These checks also keep out web pages in the user's
//! own browser.
//!
//! - Host: a page on `evil.example` that rebinds its name to the Host still sends `Host: evil.example:47823`, so
//!   only loopback names on our port are served, plus in network mode the Host's `.local` names and LAN addresses.
//! - Origin: a WebSocket is not bound by CORS, so /ws refuses any web page origin. Extensions
//!   (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`) and clients with no Origin pass.
//!   /mcp refuses web page origins too; agents send no Origin.
//! - Another machine: /mcp, /api and /blobs need a Bearer token, a paired Client's or an agent token. From this
//!   machine /mcp needs none (a local process can read the data dir anyway). A Remote Host treats every peer that
//!   way, 127.0.0.1 included (ADR 0030): a proxy on the same machine is not a boundary.
//! - The control API (`/api/host/*`, control.rs) is refused to another machine whatever token it brings, in network
//!   mode too, and to any request with an Origin: web pages and extensions have no business there. On a Remote Host
//!   it is not on the public listener at all.
//! - `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-User` (and the other forwarded
//!   identity headers) are not read. They do not authenticate a request and do not mark a peer local.

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use inkup_store::Bearer;

use crate::AppState;
use crate::http::{ApiError, bearer};
use crate::network::Network;
use crate::remote::PublicUrl;
use crate::ws::blocking;

const LOOPBACK_NAMES: &[&str] = &["127.0.0.1", "localhost", "[::1]"];
const EXTENSION_SCHEMES: &[&str] = &["chrome-extension://", "moz-extension://", "safari-web-extension://"];

/// Who is on the other end of a request; the guard puts it in the request's extensions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Peer {
    pub ip: IpAddr,
    /// On another machine: needs a token everywhere but /health, and a code to pair.
    pub remote: bool,
}

/// The Client or Agent token the guard already accepted. MCP reads it from the request parts instead of
/// checking the header again (ADR 0030: a Resolution is named for the Agent token).
#[derive(Debug, Clone)]
pub(crate) struct Authenticated(pub Bearer);

pub(crate) async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let public = state.config.remote.as_ref().map(|remote| &remote.public_url);
    if !host_allowed(request.headers(), state.port, state.network.as_deref(), public) {
        tracing::warn!(host = ?request.headers().get(header::HOST), "refused a request for a Host name not ours");
        return (StatusCode::FORBIDDEN, "Host not allowed").into_response();
    }
    let path = request.uri().path().to_owned();
    let mcp = path == "/mcp" || path.starts_with("/mcp/");
    if (path == "/ws" || mcp) && !origin_allowed(request.headers(), state.port) {
        tracing::warn!(origin = ?request.headers().get(header::ORIGIN), path, "refused a request from a web page");
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }
    let peer = peer(&request, state.config.every_peer_is_remote);
    let control = is_control(&path);
    // A Remote Host does not mount `/api/host/*` on the public listener. Leaving the path alone lets the router
    // answer 404, which is how a test can tell the routes are absent. The control listener has `remote: None`.
    if control && state.config.remote.is_none() && (peer.remote || request.headers().contains_key(header::ORIGIN)) {
        tracing::warn!(peer = %peer.ip, path, "refused a control API request from another machine or a web origin");
        return (StatusCode::FORBIDDEN, "the control API is for this machine only").into_response();
    }
    if peer.remote && (mcp || (!control && path.starts_with("/api/")) || path.starts_with("/blobs/")) {
        let known = match bearer(request.headers()) {
            Some(token) => blocking(&state.store, move |store| store.authenticate_bearer(&token)).await,
            None => Ok(None),
        };
        match known {
            Ok(Some(bearer)) => {
                request.extensions_mut().insert(Authenticated(bearer));
            }
            Ok(None) => {
                tracing::info!(peer = %peer.ip, path, "refused a request from another machine without a known token");
                let mut refused = ApiError::Unauthorized.into_response();
                refused.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
                return refused;
            }
            Err(error) => return ApiError::from(error).into_response(),
        }
    }
    request.extensions_mut().insert(peer);
    next.run(request).await
}

/// `/api/host` and below. Matched on the path as sent: the router does not decode or normalise it either, so a
/// path that routes to a control handler also matches here.
fn is_control(path: &str) -> bool {
    path == "/api/host" || path.starts_with("/api/host/")
}

/// Fails closed: a request whose peer address is unknown (a router served without `ConnectInfo`) is from another
/// machine, so it needs a token.
fn peer(request: &Request, every_peer_is_remote: bool) -> Peer {
    match request.extensions().get::<ConnectInfo<SocketAddr>>() {
        Some(info) => {
            let ip = info.0.ip().to_canonical();
            Peer { ip, remote: every_peer_is_remote || !ip.is_loopback() }
        }
        None => Peer { ip: IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), remote: true },
    }
}

fn host_allowed(headers: &HeaderMap, port: u16, network: Option<&Network>, public: Option<&PublicUrl>) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if is_loopback_authority(host, port) {
        return true;
    }
    if public.is_some_and(|public| public.admits_host_header(host)) {
        return true;
    }
    let Some(network) = network else { return false };
    host.rsplit_once(':').is_some_and(|(name, found)| found == port.to_string() && network.serves_name(name))
}

fn origin_allowed(headers: &HeaderMap, port: u16) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let origin = origin.to_ascii_lowercase();
    if EXTENSION_SCHEMES.iter().any(|scheme| origin.starts_with(scheme)) {
        return true;
    }
    origin.strip_prefix("http://").is_some_and(|authority| is_loopback_authority(authority, port))
}

/// `name:port` where name is a loopback name and port is ours.
fn is_loopback_authority(authority: &str, port: u16) -> bool {
    let Some((name, found)) = authority.rsplit_once(':') else {
        return false;
    };
    found == port.to_string() && LOOPBACK_NAMES.iter().any(|allowed| name.eq_ignore_ascii_case(allowed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        pairs.iter().map(|(name, value)| (name.clone(), value.parse().unwrap())).collect()
    }

    #[test]
    fn only_loopback_names_on_our_port_are_served() {
        for ok in ["127.0.0.1:47823", "localhost:47823", "LOCALHOST:47823", "[::1]:47823"] {
            assert!(host_allowed(&headers(&[(header::HOST, ok)]), 47823, None, None), "{ok}");
        }
        for bad in ["evil.example:47823", "127.0.0.1", "127.0.0.1:80", "localhost.evil.example:47823", "0.0.0.0:47823"]
        {
            assert!(!host_allowed(&headers(&[(header::HOST, bad)]), 47823, None, None), "{bad}");
        }
        assert!(!host_allowed(&HeaderMap::new(), 47823, None, None));
        // Without network mode the .local name is not ours.
        assert!(!host_allowed(&headers(&[(header::HOST, "inkup.local:47823")]), 47823, None, None));
    }

    #[test]
    fn a_remote_host_admits_its_public_name_and_not_a_forwarded_one() {
        let public = PublicUrl::parse("https://review.example").unwrap();
        for ok in ["review.example", "review.example:443", "127.0.0.1:47823"] {
            assert!(host_allowed(&headers(&[(header::HOST, ok)]), 47823, None, Some(&public)), "{ok}");
        }
        for bad in ["review.example:47823", "inkup.local:47823", "evil.example", "evil.example:443"] {
            assert!(!host_allowed(&headers(&[(header::HOST, bad)]), 47823, None, Some(&public)), "{bad}");
        }
        // A forwarded host is not the Host header, so it does not admit the name.
        let forwarded = headers(&[
            (header::HOST, "evil.example"),
            (header::HeaderName::from_static("x-forwarded-host"), "review.example"),
        ]);
        assert!(!host_allowed(&forwarded, 47823, None, Some(&public)));
    }

    #[test]
    fn web_page_origins_cannot_open_the_websocket() {
        for ok in
            ["chrome-extension://abcdef", "moz-extension://1234", "safari-web-extension://x", "http://127.0.0.1:47823"]
        {
            assert!(origin_allowed(&headers(&[(header::ORIGIN, ok)]), 47823), "{ok}");
        }
        for bad in ["https://evil.example", "https://review.example", "http://localhost:3000", "null"] {
            assert!(!origin_allowed(&headers(&[(header::ORIGIN, bad)]), 47823), "{bad}");
        }
        assert!(origin_allowed(&HeaderMap::new(), 47823));
    }
}

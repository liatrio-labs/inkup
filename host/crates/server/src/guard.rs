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
//!   machine /mcp needs none (a local process can read the data dir anyway).
//! - The control API (`/api/host/*`, control.rs) is refused to another machine whatever token it brings, in network
//!   mode too, and to any request with an Origin: web pages and extensions have no business there.

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;
use crate::http::{ApiError, bearer};
use crate::network::Network;
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

pub(crate) async fn guard(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    if !host_allowed(request.headers(), state.port, state.network.as_deref()) {
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
    if is_control(&path) && (peer.remote || request.headers().contains_key(header::ORIGIN)) {
        tracing::warn!(peer = %peer.ip, path, "refused a control API request from another machine or a web origin");
        return (StatusCode::FORBIDDEN, "the control API is for this machine only").into_response();
    }
    if peer.remote && (mcp || path.starts_with("/api/") || path.starts_with("/blobs/")) {
        let known = match bearer(request.headers()) {
            Some(token) => blocking(&state.store, move |store| store.authenticate_bearer(&token)).await,
            None => Ok(None),
        };
        match known {
            Ok(Some(_)) => {}
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

fn host_allowed(headers: &HeaderMap, port: u16, network: Option<&Network>) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if is_loopback_authority(host, port) {
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
            assert!(host_allowed(&headers(&[(header::HOST, ok)]), 47823, None), "{ok}");
        }
        for bad in ["evil.example:47823", "127.0.0.1", "127.0.0.1:80", "localhost.evil.example:47823", "0.0.0.0:47823"]
        {
            assert!(!host_allowed(&headers(&[(header::HOST, bad)]), 47823, None), "{bad}");
        }
        assert!(!host_allowed(&HeaderMap::new(), 47823, None));
        // Without network mode the .local name is not ours.
        assert!(!host_allowed(&headers(&[(header::HOST, "inkup.local:47823")]), 47823, None));
    }

    #[test]
    fn web_page_origins_cannot_open_the_websocket() {
        for ok in
            ["chrome-extension://abcdef", "moz-extension://1234", "safari-web-extension://x", "http://127.0.0.1:47823"]
        {
            assert!(origin_allowed(&headers(&[(header::ORIGIN, ok)]), 47823), "{ok}");
        }
        for bad in ["https://evil.example", "http://localhost:3000", "null"] {
            assert!(!origin_allowed(&headers(&[(header::ORIGIN, bad)]), 47823), "{bad}");
        }
        assert!(origin_allowed(&HeaderMap::new(), 47823));
    }
}

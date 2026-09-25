//! `HostLink`: the app's one way to the host, whichever process hosts. The control API on 127.0.0.1 with the
//! control token from `host.json`; the webview never sees the token, it calls the app's commands. Responses decode
//! as the contract's types (contract/host-control.schema.json), so a host that drifted from it is an error here.

use std::time::Duration;

use inkup_protocol::control::{Activated, ControlState};
use inkup_store::instance::HostInfo;

#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error("the InkUp host did not answer: {0}")]
    Unreachable(#[from] reqwest::Error),
    #[error("the InkUp host refused ({status}): {body}")]
    Refused { status: u16, body: String },
}

#[derive(Debug, Clone)]
pub struct HostLink {
    port: u16,
    token: String,
    http: reqwest::Client,
}

impl HostLink {
    pub fn new(port: u16, token: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            // Loopback: a proxy from the environment has no business in between.
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self { port, token: token.into(), http }
    }

    /// The host `host.json` names.
    pub fn to(holder: &HostInfo) -> Self {
        Self::new(holder.port, holder.control_token.clone())
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// `127.0.0.1:<port>`.
    pub fn address(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    /// `GET /api/host/state`: `HostState` plus the header's facts.
    pub async fn state(&self, timeline: Option<&str>) -> Result<ControlState, LinkError> {
        let mut request = self.http.get(self.url("/api/host/state")).bearer_auth(&self.token);
        if let Some(timeline) = timeline {
            request = request.query(&[("timeline", timeline)]);
        }
        Ok(checked(request.send().await?).await?.json().await?)
    }

    /// `POST /api/host/activate`: whether the host came forward (only the desktop app does).
    pub async fn activate(&self) -> Result<bool, LinkError> {
        let request = self.http.post(self.url("/api/host/activate")).bearer_auth(&self.token);
        let activated: Activated = checked(request.send().await?).await?.json().await?;
        Ok(activated.handled)
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

async fn checked(response: reqwest::Response) -> Result<reqwest::Response, LinkError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(LinkError::Refused { status: status.as_u16(), body })
}

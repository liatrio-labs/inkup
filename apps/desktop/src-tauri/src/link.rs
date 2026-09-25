//! `HostLink`: the app's one way to the host, whichever process hosts. The control API on 127.0.0.1 with the
//! control token from `host.json`; the webview never sees the token, it calls the app's commands. Responses decode
//! as the contract's types (contract/host-control.schema.json), so a host that drifted from it is an error here.

use std::time::Duration;

use inkup_protocol::control::{
    Activated, Changes, CommandOutcome, CommandRequest, ControlState, NetworkSwitched, NewToken, PairingAnswer,
};
use inkup_store::instance::HostInfo;

/// How long `changes` waits: longer than the host holds a long-poll (25 s).
const LONG_POLL: Duration = Duration::from_secs(35);

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
            // A connection per request: a pooled one to a server that restarted (network mode switched) is dead,
            // and the first request after the restart failed on it. On loopback a new connection costs nothing.
            .pool_max_idle_per_host(0)
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

    /// `GET /api/host/changes?since=`: the view's change count, once it is not `since` (or after the host's
    /// long-poll timeout).
    pub async fn changes(&self, since: u64) -> Result<u64, LinkError> {
        let request = self
            .http
            .get(self.url("/api/host/changes"))
            .query(&[("since", since)])
            .bearer_auth(&self.token)
            // Longer than the host holds a long-poll.
            .timeout(LONG_POLL);
        let changes: Changes = checked(request.send().await?).await?.json().await?;
        Ok(u64::try_from(changes.seq).unwrap_or_default())
    }

    /// `POST /api/host/commands`: the Client's answer.
    pub async fn command(&self, command: &CommandRequest) -> Result<CommandOutcome, LinkError> {
        let request = self
            .http
            .post(self.url("/api/host/commands"))
            .bearer_auth(&self.token)
            .json(command)
            // The host waits for the Client's answer.
            .timeout(Duration::from_secs(20));
        Ok(checked(request.send().await?).await?.json().await?)
    }

    /// `POST /api/host/tokens`: the token, shown this once.
    pub async fn create_token(&self, name: &str) -> Result<NewToken, LinkError> {
        let body = serde_json::json!({ "name": name });
        let request = self.http.post(self.url("/api/host/tokens")).bearer_auth(&self.token).json(&body);
        Ok(checked(request.send().await?).await?.json().await?)
    }

    /// `DELETE /api/host/tokens/{id}`.
    pub async fn revoke_token(&self, id: &str) -> Result<(), LinkError> {
        let request = self.http.delete(self.url(&format!("/api/host/tokens/{id}"))).bearer_auth(&self.token);
        checked(request.send().await?).await?;
        Ok(())
    }

    /// `POST /api/host/network`: whether the host switches (only the desktop app hosting does).
    pub async fn network(&self, on: bool) -> Result<bool, LinkError> {
        let body = serde_json::json!({ "on": on });
        let request = self.http.post(self.url("/api/host/network")).bearer_auth(&self.token).json(&body);
        let switched: NetworkSwitched = checked(request.send().await?).await?.json().await?;
        Ok(switched.handled)
    }

    /// `POST /api/host/pairing/{id}`.
    pub async fn answer_pairing(&self, id: u64, answer: &PairingAnswer) -> Result<(), LinkError> {
        let request =
            self.http.post(self.url(&format!("/api/host/pairing/{id}"))).bearer_auth(&self.token).json(answer);
        checked(request.send().await?).await?;
        Ok(())
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

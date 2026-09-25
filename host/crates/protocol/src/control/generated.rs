// @generated from contract/host-control.schema.json by crates/protocol/tests/generated.rs.
// Do not edit: change the Zod schemas, run `pnpm schema`, then
// `UPDATE_PROTOCOL=1 cargo test -p inkup-protocol --test generated`.

///POST /api/host/activate
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Activated {
    ///false when the Host has no window to bring forward (the TUI, serve)
    pub handled: bool,
}
///an agent token not revoked; never its secret
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct AgentToken {
    ///epoch ms
    pub created_at: i64,
    pub id: ::std::string::String,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub last_used_at: ::std::option::Option<i64>,
    pub name: ::std::string::String,
}
///GET /api/host/changes?since=<seq>: answered at the next change, or after a while with no change
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Changes {
    ///pass it back as `since` to wait for the next change
    pub seq: i64,
}
///`ClientView`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ClientView {
    pub connected: bool,
    ///epoch ms
    pub created_at: i64,
    pub id: ::std::string::String,
    pub kind: ::std::string::String,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub last_seen_at: ::std::option::Option<i64>,
    pub name: ::std::string::String,
}
///the Client's answer to a command
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandOutcome {
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub message: ::std::option::Option<::std::string::String>,
    pub ok: bool,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub session_id: ::std::option::Option<::std::string::String>,
}
///POST /api/host/commands: what the TUI's keys do to a connected Client's Session
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct CommandRequest {
    pub client_id: CommandRequestClientId,
    pub command: HostCommand,
    ///set_draw_mode only: on or off
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub draw_mode: ::std::option::Option<bool>,
}
///`CommandRequestClientId`
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct CommandRequestClientId(::std::string::String);
impl ::std::ops::Deref for CommandRequestClientId {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<CommandRequestClientId> for ::std::string::String {
    fn from(value: CommandRequestClientId) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for CommandRequestClientId {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for CommandRequestClientId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for CommandRequestClientId {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for CommandRequestClientId {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///GET /api/host/state?timeline=<session id>
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ControlState {
    ///127.0.0.1:<port>
    pub address: ::std::string::String,
    pub control_api: ControlStateControlApi,
    pub kind: HostKind,
    ///set in network mode
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub network: ::std::option::Option<NetworkView>,
    ///whether POST /api/host/network can switch network mode on this Host
    pub network_switch: bool,
    ///pairing requests this Host asks about through the control API; empty when its terminal asks
    pub pending_pairing: ::std::vec::Vec<PairingPrompt>,
    pub state: HostState,
    ///a newer release, once the background check finds one
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub update: ::std::option::Option<::std::string::String>,
    pub version: ControlStateVersion,
}
///`ControlStateControlApi`
#[derive(::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct ControlStateControlApi(i64);
impl ::std::ops::Deref for ControlStateControlApi {
    type Target = i64;
    fn deref(&self) -> &i64 {
        &self.0
    }
}
impl ::std::convert::From<ControlStateControlApi> for i64 {
    fn from(value: ControlStateControlApi) -> Self {
        value.0
    }
}
impl ::std::convert::TryFrom<i64> for ControlStateControlApi {
    type Error = self::error::ConversionError;
    fn try_from(
        value: i64,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if ![2_i64].contains(&value) {
            Err("invalid value".into())
        } else {
            Ok(Self(value))
        }
    }
}
impl<'de> ::serde::Deserialize<'de> for ControlStateControlApi {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        Self::try_from(<i64>::deserialize(deserializer)?)
            .map_err(|e| { <D::Error as ::serde::de::Error>::custom(e.to_string()) })
    }
}
///`ControlStateVersion`
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct ControlStateVersion(::std::string::String);
impl ::std::ops::Deref for ControlStateVersion {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<ControlStateVersion> for ::std::string::String {
    fn from(value: ControlStateVersion) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for ControlStateVersion {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for ControlStateVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ControlStateVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for ControlStateVersion {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`HostCommand`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum HostCommand {
    #[serde(rename = "start_session")]
    StartSession,
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "set_draw_mode")]
    SetDrawMode,
}
impl ::std::fmt::Display for HostCommand {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::StartSession => f.write_str("start_session"),
            Self::Pause => f.write_str("pause"),
            Self::Resume => f.write_str("resume"),
            Self::Stop => f.write_str("stop"),
            Self::SetDrawMode => f.write_str("set_draw_mode"),
        }
    }
}
impl ::std::str::FromStr for HostCommand {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "start_session" => Ok(Self::StartSession),
            "pause" => Ok(Self::Pause),
            "resume" => Ok(Self::Resume),
            "stop" => Ok(Self::Stop),
            "set_draw_mode" => Ok(Self::SetDrawMode),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HostCommand {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HostCommand {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///host.json in the data dir, written by the Host holding host.lock once its server has bound
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct HostFile {
    ///the control API version the holder speaks; a number, not a literal, so a client of another version can read it and say so
    pub control_api: ::std::num::NonZeroU64,
    ///the Bearer token /api/host/* takes
    pub control_token: HostFileControlToken,
    pub kind: HostKind,
    pub pid: i64,
    pub port: ::std::num::NonZeroU64,
    ///epoch ms
    pub started_at: i64,
    ///the holder's release, e.g. "0.1.0"
    pub version: HostFileVersion,
}
///the Bearer token /api/host/* takes
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct HostFileControlToken(::std::string::String);
impl ::std::ops::Deref for HostFileControlToken {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<HostFileControlToken> for ::std::string::String {
    fn from(value: HostFileControlToken) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for HostFileControlToken {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for HostFileControlToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HostFileControlToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for HostFileControlToken {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///the holder's release, e.g. "0.1.0"
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct HostFileVersion(::std::string::String);
impl ::std::ops::Deref for HostFileVersion {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<HostFileVersion> for ::std::string::String {
    fn from(value: HostFileVersion) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for HostFileVersion {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for HostFileVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HostFileVersion {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for HostFileVersion {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///which kind of Host holds the data dir
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum HostKind {
    #[serde(rename = "tui")]
    Tui,
    #[serde(rename = "serve")]
    Serve,
    #[serde(rename = "desktop")]
    Desktop,
}
impl ::std::fmt::Display for HostKind {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Tui => f.write_str("tui"),
            Self::Serve => f.write_str("serve"),
            Self::Desktop => f.write_str("desktop"),
        }
    }
}
impl ::std::str::FromStr for HostKind {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "tui" => Ok(Self::Tui),
            "serve" => Ok(Self::Serve),
            "desktop" => Ok(Self::Desktop),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for HostKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for HostKind {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///what the TUI shows (inkup_server::HostState)
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct HostState {
    pub agent_tokens: ::std::vec::Vec<AgentToken>,
    pub clients: ::std::vec::Vec<ClientView>,
    pub items: ::std::vec::Vec<ItemView>,
    ///most recently updated first
    pub sessions: ::std::vec::Vec<SessionOverview>,
    ///of the Session asked for, else of the newest live Session
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub timeline: ::std::option::Option<Timeline>,
    pub watchers: ::std::vec::Vec<Watcher>,
}
///`ItemStatus`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum ItemStatus {
    #[serde(rename = "open")]
    Open,
    #[serde(rename = "in_progress")]
    InProgress,
    #[serde(rename = "resolved")]
    Resolved,
    #[serde(rename = "wont_fix")]
    WontFix,
    #[serde(rename = "needs_info")]
    NeedsInfo,
}
impl ::std::fmt::Display for ItemStatus {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Open => f.write_str("open"),
            Self::InProgress => f.write_str("in_progress"),
            Self::Resolved => f.write_str("resolved"),
            Self::WontFix => f.write_str("wont_fix"),
            Self::NeedsInfo => f.write_str("needs_info"),
        }
    }
}
impl ::std::str::FromStr for ItemStatus {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "open" => Ok(Self::Open),
            "in_progress" => Ok(Self::InProgress),
            "resolved" => Ok(Self::Resolved),
            "wont_fix" => Ok(Self::WontFix),
            "needs_info" => Ok(Self::NeedsInfo),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for ItemStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for ItemStatus {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///`ItemView`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct ItemView {
    ///the agent behind the latest resolution
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub agent: ::std::option::Option<::std::string::String>,
    pub category: ::std::string::String,
    ///item-<seq>, as agents see it
    pub id: ::std::string::String,
    ///the latest resolution's note
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub note: ::std::option::Option<::std::string::String>,
    pub prompt: ::std::string::String,
    pub session_id: ::std::string::String,
    ///when the latest resolution was made
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub since: ::std::option::Option<i64>,
    pub status: ItemStatus,
    pub title: ::std::string::String,
}
///POST /api/host/network
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NetworkRequest {
    pub on: bool,
}
///the Host restarts its server in the new mode after answering
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NetworkSwitched {
    ///false when this Host switches network mode in its own terminal
    pub handled: bool,
}
///network mode as the header shows it
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NetworkView {
    ///this machine's LAN addresses
    pub addresses: ::std::vec::Vec<::std::string::String>,
    ///where another machine reaches the Host
    pub base_url: ::std::string::String,
    ///the .local name, once claimed on mDNS
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub claimed: ::std::option::Option<::std::string::String>,
}
///a new agent token
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NewToken {
    ///epoch ms
    pub created_at: i64,
    pub id: ::std::string::String,
    pub name: ::std::string::String,
    ///the secret: shown once, stored nowhere but by its user
    pub token: NewTokenToken,
}
///POST /api/host/tokens
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct NewTokenRequest {
    ///who it is for, e.g. "claude-code on laptop"
    pub name: NewTokenRequestName,
}
///who it is for, e.g. "claude-code on laptop"
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct NewTokenRequestName(::std::string::String);
impl ::std::ops::Deref for NewTokenRequestName {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<NewTokenRequestName> for ::std::string::String {
    fn from(value: NewTokenRequestName) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for NewTokenRequestName {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() > 60usize {
            return Err("longer than 60 characters".into());
        }
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for NewTokenRequestName {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NewTokenRequestName {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for NewTokenRequestName {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///the secret: shown once, stored nowhere but by its user
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct NewTokenToken(::std::string::String);
impl ::std::ops::Deref for NewTokenToken {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<NewTokenToken> for ::std::string::String {
    fn from(value: NewTokenToken) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for NewTokenToken {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        if value.chars().count() < 1usize {
            return Err("shorter than 1 characters".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for NewTokenToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for NewTokenToken {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for NewTokenToken {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///POST /api/host/pairing/{id}; a request from another machine can only be denied
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct PairingAnswer {
    pub decision: PairingAnswerDecision,
}
///`PairingAnswerDecision`
#[derive(
    ::serde::Deserialize,
    ::serde::Serialize,
    Clone,
    Copy,
    Debug,
    Eq,
    Hash,
    Ord,
    PartialEq,
    PartialOrd
)]
pub enum PairingAnswerDecision {
    #[serde(rename = "approve")]
    Approve,
    #[serde(rename = "deny")]
    Deny,
}
impl ::std::fmt::Display for PairingAnswerDecision {
    fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
        match *self {
            Self::Approve => f.write_str("approve"),
            Self::Deny => f.write_str("deny"),
        }
    }
}
impl ::std::str::FromStr for PairingAnswerDecision {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        match value {
            "approve" => Ok(Self::Approve),
            "deny" => Ok(Self::Deny),
            _ => Err("invalid value".into()),
        }
    }
}
impl ::std::convert::TryFrom<&str> for PairingAnswerDecision {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for PairingAnswerDecision {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
///a pairing request waiting for the user
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct PairingPrompt {
    pub client_kind: ::std::string::String,
    pub client_name: ::std::string::String,
    ///answer it at POST /api/host/pairing/{id}
    pub id: i64,
    ///"Chrome extension "Work laptop" wants to connect"
    pub prompt: ::std::string::String,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub remote: ::std::option::Option<RemotePairing>,
}
///a pairing request from another machine (network mode): shown, not approved
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct RemotePairing {
    ///the 6-digit code the user types in the Client
    pub code: RemotePairingCode,
    ///the address the request came from
    pub from: ::std::string::String,
    ///inkup://pair?url=…&code=…, for a QR code
    pub link: ::std::string::String,
}
///the 6-digit code the user types in the Client
#[derive(::serde::Serialize, Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[serde(transparent)]
pub struct RemotePairingCode(::std::string::String);
impl ::std::ops::Deref for RemotePairingCode {
    type Target = ::std::string::String;
    fn deref(&self) -> &::std::string::String {
        &self.0
    }
}
impl ::std::convert::From<RemotePairingCode> for ::std::string::String {
    fn from(value: RemotePairingCode) -> Self {
        value.0
    }
}
impl ::std::str::FromStr for RemotePairingCode {
    type Err = self::error::ConversionError;
    fn from_str(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        static PATTERN: ::std::sync::LazyLock<::regress::Regex> = ::std::sync::LazyLock::new(||
        { ::regress::Regex::new("^[0-9]{6}$").unwrap() });
        if PATTERN.find(value).is_none() {
            return Err("doesn't match pattern \"^[0-9]{6}$\"".into());
        }
        Ok(Self(value.to_string()))
    }
}
impl ::std::convert::TryFrom<&str> for RemotePairingCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: &str,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl ::std::convert::TryFrom<::std::string::String> for RemotePairingCode {
    type Error = self::error::ConversionError;
    fn try_from(
        value: ::std::string::String,
    ) -> ::std::result::Result<Self, self::error::ConversionError> {
        value.parse()
    }
}
impl<'de> ::serde::Deserialize<'de> for RemotePairingCode {
    fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
    where
        D: ::serde::Deserializer<'de>,
    {
        ::std::string::String::deserialize(deserializer)?
            .parse()
            .map_err(|e: self::error::ConversionError| {
                <D::Error as ::serde::de::Error>::custom(e.to_string())
            })
    }
}
///`SessionOverview`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct SessionOverview {
    pub annotations: i64,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub client_id: ::std::option::Option<::std::string::String>,
    ///epoch ms
    pub created_at: i64,
    pub draft_items: i64,
    pub id: ::std::string::String,
    ///current Change Items
    pub items: i64,
    ///no session_end yet
    pub live: bool,
    ///current Change Items with no Resolution
    pub open_items: i64,
    ///live, and its latest pause is not followed by a resume
    pub paused: bool,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub t0: ::std::option::Option<i64>,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub title: ::std::option::Option<::std::string::String>,
    ///epoch ms
    pub updated_at: i64,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub url: ::std::option::Option<::std::string::String>,
}
///`Timeline`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Timeline {
    pub entries: ::std::vec::Vec<TimelineEntry>,
    pub session_id: ::std::string::String,
}
///`TimelineEntry`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct TimelineEntry {
    ///said, annotation, command, draft, comment or session
    pub kind: ::std::string::String,
    ///ms since the Session t0
    pub t: i64,
    pub text: ::std::string::String,
}
///an agent blocked in watch_items
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
pub struct Watcher {
    pub id: i64,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub session_id: ::std::option::Option<::std::string::String>,
    ///the item seq its cursor waits after, not a time
    pub since: i64,
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub url: ::std::option::Option<::std::string::String>,
}
/// Error types.
pub mod error {
    /// Error from a `TryFrom` or `FromStr` implementation.
    pub struct ConversionError(::std::borrow::Cow<'static, str>);
    impl ::std::error::Error for ConversionError {}
    impl ::std::fmt::Display for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Display::fmt(&self.0, f)
        }
    }
    impl ::std::fmt::Debug for ConversionError {
        fn fmt(
            &self,
            f: &mut ::std::fmt::Formatter<'_>,
        ) -> Result<(), ::std::fmt::Error> {
            ::std::fmt::Debug::fmt(&self.0, f)
        }
    }
    impl From<&'static str> for ConversionError {
        fn from(value: &'static str) -> Self {
            Self(value.into())
        }
    }
    impl From<String> for ConversionError {
        fn from(value: String) -> Self {
            Self(value.into())
        }
    }
}

//! A Remote Host's public URL (ADR 0030). Clients and agents are given this https origin and nothing else.
//! The process itself speaks HTTP on a bind address that is not advertised.

use std::net::{IpAddr, Ipv4Addr};

/// What the operator tells people to open. `https://host` or `https://host:port`, no path and no userinfo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicUrl {
    origin: String,
    host: String,
    /// The port in the URL, or 443 when the URL omits one.
    port: u16,
}

impl PublicUrl {
    /// Parses `raw`. `http://` is refused: a forwarded header is not proof of TLS. A refusal names the host only,
    /// never userinfo.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        let Ok(parsed) = url::Url::parse(raw) else {
            return Err(format!("a Remote Host's public URL must start with https:// ({})", shown_host(raw)));
        };
        let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
        if parsed.scheme() == "http" {
            return Err(format!(
                "a Remote Host's public URL must be https://, not http://{host}: the Host does not treat a forwarded header as TLS"
            ));
        }
        if parsed.scheme() != "https" {
            return Err(format!("a Remote Host's public URL must start with https:// ({})", shown_host(raw)));
        }
        if host.is_empty() {
            return Err("a Remote Host's public URL needs a host".into());
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("a Remote Host's public URL has no userinfo; a token goes in a header, never the URL".into());
        }
        if parsed.path() != "/" && parsed.path() != "" || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(
                "a Remote Host's public URL is an origin (https://host or https://host:port), with no path".into()
            );
        }
        if matches!(parsed.host(), Some(url::Host::Ipv6(_))) {
            return Err("a Remote Host's public URL host is a DNS name or an IPv4 address".into());
        }
        if !valid_host(&host) {
            return Err(format!("a Remote Host's public URL host must be a DNS name or an IPv4 address ({host})"));
        }
        let explicit_port = parsed.port().is_some();
        let port = parsed.port().unwrap_or(443);
        if port == 0 {
            return Err("a Remote Host's public URL port is not 0".into());
        }
        let origin = if explicit_port { format!("https://{host}:{port}") } else { format!("https://{host}") };
        Ok(Self { origin, host, port })
    }

    /// `https://host` or `https://host:port`.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// `<origin>/mcp`.
    pub fn mcp(&self) -> String {
        format!("{}/mcp", self.origin)
    }

    /// The public host, lower-cased, without a port.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The public URL's port (443 when the URL omitted one).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// `Host` is the public name alone, or that name with the public URL's port. The bind port is not required
    /// and is not enough: a proxy terminates TLS on the public port and dials the Host on another.
    pub fn admits_host_header(&self, host_header: &str) -> bool {
        if host_header.eq_ignore_ascii_case(&self.host) {
            return true;
        }
        let Some((name, found)) = host_header.rsplit_once(':') else {
            return false;
        };
        name.eq_ignore_ascii_case(&self.host) && found == self.port.to_string()
    }
}

/// How a Remote Host is reached, and where the process binds. The bind address is not advertised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteHost {
    pub public_url: PublicUrl,
    /// Default [`DEFAULT_BIND`]: every interface, for a container behind a proxy.
    pub bind: IpAddr,
}

/// A container's usual listen address. Not a name anyone is given.
pub const DEFAULT_BIND: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

/// A host safe to print: no userinfo, no path. A string that is not a URL comes back unchanged only when it has
/// no `@`.
fn shown_host(raw: &str) -> String {
    url::Url::parse(raw)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .or_else(|| raw.rsplit_once('@').map(|(_, host)| host.split(['/', '?', '#']).next().unwrap_or(host).to_owned()))
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "the host".into())
}

fn valid_host(host: &str) -> bool {
    if host.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    let labels: Vec<&str> = host.split('.').collect();
    !labels.is_empty()
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_https_origin_is_the_public_url() {
        let url = PublicUrl::parse("https://Review.Example").unwrap();
        assert_eq!(url.origin(), "https://review.example");
        assert_eq!(url.mcp(), "https://review.example/mcp");
        assert_eq!(url.port(), 443);
        assert!(url.admits_host_header("review.example"));
        assert!(url.admits_host_header("Review.Example"));
        assert!(url.admits_host_header("review.example:443"));
        assert!(!url.admits_host_header("review.example:47823"), "the bind port is not the public port");
        assert!(!url.admits_host_header("other.example"));
        assert!(!url.admits_host_header("review.example.evil"));

        let explicit = PublicUrl::parse("https://review.example:8443").unwrap();
        assert_eq!(explicit.origin(), "https://review.example:8443");
        assert_eq!(explicit.mcp(), "https://review.example:8443/mcp");
        assert!(explicit.admits_host_header("review.example"));
        assert!(explicit.admits_host_header("review.example:8443"));
        assert!(!explicit.admits_host_header("review.example:443"));
    }

    #[test]
    fn http_and_a_path_are_refused() {
        let http = PublicUrl::parse("http://review.example").unwrap_err();
        assert!(http.contains("https://"), "{http}");
        assert!(http.contains("not http://review.example"), "{http}");
        // Do not format these errors into the assertion. A message that echoed userinfo would otherwise
        // land in the failure output.
        let http_userinfo = PublicUrl::parse("http://user:secret@review.example/private").unwrap_err();
        assert!(http_userinfo.contains("http://review.example"));
        assert!(!http_userinfo.contains("secret"));
        assert!(!http_userinfo.contains("user"));
        let https_userinfo = PublicUrl::parse("https://user:secret@review.example").unwrap_err();
        assert!(https_userinfo.contains("userinfo"));
        assert!(!https_userinfo.contains("secret"));
        assert!(PublicUrl::parse("https://review.example/inkup").unwrap_err().contains("no path"));
        assert!(PublicUrl::parse("review.example").unwrap_err().contains("https://"));
        assert!(PublicUrl::parse("https://").unwrap_err().contains("host"));
    }
}

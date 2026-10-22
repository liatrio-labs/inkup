//! A Remote Host serving HTTPS from a certificate the test generates (rustls, no OpenSSL).
mod common;

use std::io::BufReader;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::Host;
use inkup_server::{Config, Control, PublicUrl, RemoteHost, TlsMaterial};
use inkup_store::Store;
use inkup_store::instance::HostKind;
use rcgen::CertificateParams;
use rcgen::KeyPair;

const CONTROL: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn remote(bind: std::net::IpAddr, tls: Option<TlsMaterial>) -> Config {
    Config {
        remote: Some(RemoteHost { public_url: PublicUrl::parse("https://review.example").unwrap(), bind }),
        tls,
        control: Some(Control {
            token: CONTROL.into(),
            kind: HostKind::Serve,
            on_activate: None,
            on_network: None,
            update: None,
        }),
        ..Config::default()
    }
}

/// A self-signed certificate for `localhost`, written as PEM. The test's rustls client is the only thing that trusts it.
fn write_cert(dir: &Path, name: &str) -> (PathBuf, PathBuf, String) {
    let key = KeyPair::generate().unwrap();
    let params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
    let cert = params.self_signed(&key).unwrap();
    let cert_path = dir.join(format!("{name}-cert.pem"));
    let key_path = dir.join(format!("{name}-key.pem"));
    let pem = cert.pem();
    std::fs::write(&cert_path, &pem).unwrap();
    std::fs::write(&key_path, key.serialize_pem()).unwrap();
    (cert_path, key_path, pem)
}

async fn https(addr: std::net::SocketAddr, ca_pem: &str, request: &str) -> (u16, String) {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    let mut reader = BufReader::new(ca_pem.as_bytes());
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut reader) {
        roots.add(cert.unwrap()).unwrap();
    }
    let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(name, tcp).await.unwrap();
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    tls.write_all(request.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    tls.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf).into_owned();
    let status = text.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("0").parse().unwrap_or(0);
    (status, text)
}

fn initialize(host: &str, extra: &str) -> String {
    let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}"#;
    format!(
        "POST /mcp HTTP/1.1\r\nHost: {host}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn an_idle_tcp_socket_does_not_stall_https_health() {
    let finished = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key, pem) = write_cert(dir.path(), "host");
        let host = Host::start_with(remote(
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            Some(TlsMaterial { cert, key }),
        ))
        .await;
        let addr = host.addr();
        let port = addr.port();
        let idle = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        let health = tokio::time::timeout(std::time::Duration::from_secs(2), https(addr, &pem, &request))
            .await
            .expect("health waited on the idle handshake");
        assert_eq!(health.0, 200, "{}", health.1);
        drop(idle);
    })
    .await;
    finished.expect("an idle handshake stalled the listener");
}

#[tokio::test]
async fn a_rustls_client_that_trusts_the_certificate_initializes_mcp() {
    let dir = tempfile::tempdir().unwrap();
    let (cert, key, pem) = write_cert(dir.path(), "host");
    let host =
        Host::start_with(remote(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), Some(TlsMaterial { cert, key })))
            .await;
    let addr = host.addr();
    let port = addr.port();
    let (status, body) = https(addr, &pem, &initialize(&format!("127.0.0.1:{port}"), "")).await;
    assert_eq!(status, 401, "{body}");
    assert!(body.to_ascii_lowercase().contains("www-authenticate: bearer"), "{body}");

    let agent = host.store.create_agent_token("reviewer-a").unwrap();
    let (status, body) = https(
        addr,
        &pem,
        &initialize(&format!("127.0.0.1:{port}"), &format!("Authorization: Bearer {}\r\n", agent.token)),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("serverInfo") || body.contains("protocolVersion"), "{body}");
}

#[tokio::test]
async fn an_unreadable_or_mismatched_key_is_refused_before_bind() {
    let dir = tempfile::tempdir().unwrap();
    let (cert, _key, _) = write_cert(dir.path(), "one");
    let (_other_cert, other_key, _) = write_cert(dir.path(), "two");
    let missing = dir.path().join("missing-key.pem");
    let store = Arc::new(Store::open(dir.path()).unwrap());

    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = match inkup_server::start(
        Arc::clone(&store),
        Config {
            port,
            ..remote(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                Some(TlsMaterial { cert: cert.clone(), key: missing.clone() }),
            )
        },
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("an unreadable key"),
    };
    assert!(err.to_string().contains(&missing.display().to_string()), "{err}");
    TcpListener::bind(("127.0.0.1", port)).expect("the port was not taken");

    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let err = match inkup_server::start(
        store,
        Config {
            port,
            ..remote(
                std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                Some(TlsMaterial { cert, key: other_key.clone() }),
            )
        },
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("a mismatched key"),
    };
    let message = err.to_string();
    assert!(message.contains(&other_key.display().to_string()), "{message}");
    TcpListener::bind(("127.0.0.1", port)).expect("the port was not taken");
}

#[tokio::test]
async fn tls_without_a_remote_host_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (cert, key, _) = write_cert(dir.path(), "host");
    let err = match inkup_server::start(
        Arc::new(Store::open(dir.path()).unwrap()),
        Config { tls: Some(TlsMaterial { cert, key }), ..Config::default() },
    )
    .await
    {
        Err(error) => error,
        Ok(_) => panic!("tls needs a remote host"),
    };
    assert!(err.to_string().contains("Network mode stays unencrypted"), "{err}");
}

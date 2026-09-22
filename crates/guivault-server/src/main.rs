use guivault_server::config::Config;
use tracing_subscriber::EnvFilter;

/// `guivault healthcheck` : un GET sur `/api/v1/health` du serveur local, en
/// std pur (pas de client HTTP embarqué). C'est le HEALTHCHECK de l'image
/// Docker, qui n'a ni curl ni wget.
fn healthcheck() -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let bind: std::net::SocketAddr = std::env::var("GUIVAULT_BIND")
        .ok()
        .and_then(|b| b.parse().ok())
        .unwrap_or_else(|| "0.0.0.0:8080".parse().unwrap());
    let target = std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), bind.port());
    let mut s = std::net::TcpStream::connect_timeout(&target, std::time::Duration::from_secs(3))?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
    s.write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut buf = String::new();
    s.read_to_string(&mut buf)?;
    anyhow::ensure!(
        buf.starts_with("HTTP/1.1 200"),
        "réponse inattendue : {}",
        buf.lines().next().unwrap_or("")
    );
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }
    let config = Config::from_env()?;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,sqlx=warn"));
    if config.log_json {
        tracing_subscriber::fmt().json().with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        registration = ?config.registration,
        trust_proxy = %config.trust_proxy,
        "démarrage de GuiVault"
    );

    guivault_server::serve(config, |addr| tracing::info!(%addr, "à l'écoute"), async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("installation du handler SIGTERM");
            tokio::select! {
                _ = ctrl_c => {}
                _ = term.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
        }
        tracing::info!("arrêt demandé");
    })
    .await
}

//! Où l'agent écoute : le tube nommé d'OpenSSH pour Windows, que `ssh.exe`,
//! `git` et les autres trouvent sans réglage ; une socket Unix ailleurs (le
//! développement et les tests). Chaque client a sa connexion, et sa
//! [`Session`] — ce qu'il a annoncé de son serveur ne vaut que pour lui.
use super::{Agent, Client, Session, protocol};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Le tube où `ssh.exe` cherche l'agent par défaut — celui du service
/// « OpenSSH Authentication Agent » de Windows, qui doit être arrêté.
#[cfg(windows)]
pub const PIPE_NAME: &str = r"\\.\pipe\openssh-ssh-agent";

pub fn default_endpoint() -> Result<String, String> {
    #[cfg(windows)]
    {
        Ok(PIPE_NAME.to_string())
    }
    #[cfg(not(windows))]
    {
        let dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        Ok(dir.join("guivault-ssh-agent.sock").to_string_lossy().into_owned())
    }
}

/// L'agent en marche. Le lâcher l'arrête (et efface la socket).
pub struct Running {
    pub endpoint: String,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}

/// Répond aux trames d'un client jusqu'à ce qu'il raccroche.
pub async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, agent: Arc<Agent>, client: Client) {
    let mut session = Session {
        client,
        bindings: Vec::new(),
    };
    let mut len = [0u8; 4];
    loop {
        if stream.read_exact(&mut len).await.is_err() {
            return;
        }
        let n = u32::from_be_bytes(len) as usize;
        if n == 0 || n > protocol::MAX_FRAME {
            return;
        }
        let mut payload = vec![0u8; n];
        if stream.read_exact(&mut payload).await.is_err() {
            return;
        }
        let reply = agent.handle(&payload, &mut session).await;
        if stream.write_all(&protocol::frame(&reply)).await.is_err() {
            return;
        }
    }
}

#[cfg(unix)]
pub async fn start(endpoint: &str, agent: Arc<Agent>) -> Result<Running, String> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    let path = std::path::PathBuf::from(endpoint);
    if path.exists() {
        if UnixStream::connect(&path).await.is_ok() {
            return Err(format!("un autre agent écoute déjà sur {endpoint}"));
        }
        // Une socket laissée par une instance qui s'est mal arrêtée.
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(&path).map_err(|e| format!("impossible d'écouter sur {endpoint} : {e}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let task = tauri::async_runtime::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let pid = stream
                .peer_cred()
                .ok()
                .and_then(|c| c.pid())
                .and_then(|p| u32::try_from(p).ok());
            #[cfg(target_os = "linux")]
            let program = pid
                .and_then(|p| std::fs::read_to_string(format!("/proc/{p}/comm")).ok())
                .map(|s| s.trim().to_string());
            #[cfg(not(target_os = "linux"))]
            let program = None;
            tauri::async_runtime::spawn(serve(stream, agent.clone(), Client { pid, program }));
        }
    });
    Ok(Running {
        endpoint: endpoint.to_string(),
        task,
    })
}

#[cfg(windows)]
pub async fn start(endpoint: &str, agent: Arc<Agent>) -> Result<Running, String> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let name = endpoint.to_string();
    // `first_pipe_instance` : si le tube existe déjà, c'est un autre agent
    // (le service de Windows) — on ne s'installe pas à côté. Les clients
    // distants sont refusés (défaut de tokio), et le descripteur de sécurité
    // par défaut ne donne l'écriture qu'à l'utilisateur et aux
    // administrateurs.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&name)
        .map_err(|_| "agent_busy".to_string())?;
    let task = tauri::async_runtime::spawn(async move {
        loop {
            if server.connect().await.is_err() {
                continue;
            }
            let connected = server;
            server = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(_) => return,
            };
            let client = pipe_client(&connected);
            tauri::async_runtime::spawn(serve(connected, agent.clone(), client));
        }
    });
    Ok(Running {
        endpoint: endpoint.to_string(),
        task,
    })
}

/// Le processus au bout du tube : son pid, et le nom de son exécutable
/// (« ssh », « git »…).
#[cfg(windows)]
fn pipe_client(pipe: &tokio::net::windows::named_pipe::NamedPipeServer) -> Client {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };

    let mut pid = 0u32;
    // SAFETY: le handle est celui du tube, vivant le temps de l'appel ; `pid`
    // est un u32 où l'appel écrit.
    if unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as _, &mut pid) } == 0 {
        return Client::default();
    }
    // SAFETY: un handle de processus en lecture limitée, refermé plus bas ;
    // `buf` vit le temps de l'appel et `len` dit sa taille en u16.
    let program = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            None
        } else {
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(process);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    };
    let program = program.and_then(|p| {
        std::path::Path::new(&p)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
    });
    Client {
        pid: Some(pid),
        program,
    }
}

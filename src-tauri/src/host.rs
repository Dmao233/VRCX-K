use crate::kkrpc_stdio::Peer;
use crate::process_tree::ProcessTree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HostReady {
    pub port: u16,
    pub token: String,
}

pub struct HostSession {
    pub tree: ProcessTree,
    pub peer: Arc<Peer>,
    pub ready: HostReady,
}

#[derive(Default)]
pub struct HostState {
    pub ready: Mutex<Option<HostReady>>,
    tree: Mutex<Option<ProcessTree>>,
    pub peer: Mutex<Option<Arc<Peer>>>,
}

impl HostState {
    pub fn store(&self, session: HostSession) -> HostReady {
        let ready = session.ready.clone();
        *self.ready.lock().expect("ready") = Some(ready.clone());
        *self.peer.lock().expect("peer") = Some(session.peer);
        *self.tree.lock().expect("tree") = Some(session.tree);
        ready
    }

    pub fn snapshot(&self) -> Option<HostReady> {
        self.ready.lock().expect("ready").clone()
    }

    pub fn kill(&self) {
        if let Some(mut tree) = self.tree.lock().expect("tree").take() {
            tree.kill_tree();
        }
        *self.peer.lock().expect("peer") = None;
        *self.ready.lock().expect("ready") = None;
    }
}

pub fn spawn_host() -> Result<HostSession, String> {
    let bun = find_bun();
    let host_dir = host_dir();
    if !host_dir.join("src/index.ts").is_file() {
        return Err(format!("host entry missing at {}", host_dir.display()));
    }

    let mut cmd = Command::new(&bun);
    cmd.arg("src/index.ts")
        .current_dir(&host_dir)
        .env("VRCXK_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut tree = ProcessTree::spawn(&mut cmd)
        .map_err(|err| format!("spawn {} in {}: {err}", bun.display(), host_dir.display()))?;

    let stdout = tree.child_stdout().ok_or("host stdout")?;
    let stdin = tree.child_stdin().ok_or("host stdin")?;
    let peer = Peer::start(stdout, stdin);
    let ready_slot: Arc<Mutex<Option<HostReady>>> = Arc::new(Mutex::new(None));
    let ready_handler = Arc::clone(&ready_slot);
    peer.on(
        "ready",
        Arc::new(move |args| {
            if let Some(info) = args.first() {
                if let (Some(port), Some(token)) = (
                    info.get("port").and_then(|v| v.as_u64()),
                    info.get("token").and_then(|v| v.as_str()),
                ) {
                    *ready_handler.lock().expect("ready slot") = Some(HostReady {
                        port: port as u16,
                        token: token.to_string(),
                    });
                }
            }
            serde_json::Value::Null
        }),
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    let ready = loop {
        if let Some(ready) = ready_slot.lock().expect("ready slot").clone() {
            break ready;
        }
        if Instant::now() >= deadline {
            tree.kill_tree();
            return Err("host did not call ready() within 10s".into());
        }
        if let Ok(Some(status)) = tree.try_wait() {
            return Err(format!("host exited before ready: {status}"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let pong = peer
        .call("ping", vec![])
        .map_err(|err| format!("host ping: {err}"))?;
    if pong != serde_json::json!("pong") {
        tree.kill_tree();
        return Err(format!("host ping returned {pong}"));
    }

    Ok(HostSession { tree, peer, ready })
}

fn bun_exe() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

fn find_bun() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_BUN") {
        return PathBuf::from(explicit);
    }
    let name = bun_exe();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let candidate = PathBuf::from(home).join(".bun/bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    if let Some(found) = find_on_path(name) {
        return found;
    }
    PathBuf::from(name)
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        if !candidate.is_file() {
            return None;
        }
        if candidate.extension().and_then(|ext| ext.to_str()) == Some("ps1") {
            return None;
        }
        Some(candidate)
    })
}

fn host_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("VRCXK_HOST_DIR") {
        return PathBuf::from(explicit);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../host")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("../host"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_tree::pid_alive;

    #[test]
    fn spawn_host_ready_ping_stop() {
        let mut session = spawn_host().expect("spawn host");
        let pong = session.peer.call("ping", vec![]).expect("ping");
        assert_eq!(pong, serde_json::json!("pong"));
        let stopped = session.peer.call("stop", vec![]).expect("stop");
        assert_eq!(stopped, serde_json::json!(true));
        let status = session.tree.wait().expect("wait host");
        assert!(status.success(), "{status}");
    }

    #[test]
    fn call_times_out_after_host_dies() {
        let mut session = spawn_host().expect("spawn host");
        let pid = session.tree.id();
        session.tree.kill_tree();
        assert!(!pid_alive(pid));
        let started = Instant::now();
        let err = session
            .peer
            .call_timeout("ping", vec![], Duration::from_secs(2));
        assert!(err.is_err(), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn find_bun_uses_platform_exe_name() {
        let name = bun_exe();
        assert_eq!(name.ends_with(".exe"), cfg!(windows));
        assert_ne!(name, "bun.ps1");
        let bun = find_bun();
        assert_ne!(bun.extension().and_then(|ext| ext.to_str()), Some("ps1"));
    }
}

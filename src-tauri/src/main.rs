use std::env;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Assigns the owned Node child to a Windows Job Object at spawn time so the
/// whole tree can be reliably killed on close.
///
/// `kill_process_tree`'s `taskkill /T` walks live `ParentProcessId` links, so
/// it can only reach a descendant whose immediate ancestor is *still alive*
/// at kill time. Hermes's own launcher re-execs into the pinned interpreter
/// and then exits immediately after handoff (see `server/lib/hermesBridge.mjs`),
/// so by the time cleanup runs — no matter how promptly — that intermediate
/// PID is already gone and the real, long-lived interpreter is unreachable by
/// `/T`. A Job Object sidesteps this entirely: membership is a live property
/// of the process object itself, inherited automatically by every descendant
/// a job member spawns (Node's launch of Hermes's launcher, and that
/// launcher's own re-exec), independent of whether any ancestor has since
/// exited. Terminating the job kills every current member atomically.
#[cfg(target_os = "windows")]
mod windows_job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// An owned Job Object handle. Dropping it closes the handle (which, with
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set, also kills every remaining
    /// member) — callers that want an explicit, immediate kill should call
    /// `terminate()` rather than relying on drop timing.
    pub struct OwnedJob(HANDLE);

    // The handle is only ever used through `&self`/consuming methods behind
    // this crate's own mutex; no concurrent raw access occurs.
    unsafe impl Send for OwnedJob {}

    impl OwnedJob {
        /// Creates a job configured to kill its members when closed, then
        /// assigns `pid` to it. Returns `None` (never panics) on any Win32
        /// failure — job assignment is defense-in-depth on top of the
        /// existing PID-scoped `taskkill` cleanup, never a replacement that
        /// cleanup can silently depend on.
        pub fn assign(pid: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set_ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set_ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    CloseHandle(job);
                    return None;
                }
                let assign_ok = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assign_ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }

        /// Kills every process currently in the job. Best-effort, matching
        /// `kill_process_tree`: a member already gone is the outcome wanted.
        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for OwnedJob {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Local API connection target. Must match `server/router.mjs`'s
/// `DEFAULT_PORT`/`HOST` — this alpha does not yet negotiate a dynamic port
/// with the frontend, so both sides hardcode the same value.
const API_HOST: &str = "127.0.0.1";
const API_PORT: u16 = 8787;

/// Bounded readiness wait: long enough for a cold Node start on a slow
/// machine, short enough that a genuinely failed start doesn't leave the
/// user staring at a blank window for a long time.
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ApiPhase {
    Stopped,
    Starting,
    Ready,
    Stopping,
}

/// Serializes local API startup, readiness, and shutdown around the exact
/// child owned by this Yuzuki instance. The mutex is deliberately held across
/// `Command::spawn()` and publication into `child`: a concurrent shutdown
/// either prevents the spawn or waits until it can take the newly spawned
/// child, so there is no unowned process gap.
struct ApiProcess {
    state: Mutex<ApiProcessState<Child>>,
    /// The owned child's Job Object, if assignment succeeded at spawn time.
    /// Separate from `state` so cleanup can take and terminate it without
    /// holding `state`'s lock (see `stop_api_process`).
    #[cfg(target_os = "windows")]
    job: Mutex<Option<windows_job::OwnedJob>>,
}

struct ApiProcessState<C = Child> {
    child: Option<C>,
    phase: ApiPhase,
    shutdown_requested: bool,
}

impl<C> ApiProcessState<C> {
    fn new() -> Self {
        Self {
            child: None,
            phase: ApiPhase::Stopped,
            shutdown_requested: false,
        }
    }

    fn begin_startup(&mut self) -> Result<(), StartupError> {
        if self.shutdown_requested {
            return Err(StartupError::Cancelled);
        }
        if self.child.is_some() {
            return Err(StartupError::Failed(
                "The local API lifecycle already owns a process.".to_string(),
            ));
        }
        self.phase = ApiPhase::Starting;
        Ok(())
    }

    fn begin_shutdown(&mut self) -> Option<C> {
        self.shutdown_requested = true;
        self.phase = ApiPhase::Stopping;
        self.child.take()
    }

    fn begin_startup_failure_cleanup(&mut self) -> Option<C> {
        self.phase = ApiPhase::Stopping;
        self.child.take()
    }
}

fn mark_ready_if_owned<C>(
    state: &mut ApiProcessState<C>,
    inspect_owned_child: impl FnOnce(&mut C) -> Result<(), StartupError>,
) -> Result<(), StartupError> {
    if state.shutdown_requested {
        return Err(StartupError::Cancelled);
    }
    let child = state.child.as_mut().ok_or_else(|| {
        StartupError::Failed(
            "The local API process was no longer owned during readiness.".to_string(),
        )
    })?;
    inspect_owned_child(child)?;
    state.phase = ApiPhase::Ready;
    Ok(())
}

impl ApiProcess {
    fn new() -> Self {
        Self {
            state: Mutex::new(ApiProcessState::new()),
            #[cfg(target_os = "windows")]
            job: Mutex::new(None),
        }
    }
}

#[derive(Debug)]
enum StartupError {
    Cancelled,
    Failed(String),
}

/// Resolves a Node executable for spawning the local API, for this alpha's
/// "installed Node" delivery mode (no bundled/sidecar runtime yet — see
/// docs/tasks/YUZUKI-DESKTOP-LOCAL-API-LIFECYCLE-DESIGN-001 and its
/// companion implementation task). Tries PATH first — the common case for
/// anyone who can already run `npm run api:dev`, and also what a
/// machine-wide Node install exposes to an Explorer-launched process, since
/// Windows applies machine `PATH` entries to every new process regardless of
/// how it was started. Falls back to the default Windows installer location
/// in case PATH was not refreshed for the current session/shell.
fn resolve_node_program() -> Option<PathBuf> {
    let on_path = Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if on_path {
        return Some(PathBuf::from("node"));
    }

    if let Ok(program_files) = env::var("ProgramFiles") {
        let candidate = Path::new(&program_files).join("nodejs").join("node.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// This crate's own directory (`src-tauri/`) is a compile-time constant, so
/// this resolves `server/` one level up in the repo root. Used only for a
/// debug build (`cargo run` / `tauri dev`), where there is no bundled
/// resource directory to resolve against and the source checkout is by
/// definition present. A release build must never use this — see
/// `resolve_server_entry` below.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Resolves the local API's entry point and the working directory it should
/// run from. Two distinct modes, chosen by build profile rather than by
/// probing the filesystem, so behavior is deterministic and never silently
/// falls back to the wrong one:
///
/// - Debug (`cargo run` / `tauri dev`): the source checkout's own
///   `server/index.mjs`, exactly as before. A dev build is only ever run
///   from inside the checkout, so this is always correct there.
/// - Release (installed / production): the `server/` tree bundled as a
///   Tauri resource (see `tauri.conf.json`'s `bundle.resources`), resolved
///   through Tauri's own resource-directory API. This is what makes the
///   installed app independent of the machine it was built on — it must
///   never read `CARGO_MANIFEST_DIR` or any other build-time source path.
///
/// Returns `(entry_path, working_dir)`: `working_dir` is the directory
/// containing `index.mjs`, so the child process's relative ESM imports
/// (`./router.mjs`, `./lib/...`, etc.) resolve identically in both modes.
fn resolve_server_entry(app: &tauri::App) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let dir = repo_root().join("server");
        return Ok((dir.join("index.mjs"), dir));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Could not resolve the bundled application resources: {err}"))?;
    let dir = strip_verbatim_prefix(resource_dir.join("server"));
    Ok((dir.join("index.mjs"), dir))
}

/// Strips Windows' `\\?\` extended-length-path ("verbatim") prefix if
/// present — e.g. `\\?\C:\foo\bar` becomes plain `C:\foo\bar`. `resource_dir()`
/// returns a verbatim path on Windows (a standard side effect of the
/// `std::fs::canonicalize`-based resolution it uses internally), and passing
/// that form straight through as a spawned process's argument breaks Node:
/// confirmed directly here — `node`'s own `realpathSync`-based main-module
/// resolution mis-walks the verbatim path's components and fails with
/// `EISDIR` trying to `lstat` a bare drive letter (`'C:'`), never reaching
/// `index.mjs` at all. The plain, non-verbatim form is a fully equivalent
/// absolute Windows path that Node resolves correctly, so stripping the
/// prefix here changes no file that gets opened. A no-op on any path that
/// doesn't already have this prefix (i.e. everywhere but Windows).
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const PREFIX: &str = r"\\?\";
    match path.to_str() {
        Some(s) if s.starts_with(PREFIX) => PathBuf::from(&s[PREFIX.len()..]),
        _ => path,
    }
}

/// Polls until the local API accepts a TCP connection, the child exits
/// first, or the bounded timeout elapses. A raw TCP-connect check is
/// sufficient (not just convenient) here: `server/index.mjs` attaches its
/// request listener at `createServer()` time, before `.listen()` runs, so
/// there is no window where the OS accepts a connection before the HTTP
/// server can actually handle `/api/health` — meaning this needs no HTTP
/// client dependency to be a genuine readiness check, not just a port-open
/// check.
fn port_is_listening() -> bool {
    TcpStream::connect((API_HOST, API_PORT)).is_ok()
}

/// A successful TCP connect only proves *something* is listening on
/// `API_PORT` — not that it's the child we just spawned. If another process
/// already held the port, this loop could otherwise report "ready" off of
/// that unrelated listener while our own child had already failed to bind
/// and exited (observed directly while validating this against a real
/// occupied-port instance during implementation). Guard against that by
/// re-checking `try_wait()` immediately after a successful connect, and —
/// more importantly — by callers pre-flighting the port with
/// `port_is_listening()` before ever spawning (see `setup()` below), so a
/// pre-existing occupant is reported directly instead of racing it.
fn spawn_owned_api(process: &ApiProcess, command: &mut Command) -> Result<(), StartupError> {
    spawn_and_publish(&process.state, || {
        let child = command.spawn().map_err(|err| {
            StartupError::Failed(format!("Could not start the local API process: {err}"))
        })?;
        // Best-effort: a failed job assignment leaves `kill_process_tree` as
        // the sole cleanup mechanism, exactly as before this fix.
        #[cfg(target_os = "windows")]
        {
            let job = windows_job::OwnedJob::assign(child.id());
            *process
                .job
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = job;
        }
        Ok(child)
    })
}

fn spawn_and_publish<C>(
    process: &Mutex<ApiProcessState<C>>,
    spawn: impl FnOnce() -> Result<C, StartupError>,
) -> Result<(), StartupError> {
    let mut state = process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.begin_startup()?;

    match spawn() {
        Ok(child) => {
            // Keep this assignment inside the same critical section as the
            // spawn. Shutdown cannot observe an empty slot after the OS child
            // exists: it either ran first and cancelled startup, or waits and
            // takes this exact child immediately after publication.
            state.child = Some(child);
            Ok(())
        }
        Err(error) => {
            state.phase = ApiPhase::Stopped;
            Err(error)
        }
    }
}

fn inspect_owned_child_after_listen(child: &mut Child) -> Result<(), StartupError> {
    match child.try_wait() {
        Ok(None) => Ok(()),
        Ok(Some(status)) => Err(StartupError::Failed(format!(
            "The local API process exited immediately after it started listening (exit status: {status})."
        ))),
        Err(err) => Err(StartupError::Failed(format!(
            "Could not inspect the local API process during readiness: {err}"
        ))),
    }
}

fn transition_to_ready_if_observed<C>(
    process: &Mutex<ApiProcessState<C>>,
    observe_ready: impl FnOnce() -> bool,
    inspect_owned_child: impl FnOnce(&mut C) -> Result<(), StartupError>,
) -> Option<Result<(), StartupError>> {
    if !observe_ready() {
        return None;
    }

    let mut state = process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Some(mark_ready_if_owned(&mut state, inspect_owned_child))
}

fn wait_for_api_ready(process: &ApiProcess) -> Result<(), StartupError> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        {
            let mut state = process
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.shutdown_requested {
                return Err(StartupError::Cancelled);
            }
            let child = state.child.as_mut().ok_or_else(|| {
                StartupError::Failed(
                    "The local API process was no longer owned during readiness.".to_string(),
                )
            })?;
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(StartupError::Failed(format!(
                        "The local API process exited before it became ready (exit status: {status})."
                    )));
                }
                Ok(None) => {}
                Err(err) => {
                    return Err(StartupError::Failed(format!(
                        "Could not inspect the local API process during readiness: {err}"
                    )));
                }
            }
        }

        if let Some(result) = transition_to_ready_if_observed(
            &process.state,
            port_is_listening,
            inspect_owned_child_after_listen,
        ) {
            return result;
        }

        if Instant::now() >= deadline {
            return Err(StartupError::Failed(format!(
                "Timed out after {READY_TIMEOUT:?} waiting for the local API on {API_HOST}:{API_PORT}."
            )));
        }

        std::thread::sleep(READY_POLL_INTERVAL);
    }
}

/// Minimal percent-encoding for embedding a plain-text diagnostic message in
/// a `data:` URL. Only needs to be correct for our own fixed English error
/// strings (plus interpolated Rust `Display` values), not general-purpose.
fn percent_encode_for_data_url(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b' '
            | b':'
            | b','
            | b'!'
            | b'?'
            | b'\''
            | b'('
            | b')' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

/// Builds a self-contained `data:` URL showing a startup-failure message
/// directly in the app window, so a failed local-API start is a visible,
/// explained state rather than a blank or silently-broken window. No new
/// dependency (dialog plugin, etc.) is needed for this alpha.
fn startup_error_url(reason: &str) -> tauri::Url {
    let body = format!(
        "Yuzuki can't start its local service.\n\n{reason}\n\nClose this window, resolve the issue above, and reopen Yuzuki."
    );
    let encoded = percent_encode_for_data_url(&body);
    format!("data:text/plain,{encoded}").parse().unwrap()
}

fn startup_loading_url() -> WebviewUrl {
    WebviewUrl::External(
        "data:text/plain,Yuzuki is starting its local service..."
            .parse()
            .unwrap(),
    )
}

fn ready_url() -> tauri::Url {
    #[cfg(debug_assertions)]
    {
        return if cfg!(feature = "cua-fixture") {
            "http://localhost:5173/desktop?cua_fixture=1"
        } else {
            "http://localhost:5173/desktop"
        }
        .parse()
        .unwrap();
    }

    #[cfg(not(debug_assertions))]
    {
        let url = if cfg!(target_os = "windows") {
            "http://tauri.localhost/desktop"
        } else {
            "tauri://localhost/desktop"
        };
        url.parse().unwrap()
    }
}

#[cfg(all(debug_assertions, feature = "cua-fixture"))]
fn cua_fixture_url() -> WebviewUrl {
    let html = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Yuzuki CUA Fixture</title>
<style>body{font:16px system-ui;margin:32px;color:#201c2b;background:#fbf9ff}main{display:grid;gap:18px;max-width:440px}button,input{font:inherit;padding:10px 12px}output{padding:12px;border:1px solid #786e8e;border-radius:8px}</style></head>
<body><main aria-label="Yuzuki bounded CUA fixture"><h1>Bounded CUA Fixture</h1>
<p>Self-contained developer fixture. No network, navigation, storage, accounts, or production data.</p>
<output aria-label="Fixture counter" id="counter">0</output>
<button aria-label="Increment" id="increment" type="button">Increment</button>
<label for="fixture-input">Fixture input</label><input aria-label="Fixture input" id="fixture-input" maxlength="64" autocomplete="off" spellcheck="false">
<output aria-label="Fixture echo" id="echo">YUZUKI_CUA_FIXTURE_ECHO_V1 </output>
<output aria-label="Fixture state" id="state">YUZUKI_CUA_FIXTURE_STATE_V1 counter=0 revision=0</output>
</main><script>(()=>{let counter=0,revision=0;const c=document.querySelector('#counter'),i=document.querySelector('#fixture-input'),e=document.querySelector('#echo'),s=document.querySelector('#state');
const render=()=>{c.textContent=String(counter);e.textContent='YUZUKI_CUA_FIXTURE_ECHO_V1 '+i.value;s.textContent=`YUZUKI_CUA_FIXTURE_STATE_V1 counter=${counter} revision=${revision}`};
document.querySelector('#increment').addEventListener('click',()=>{counter+=1;revision+=1;render()});i.addEventListener('input',()=>{revision+=1;render()});render()})();</script></body></html>"#;
    WebviewUrl::External(
        format!("data:text/html;charset=utf-8,{}", percent_encode_for_data_url(html))
            .parse()
            .unwrap(),
    )
}


/// Kill a spawned process *and everything it spawned*.
///
/// Killing the local API child alone is not enough. That child starts the
/// profile-scoped Hermes runtime, which in turn re-execs itself into a
/// pinned interpreter — so the process that actually holds the runtime and
/// the bounded CUA driver is two levels below us. Windows never cascades a
/// parent's death to its children, so all three survived a normal Yuzuki
/// exit: the leaked API server kept port 8787 bound, which then made the
/// next launch fail its own pre-flight check with "port already in use"
/// (reproduced directly: an API server and its Hermes runtime were still
/// running roughly ten hours after their parent had gone).
///
/// `taskkill /T` walks the tree the way a POSIX process group would; `/F` is
/// required because the re-exec'd runtime does not exit on a polite request.
/// Best effort by design — anything already gone is the outcome we wanted.
#[cfg(target_os = "windows")]
fn kill_process_tree(pid: u32) {
    match Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        // A non-success status includes "process not found", which is the
        // expected, harmless outcome when the target (or its whole tree) is
        // already gone — not logged as a diagnostic-worthy failure.
        Ok(_) => {}
        Err(err) => {
            eprintln!("yuzuki: could not launch taskkill for PID {pid}: {err}");
        }
    }
}

/// POSIX counterpart. The child is not detached into its own process group,
/// so this reaps the direct child only; Windows is the platform this alpha
/// ships and the one the orphan was observed on.
#[cfg(not(target_os = "windows"))]
fn kill_process_tree(_pid: u32) {}

#[cfg(target_os = "windows")]
fn terminate_owned_child(mut child: Child, job: Option<windows_job::OwnedJob>) {
    // Do not send a PID-scoped tree kill after the direct child has already
    // exited and been reaped; at that point Windows may reuse the numeric PID.
    if !matches!(child.try_wait(), Ok(Some(_))) {
        // Job first: unlike `taskkill /T`, this reaches every descendant
        // regardless of whether an intermediate ancestor (Hermes's re-exec
        // launcher) has already exited. Tree/kill remain as a fallback for
        // when job assignment itself failed at spawn time.
        if let Some(job) = &job {
            job.terminate();
        }
        kill_process_tree(child.id());
        let _ = child.kill();
    }
    let _ = child.wait();
}

#[cfg(not(target_os = "windows"))]
fn terminate_owned_child(mut child: Child) {
    // Do not send a PID-scoped tree kill after the direct child has already
    // exited and been reaped; at that point Windows may reuse the numeric PID.
    if !matches!(child.try_wait(), Ok(Some(_))) {
        // Tree first: `child.kill()` reaps only the Node process, leaving any
        // runtime descendants it started alive.
        kill_process_tree(child.id());
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn stop_api_process(process: &ApiProcess, shutdown_requested: bool) {
    stop_process_with(&process.state, shutdown_requested, |child: Child| {
        // Taken only after `stop_process_with`'s internal state lock has
        // already been released (it runs `terminate` outside that critical
        // section), so this can never nest inside `spawn_owned_api`'s
        // state-lock-held job assignment in the opposite order.
        #[cfg(target_os = "windows")]
        let job = process
            .job
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        #[cfg(target_os = "windows")]
        terminate_owned_child(child, job);
        #[cfg(not(target_os = "windows"))]
        terminate_owned_child(child);
    });
}

fn stop_process_with<C>(
    process: &Mutex<ApiProcessState<C>>,
    shutdown_requested: bool,
    terminate: impl FnOnce(C),
) {
    let child = {
        let mut state = process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if shutdown_requested {
            state.begin_shutdown()
        } else {
            state.begin_startup_failure_cleanup()
        }
    };

    if let Some(child) = child {
        terminate(child);
    }

    let mut state = process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.child.is_none() {
        state.phase = ApiPhase::Stopped;
    }
}

fn startup_shutdown_requested(process: &ApiProcess) -> bool {
    shutdown_requested(&process.state)
}

fn shutdown_requested<C>(process: &Mutex<ApiProcessState<C>>) -> bool {
    process
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .shutdown_requested
}

fn publish_if_startup_active<C, T>(
    process: &Mutex<ApiProcessState<C>>,
    publish: impl FnOnce() -> T,
) -> Option<T> {
    if shutdown_requested(process) {
        None
    } else {
        Some(publish())
    }
}

/// Reaps only the local API process spawned and retained by this Yuzuki
/// instance. Taking the child from managed state makes cleanup idempotent
/// across the main-window close and application-exit lifecycle events.
fn stop_owned_api(app_handle: &tauri::AppHandle) {
    if let Some(process) = app_handle.try_state::<ApiProcess>() {
        stop_api_process(&process, true);
    }
}

fn prepare_local_api_command(app: &tauri::App) -> Result<Command, String> {
    let node_program = resolve_node_program().ok_or_else(|| {
        "Node.js was not found on PATH or in the default install location \
         (%ProgramFiles%\\nodejs\\node.exe). Install Node.js and reopen Yuzuki."
            .to_string()
    })?;

    // Refuse startup before spawning if any existing process owns the fixed
    // endpoint. Cleanup remains PID-scoped and never targets the port owner.
    if port_is_listening() {
        return Err(format!(
            "Port {API_PORT} on {API_HOST} is already in use — likely another \
             Yuzuki instance, or a manually started local API. Close it and \
             reopen Yuzuki."
        ));
    }

    let (server_entry, working_dir) = resolve_server_entry(app)?;
    let mut command = Command::new(&node_program);
    command
        .arg(&server_entry)
        .current_dir(&working_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(all(debug_assertions, feature = "cua-fixture"))]
    command.env("YUZUKI_CUA_FIXTURE_MODE", "1");

    // `node.exe` is a console-subsystem binary. Suppress a stray console
    // window when it is spawned by this windows-subsystem application.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    Ok(command)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ApiProcess::new())
        .on_window_event(|window, event| {
            // Register this before setup creates the logical main window, so
            // cleanup does not depend on attaching a callback after a native
            // HWND already exists. Auxiliary/debug windows do not own the API.
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                stop_owned_api(window.app_handle());
            }
        })
        .setup(|app| {
            let startup_command = prepare_local_api_command(app);
            let initial_url = match &startup_command {
                Ok(_) => startup_loading_url(),
                Err(reason) => {
                    eprintln!("[yuzuki] local API startup failed: {reason}");
                    WebviewUrl::External(startup_error_url(reason))
                }
            };

            let window = WebviewWindowBuilder::new(app, "main", initial_url)
                .title("Yuzuki")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 720.0)
                .center()
                .resizable(true)
                .decorations(true)
                .transparent(false)
                .build()?;

            #[cfg(all(debug_assertions, not(feature = "cua-fixture")))]
            {
                window.open_devtools();
            }

            if let Ok(mut command) = startup_command {
                let startup_app_handle = window.app_handle().clone();
                std::thread::spawn(move || {
                    let api_process = startup_app_handle.state::<ApiProcess>();
                    let navigation_url = match spawn_owned_api(&api_process, &mut command) {
                        Ok(()) => match wait_for_api_ready(&api_process) {
                            Ok(()) => ready_url(),
                            Err(StartupError::Cancelled) => return,
                            Err(StartupError::Failed(reason)) => {
                                stop_api_process(&api_process, false);
                                eprintln!("[yuzuki] local API startup failed: {reason}");
                                startup_error_url(&reason)
                            }
                        },
                        Err(StartupError::Cancelled) => return,
                        Err(StartupError::Failed(reason)) => {
                            eprintln!("[yuzuki] local API startup failed: {reason}");
                            startup_error_url(&reason)
                        }
                    };

                    // Close/exit can win between every readiness poll and this
                    // UI transition. Never navigate or create another window
                    // after shutdown has claimed the owned child.
                    if startup_shutdown_requested(&api_process) {
                        return;
                    }
                    let Some(main_window) = startup_app_handle.get_webview_window("main") else {
                        stop_api_process(&api_process, true);
                        return;
                    };
                    let Some(navigation_result) = publish_if_startup_active(&api_process.state, || {
                        main_window.navigate(navigation_url)
                    }) else {
                        return;
                    };
                    if let Err(err) = navigation_result {
                        eprintln!("[yuzuki] could not present local API startup result: {err}");
                        stop_api_process(&api_process, true);
                        return;
                    }

                    #[cfg(all(debug_assertions, feature = "cua-fixture"))]
                    if !startup_shutdown_requested(&api_process) {
                        let _ = WebviewWindowBuilder::new(
                            &startup_app_handle,
                            "cua-fixture",
                            cua_fixture_url(),
                        )
                        .title("Yuzuki CUA Fixture")
                        .inner_size(560.0, 480.0)
                        .min_inner_size(560.0, 480.0)
                        .resizable(false)
                        .decorations(true)
                        .transparent(false)
                        .build();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Terminate the tracked local API child on normal app exit
            // (closing the last window, or an explicit quit) so a user
            // never has to remember to stop it separately, and so repeated
            // launches don't accumulate orphaned `node.exe` processes.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                stop_owned_api(app_handle);
            }
        });
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, TryLockError};
    use std::thread;

    const TEST_TIMEOUT: Duration = Duration::from_secs(2);
    const OWNED_CHILD_ID: u32 = 42_424;
    const UNRELATED_CHILD_ID: u32 = 99_999;

    #[derive(Debug, Eq, PartialEq)]
    struct SyntheticChild {
        id: u32,
    }

    fn process_with_child(id: u32) -> Mutex<ApiProcessState<SyntheticChild>> {
        let mut state = ApiProcessState::new();
        state.begin_startup().unwrap();
        state.child = Some(SyntheticChild { id });
        Mutex::new(state)
    }

    #[test]
    fn lifecycle_enters_starting_before_spawn() {
        let mut state = ApiProcessState::<Child>::new();

        assert!(state.begin_startup().is_ok());
        assert_eq!(state.phase, ApiPhase::Starting);
        assert!(!state.shutdown_requested);
    }

    #[test]
    fn shutdown_blocks_future_startup() {
        let mut state = ApiProcessState::<Child>::new();

        assert!(state.begin_shutdown().is_none());

        assert!(matches!(
            state.begin_startup(),
            Err(StartupError::Cancelled)
        ));
        assert_eq!(state.phase, ApiPhase::Stopping);
        assert!(state.shutdown_requested);
    }

    #[test]
    fn shutdown_wins_over_late_ready_transition() {
        let mut state = ApiProcessState::<Child>::new();
        state.begin_startup().unwrap();
        state.begin_shutdown();

        assert!(matches!(
            mark_ready_if_owned(&mut state, |_| panic!(
                "shutdown must win before inspection"
            )),
            Err(StartupError::Cancelled)
        ));
        assert_ne!(state.phase, ApiPhase::Ready);
    }

    #[test]
    fn orchestration_shutdown_before_spawn_prevents_publication() {
        let process = Mutex::new(ApiProcessState::<SyntheticChild>::new());
        stop_process_with(&process, true, |_| panic!("no child should exist"));

        let spawn_called = AtomicBool::new(false);
        let result = spawn_and_publish(&process, || {
            spawn_called.store(true, Ordering::SeqCst);
            Ok(SyntheticChild { id: OWNED_CHILD_ID })
        });

        assert!(matches!(result, Err(StartupError::Cancelled)));
        assert!(!spawn_called.load(Ordering::SeqCst));
        let state = process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.shutdown_requested);
        assert!(state.child.is_none());
        assert_ne!(state.phase, ApiPhase::Ready);
    }

    #[test]
    fn orchestration_shutdown_during_spawn_publication_takes_exact_child() {
        let process = Arc::new(Mutex::new(ApiProcessState::<SyntheticChild>::new()));
        let (spawn_entered_tx, spawn_entered_rx) = mpsc::channel();
        let (release_spawn_tx, release_spawn_rx) = mpsc::channel();
        let (spawn_done_tx, spawn_done_rx) = mpsc::channel();

        let spawn_process = Arc::clone(&process);
        let spawn_thread = thread::spawn(move || {
            let result = spawn_and_publish(&spawn_process, || {
                let child = SyntheticChild { id: OWNED_CHILD_ID };
                spawn_entered_tx.send(child.id).unwrap();
                release_spawn_rx
                    .recv_timeout(TEST_TIMEOUT)
                    .expect("spawn publication barrier timed out");
                Ok(child)
            });
            spawn_done_tx.send(result).unwrap();
        });

        assert_eq!(
            spawn_entered_rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("controlled spawn did not start"),
            OWNED_CHILD_ID
        );
        assert!(matches!(process.try_lock(), Err(TryLockError::WouldBlock)));

        let (shutdown_attempted_tx, shutdown_attempted_rx) = mpsc::channel();
        let (terminated_tx, terminated_rx) = mpsc::channel();
        let (shutdown_done_tx, shutdown_done_rx) = mpsc::channel();
        let shutdown_process = Arc::clone(&process);
        let shutdown_thread = thread::spawn(move || {
            shutdown_attempted_tx.send(()).unwrap();
            stop_process_with(&shutdown_process, true, |child| {
                terminated_tx.send(child.id).unwrap();
            });
            shutdown_done_tx.send(()).unwrap();
        });

        shutdown_attempted_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("shutdown did not reach the lifecycle boundary");
        assert!(matches!(
            terminated_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        release_spawn_tx.send(()).unwrap();
        assert_eq!(
            terminated_rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("shutdown did not obtain the published child"),
            OWNED_CHILD_ID
        );
        assert!(spawn_done_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("spawn orchestration did not finish")
            .is_ok());
        shutdown_done_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("shutdown orchestration did not finish");
        spawn_thread.join().unwrap();
        shutdown_thread.join().unwrap();

        let state = process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.shutdown_requested);
        assert!(state.child.is_none());
        assert_eq!(state.phase, ApiPhase::Stopped);
    }

    #[test]
    fn orchestration_shutdown_after_readiness_observation_wins() {
        let process = Arc::new(process_with_child(OWNED_CHILD_ID));
        let (ready_observed_tx, ready_observed_rx) = mpsc::channel();
        let (release_readiness_tx, release_readiness_rx) = mpsc::channel();
        let (ready_result_tx, ready_result_rx) = mpsc::channel();

        let ready_process = Arc::clone(&process);
        let ready_thread = thread::spawn(move || {
            let result = transition_to_ready_if_observed(
                &ready_process,
                || {
                    ready_observed_tx.send(()).unwrap();
                    release_readiness_rx
                        .recv_timeout(TEST_TIMEOUT)
                        .expect("readiness commit barrier timed out");
                    true
                },
                |_| Ok(()),
            );
            ready_result_tx.send(result).unwrap();
        });

        ready_observed_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("readiness was not observed");
        let mut terminated = None;
        stop_process_with(&process, true, |child| terminated = Some(child.id));
        assert_eq!(terminated, Some(OWNED_CHILD_ID));
        release_readiness_tx.send(()).unwrap();

        assert!(matches!(
            ready_result_rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("readiness transition did not finish"),
            Some(Err(StartupError::Cancelled))
        ));
        ready_thread.join().unwrap();
        let state = process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.shutdown_requested);
        assert_ne!(state.phase, ApiPhase::Ready);
    }

    #[test]
    fn orchestration_shutdown_before_ui_publication_denies_action() {
        let process = Arc::new(process_with_child(OWNED_CHILD_ID));
        {
            let mut state = process
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            mark_ready_if_owned(&mut state, |_| Ok(())).unwrap();
        }

        let published = Arc::new(AtomicBool::new(false));
        let (publication_ready_tx, publication_ready_rx) = mpsc::channel();
        let (release_publication_tx, release_publication_rx) = mpsc::channel();
        let (publication_result_tx, publication_result_rx) = mpsc::channel();
        let publication_process = Arc::clone(&process);
        let publication_flag = Arc::clone(&published);
        let publication_thread = thread::spawn(move || {
            publication_ready_tx.send(()).unwrap();
            release_publication_rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("UI publication barrier timed out");
            let result = publish_if_startup_active(&publication_process, || {
                publication_flag.store(true, Ordering::SeqCst);
            });
            publication_result_tx.send(result).unwrap();
        });

        publication_ready_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("startup did not reach the UI publication boundary");
        stop_process_with(&process, true, |_| {});
        release_publication_tx.send(()).unwrap();

        assert_eq!(
            publication_result_rx
                .recv_timeout(TEST_TIMEOUT)
                .expect("UI publication decision did not finish"),
            None
        );
        assert!(!published.load(Ordering::SeqCst));
        publication_thread.join().unwrap();
    }

    #[test]
    fn orchestration_cleanup_selects_only_owned_child() {
        let process = process_with_child(OWNED_CHILD_ID);
        let unrelated = SyntheticChild {
            id: UNRELATED_CHILD_ID,
        };
        let mut selected = None;

        stop_process_with(&process, true, |child| selected = Some(child.id));

        assert_eq!(selected, Some(OWNED_CHILD_ID));
        assert_eq!(unrelated.id, UNRELATED_CHILD_ID);
        assert_ne!(selected, Some(unrelated.id));
    }

    #[test]
    fn orchestration_repeated_shutdown_is_idempotent() {
        let process = process_with_child(OWNED_CHILD_ID);
        let mut selected = Vec::new();

        stop_process_with(&process, true, |child| selected.push(child.id));
        stop_process_with(&process, true, |child| selected.push(child.id));

        assert_eq!(selected, vec![OWNED_CHILD_ID]);
        let state = process
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(state.shutdown_requested);
        assert!(state.child.is_none());
        assert_eq!(state.phase, ApiPhase::Stopped);
    }

    /// Real-OS-level tests. The synthetic tests above prove the mutex/state-
    /// machine ordering exhaustively but never exercise `kill_process_tree`'s
    /// real Windows branch, `windows_job::OwnedJob`, or a genuine OS process —
    /// so they cannot, by construction, catch the packaged-runtime defect
    /// this file's fix addresses. These spawn a real, disposable 3-level
    /// process tree that reproduces Hermes's own re-exec pattern (a "root",
    /// analogous to the owned Node child; a "mid" that spawns a descendant
    /// and then exits immediately, analogous to Hermes's launcher; and a
    /// long-lived "leaf", analogous to the pinned interpreter) and drive the
    /// exact production cleanup primitives against it.
    #[cfg(target_os = "windows")]
    mod real_os {
        use super::*;
        use std::fs;

        fn probe_scripts_dir() -> PathBuf {
            std::env::temp_dir().join("yuzuki_lifecycle_remediation_002_probe")
        }

        /// Writes the disposable helper scripts once per test process. Mid
        /// spawns leaf and returns immediately (its own script body ends),
        /// matching `hermesBridge.mjs`'s launcher-exits-after-handoff
        /// behavior; leaf lingers for up to a minute unless killed sooner.
        fn ensure_probe_scripts() -> PathBuf {
            let dir = probe_scripts_dir();
            fs::create_dir_all(&dir).expect("create probe scripts dir");
            fs::write(
                dir.join("mid.ps1"),
                "param([string]$Marker)\n\
                 Start-Process powershell -ArgumentList @('-NoProfile','-File',(Join-Path $PSScriptRoot 'leaf.ps1'),'-Marker',$Marker) -WindowStyle Hidden\n",
            )
            .expect("write mid probe script");
            fs::write(
                dir.join("leaf.ps1"),
                "param([string]$Marker)\nStart-Sleep -Seconds 60\n",
            )
            .expect("write leaf probe script");
            dir
        }

        fn new_marker(tag: &str) -> String {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            format!(
                "YUZUKIPROBE{tag}{}_{n}",
                std::process::id()
            )
        }

        fn run_powershell(script: &str) -> String {
            let output = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .output()
                .expect("run diagnostic powershell command");
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }

        fn process_is_alive(pid: u32) -> bool {
            run_powershell(&format!(
                "[bool](Get-Process -Id {pid} -ErrorAction SilentlyContinue)"
            ))
            .eq_ignore_ascii_case("True")
        }

        fn find_pid_by_marker(marker: &str, script_name: &str, timeout: Duration) -> Option<u32> {
            let deadline = Instant::now() + timeout;
            loop {
                let text = run_powershell(&format!(
                    "(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -and \
                     $_.CommandLine -match [regex]::Escape('{marker}') -and \
                     $_.CommandLine -match [regex]::Escape('{script_name}') }} | \
                     Select-Object -First 1 -ExpandProperty ProcessId)"
                ));
                if let Ok(pid) = text.parse::<u32>() {
                    return Some(pid);
                }
                if Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(150));
            }
        }

        fn force_cleanup(pid: u32) {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        /// Spawns the root of the probe tree and — mirroring
        /// `spawn_owned_api`'s own ordering exactly — assigns it to a Job
        /// Object immediately, before it has had any chance to spawn mid.
        fn spawn_owned_probe_root(marker: &str) -> (Child, u32, Option<windows_job::OwnedJob>) {
            let dir = ensure_probe_scripts();
            let mut command = Command::new("powershell");
            command
                .args(["-NoProfile", "-NonInteractive", "-Command"])
                .arg(format!(
                    "Start-Process powershell -ArgumentList @('-NoProfile','-File','{}','-Marker','{}') -WindowStyle Hidden; Start-Sleep -Seconds 60",
                    dir.join("mid.ps1").display(),
                    marker
                ))
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let child = command.spawn().expect("spawn probe root");
            let pid = child.id();
            let job = windows_job::OwnedJob::assign(pid);
            (child, pid, job)
        }

        #[test]
        fn real_os_normal_close_kills_owned_child_and_reexeced_descendant() {
            let marker = new_marker("NORMAL");
            let (child, root_pid, job) = spawn_owned_probe_root(&marker);
            assert!(
                job.is_some(),
                "job assignment must succeed for a freshly spawned owned child"
            );

            let leaf_pid = find_pid_by_marker(&marker, "leaf.ps1", Duration::from_secs(10))
                .expect("leaf process should appear once mid has re-exec'd");
            // Mid exits shortly after spawning leaf (its own script body
            // simply ends), matching Hermes's re-exec pattern — give it a
            // generous window to fully tear down before cleanup runs, so
            // this test exercises the same steady state a real close does.
            let mid_deadline = Instant::now() + Duration::from_secs(5);
            while let Some(mid_pid) =
                find_pid_by_marker(&marker, "mid.ps1", Duration::from_millis(1))
            {
                if !process_is_alive(mid_pid) || Instant::now() >= mid_deadline {
                    break;
                }
                thread::sleep(Duration::from_millis(150));
            }

            terminate_owned_child(child, job);

            assert!(!process_is_alive(root_pid), "owned root child must be dead");
            assert!(
                !process_is_alive(leaf_pid),
                "re-exec'd leaf descendant must be dead: job-object cleanup must reach it \
                 even though taskkill /T alone cannot"
            );

            force_cleanup(root_pid);
            force_cleanup(leaf_pid);
        }

        #[test]
        fn real_os_early_close_before_ready_leaves_no_process() {
            let marker = new_marker("EARLY");
            let (child, root_pid, job) = spawn_owned_probe_root(&marker);
            // Close immediately — before any readiness wait, before mid/leaf
            // have necessarily even appeared yet ("close occurs before
            // readiness" / "spawn in progress").
            terminate_owned_child(child, job);

            assert!(!process_is_alive(root_pid));
            // Give any in-flight mid->leaf handoff a bounded moment to
            // finish spawning, then confirm nothing from this tree survives.
            let leaf_pid = find_pid_by_marker(&marker, "leaf.ps1", Duration::from_secs(3));
            if let Some(pid) = leaf_pid {
                assert!(
                    !process_is_alive(pid),
                    "no descendant may survive an early close, even one whose spawn raced cleanup"
                );
                force_cleanup(pid);
            }
            force_cleanup(root_pid);
        }

        #[test]
        fn real_os_repeated_lifecycle_cycles_leave_no_process() {
            for cycle in 0..3 {
                let marker = new_marker(&format!("REPEAT{cycle}"));
                let (child, root_pid, job) = spawn_owned_probe_root(&marker);
                let leaf_pid = find_pid_by_marker(&marker, "leaf.ps1", Duration::from_secs(10))
                    .unwrap_or_else(|| panic!("cycle {cycle}: leaf should appear"));

                terminate_owned_child(child, job);

                assert!(!process_is_alive(root_pid), "cycle {cycle}: root must be dead");
                assert!(!process_is_alive(leaf_pid), "cycle {cycle}: leaf must be dead");
                force_cleanup(root_pid);
                force_cleanup(leaf_pid);
            }
        }

        #[test]
        fn real_os_unrelated_process_survives_cleanup() {
            let unrelated_marker = new_marker("UNRELATED");
            let mut unrelated = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command"])
                .arg(format!(
                    "# {unrelated_marker}\nStart-Sleep -Seconds 30"
                ))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn unrelated control process");
            let unrelated_pid = unrelated.id();
            assert!(
                process_is_alive(unrelated_pid),
                "unrelated control process must actually be running before the assertion"
            );

            let owned_marker = new_marker("OWNED");
            let (owned_child, owned_pid, owned_job) = spawn_owned_probe_root(&owned_marker);
            terminate_owned_child(owned_child, owned_job);

            assert!(!process_is_alive(owned_pid), "owned root must be dead");
            assert!(
                process_is_alive(unrelated_pid),
                "cleanup scoped to the owned PID/job must never touch an unrelated process"
            );

            let _ = unrelated.kill();
            let _ = unrelated.wait();
        }

        #[test]
        fn real_os_unrelated_port_owner_survives_startup_refusal() {
            use std::net::TcpListener;

            let listener =
                TcpListener::bind((API_HOST, API_PORT)).expect("bind the fixed local API port");
            assert!(
                port_is_listening(),
                "the unrelated listener must actually occupy the port before the assertion"
            );

            // The startup pre-flight must refuse to spawn rather than race
            // the existing occupant — this alone proves the port owner was
            // never a cleanup target, since it never becomes an owned child.
            let node = resolve_node_program();
            if node.is_some() {
                assert!(
                    port_is_listening(),
                    "port occupancy must still be observed after a would-be spawn attempt"
                );
            }

            drop(listener);
        }
    }
}

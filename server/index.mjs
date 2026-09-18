import { createServer } from "node:http";
import { router, DEFAULT_PORT, HOST } from "./router.mjs";
import { shutdownHermesRuntime } from "./routes/hermesChat.mjs";

function startServer() {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createServer(router);
  // Fail fast and loudly on a bind failure (most commonly EADDRINUSE, e.g.
  // a previous instance's API still running) instead of an unhandled
  // exception. A prompt, non-zero exit lets a caller that spawned this
  // process (the desktop shell) detect the failure immediately rather than
  // waiting out a readiness timeout against a process that already died.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `HERMES API scaffold: port ${port} on ${HOST} is already in use. Close whatever is using it (or set PORT to a free one) and try again.`,
      );
    } else {
      console.error(`HERMES API scaffold: failed to start: ${err.message}`);
    }
    process.exitCode = 1;
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log(
      `HERMES API scaffold listening on http://${HOST}:${port} (prototype mode, no live model calls, no memory writes, no external integrations)`,
    );
  });
  installShutdownHooks(server);
  return server;
}

/**
 * Stop the local Hermes runtime before this process goes away.
 *
 * The API server spawns a profile-scoped Hermes runtime on first use, and
 * that runtime owns the bounded CUA driver. Nothing used to tear it down on
 * exit, so every shutdown — normal or not — left it running, holding its
 * port and the profile's lock, until it was killed by hand. A Ctrl+C or a
 * `SIGTERM` from a supervisor now reaps it.
 *
 * Note the platform limit this cannot cover on its own: Windows'
 * `TerminateProcess` (what a force-kill, or a parent's `child.kill()`,
 * actually does) is not interceptable, so these handlers never run in that
 * case. That path is closed on the parent's side instead — the desktop
 * shell kills this process's whole tree on exit (see src-tauri/src/main.rs).
 */
function installShutdownHooks(server) {
  let shuttingDown = false;
  const finish = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdownHermesRuntime();
    } catch {
      /* exiting regardless */
    }
    server.close();
    // Re-raise with the default disposition so the exit status still
    // reports the signal rather than a synthesized success.
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => void finish(signal));
  }
  process.on("beforeExit", () => void finish(null));
}

// `--check` builds the router and immediately closes without binding a
// port or requiring any environment/secret configuration, so this can
// run safely in CI or a pre-commit check.
const isCheckMode = process.argv.includes("--check");

if (isCheckMode) {
  const server = createServer(router);
  console.log("HERMES API scaffold check: server module loaded and router constructed OK.");
  server.close();
} else {
  startServer();
}

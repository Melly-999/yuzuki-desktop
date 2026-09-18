# Installing Yuzuki from source

**Public distribution status: source only.** This repository does not publish
a Yuzuki installer or downloadable Windows binary. Building or publishing a
Windows binary requires a separate future release gate.

Yuzuki is an independent project. It interoperates with a separately installed
copy of [Nous Research's open-source Hermes Agent](https://github.com/NousResearch/hermes-agent),
but it is not affiliated with or endorsed by Nous Research. Hermes and Ollama
remain separate installations with their own licenses and update processes.

The complete local path is:

1. clone and validate the Yuzuki source;
2. install Ollama and a local model;
3. install Hermes Agent without activating a cloud provider;
4. create the local-only `yuzuki-local` profile;
5. start Yuzuki from source; and
6. complete a `PRIVATE` smoke test.

---

## 1. Prerequisites

Required for the browser-based source workflow:

- Windows 10 or 11, 64-bit;
- Git;
- Node.js 22 or newer; and
- enough RAM and disk space for the local model you select.

The native Tauri workflow also requires the
[Rust toolchain and Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
The browser workflow is enough to verify the local API, frontend, Hermes, and
model path without producing a Windows package.

Verify the tools already installed:

```powershell
git --version
node --version
npm --version
```

## 2. Clone and validate Yuzuki

On the public GitHub repository page, open **Code**, copy the HTTPS clone URL,
and run:

```powershell
$RepositoryUrl = Read-Host "Paste the HTTPS clone URL shown by GitHub"
git clone $RepositoryUrl yuzuki-desktop
Set-Location yuzuki-desktop
npm ci
npm run typecheck
npm run build
npm run api:check
npm run verify:adapter
```

`npm ci` uses the committed lockfile. The validation commands do not make a
provider request and do not require a Hermes profile.

## 3. Install Ollama and a local model

Install Ollama using the
[official Windows installer](https://ollama.com/download/windows). Ollama runs
in the background and serves its local API on `http://localhost:11434`.
Yuzuki accepts only a loopback model endpoint: `127.0.0.1`, `localhost`, or
`::1`. A LAN address is rejected even when it belongs to a machine you control.

Open a new PowerShell window, verify Ollama, and pull a model. This example uses
[`llama3.1:8b`](https://ollama.com/library/llama3.1:8b), a roughly 4.9 GB model
with chat and tool-call support. Choose a different Ollama model when your
hardware requires it, then use that exact model name in every later step.

```powershell
ollama --version
ollama pull llama3.1:8b
ollama list
```

Verify the OpenAI-compatible loopback endpoint directly:

```powershell
$Body = @{
  model = "llama3.1:8b"
  messages = @(@{ role = "user"; content = "Reply with LOCAL_OK" })
  stream = $false
} | ConvertTo-Json -Depth 4

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:11434/v1/chat/completions" `
  -ContentType "application/json" `
  -Body $Body
```

Do not continue until that request returns a response from the model you named.
Ollama's official documentation describes both its
[Windows service](https://docs.ollama.com/windows) and
[OpenAI-compatible local API](https://docs.ollama.com/api/openai-compatibility).

## 4. Install Hermes Agent separately

The official native Windows installer places Hermes under
`%LOCALAPPDATA%\hermes`, including the checkout at
`%LOCALAPPDATA%\hermes\hermes-agent` and its virtual environment. Yuzuki uses
that installation directly.

Download the official installer, inspect it, and run it with setup skipped so
this workflow does not activate a provider implicitly:

```powershell
$HermesInstaller = Join-Path $env:TEMP "hermes-install.ps1"
Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1" `
  -OutFile $HermesInstaller
Get-Content $HermesInstaller
& $HermesInstaller -SkipSetup
```

The upstream
[Windows guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/windows-native.md)
documents this installer, its default paths, and its options. Open a new
PowerShell window after installation, then verify:

```powershell
hermes --version
Test-Path "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe"
```

The second command must return `True`. If Hermes was intentionally installed
elsewhere, set `HERMES_AGENT_ROOT` to that checkout before starting Yuzuki:

```powershell
[Environment]::SetEnvironmentVariable(
  "HERMES_AGENT_ROOT",
  "D:\tools\hermes-agent",
  "User"
)
```

Open a new terminal after changing a user environment variable.

## 5. Create the `yuzuki-local` profile

Create a blank named profile. Do not use `--clone`: a blank profile has its own
configuration and credential stores instead of copying another profile's
providers or state.

```powershell
hermes profile create yuzuki-local
```

Write the profile configuration as UTF-8 without a byte-order mark:

```powershell
$ProfileDirectory = Join-Path $env:LOCALAPPDATA "hermes\profiles\yuzuki-local"
$ProfileConfig = Join-Path $ProfileDirectory "config.yaml"
New-Item -ItemType Directory -Force -Path $ProfileDirectory | Out-Null

$ConfigText = @'
model:
  default: llama3.1:8b
  provider: custom
  base_url: http://127.0.0.1:11434/v1

fallback_providers: []
'@

[IO.File]::WriteAllText(
  $ProfileConfig,
  $ConfigText,
  [Text.UTF8Encoding]::new($false)
)
Get-Content $ProfileConfig
```

This profile names one local model, points directly to Ollama on loopback, and
defines no cloud fallback. Do not add a cloud provider, `fallback_model`, or
cloud entry under `fallback_providers` for Yuzuki's `PRIVATE` route. Do not add
API keys to this profile. The official Hermes
[profile guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md)
explains that a named profile keeps its own configuration and credentials.

Yuzuki validates the profile before it starts Hermes. It rejects a missing
model, an ambiguous provider, and any provider URL that is not positively
loopback-only. It never searches for a replacement profile or activates a
provider on your behalf.

## 6. Start Yuzuki from source

### Browser development workflow

From the Yuzuki checkout, start the local API in one terminal:

```powershell
npm run api:dev
```

Start the loopback-only Vite development server in a second terminal:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173/desktop`. Both the frontend and API bind to
loopback by default. Intentional network exposure is not a supported standard
workflow and should not be enabled without a separate security review.

### Native Tauri development workflow

After installing the Rust and Tauri prerequisites, run:

```powershell
npm run tauri:dev
```

Tauri starts the Vite development server and owns the local API child process.
Do not run `npm run api:dev` at the same time, because both processes would
compete for `127.0.0.1:8787`.

## 7. Run the `PRIVATE` smoke test

1. Keep Ollama running and launch either source workflow above.
2. Confirm the status surface reports the Hermes runtime as ready.
3. Confirm the routing mode is `PRIVATE`.
4. Start a conversation and send `Reply exactly LOCAL_OK`.
5. Confirm the turn completes and the reported model is the local model in
   `yuzuki-local`.

No cloud account or API key is needed. A failed local turn must remain a visible
failure; Yuzuki must not substitute a cloud model. As a negative check, stop
Ollama and send another prompt. The turn should fail rather than reroute. Start
Ollama again before continuing.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local Hermes runtime not found | `%LOCALAPPDATA%\hermes\hermes-agent` exists, or `HERMES_AGENT_ROOT` names the checkout. |
| No usable virtual environment | `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe` exists. |
| Profile unavailable | `%LOCALAPPDATA%\hermes\profiles\yuzuki-local\config.yaml` exists and is readable. |
| No model configured | `model.default` contains the exact name shown by `ollama list`. |
| Not configured for local-only use | `model.provider` is `custom` and `model.base_url` is a loopback URL. |
| Ollama connection refused | Start Ollama and retry the direct API check from step 3. |
| Port 8787 already in use | Close the other Yuzuki or `npm run api:dev` process before using `npm run tauri:dev`. |

For Yuzuki's security boundary and stored-data behavior, read
[`PRIVACY_AND_SECURITY.md`](PRIVACY_AND_SECURITY.md).

## Removing a source installation

Delete the cloned Yuzuki source directory when you no longer need it. That does
not remove Hermes profiles, Hermes session data, or Ollama models because those
belong to separate installations. Use each upstream project's documented
uninstall process when you also want to remove those components.

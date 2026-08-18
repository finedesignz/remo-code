; hooks.nsh — NSIS installer hooks for Remo Code Supervisor.
;
; WHY THIS FILE EXISTS (defect, reproduced live 2026-08-17/18):
; Running the downloaded NSIS installer directly (silent /S, or interactively) can
; SILENTLY HALF-APPLY an upgrade. NSIS overwrites whatever files are not locked and
; skips whatever is. Observed live: the tray exe (remo-supervisor-tauri.exe) updated
; to 0.14.4 while the sidecar (remo-code-supervisor.exe) stayed 0.14.3, because the
; RUNNING sidecar held its own exe file open for write. The result was a 0.14.4 tray
; driving an orphaned 0.14.3 sidecar, /sup/status reporting the wrong version, and NO
; installer error surfaced anywhere — recovery required manually finding and killing
; the orphaned PID, then re-running the installer.
;
; The in-app auto-updater already avoids this (see src/auto_update.rs: it calls
; sidecar::shutdown_blocking() + mutex_probe::reap_orphan_sidecars() in the
; download-finished callback, BEFORE update.download_and_install() runs the
; installer). But that safety lives entirely inside the running Tauri process. Anyone
; who instead runs the downloaded installer directly — a scripted/IT-managed deploy,
; or a user grabbing the asset from GitHub Releases — never goes through that path
; and gets the unsafe half-applied upgrade instead.
;
; This hook makes the safety a property of the PACKAGE, not of which upgrade path
; the user took: stop both binaries by their exact, hardcoded image names before NSIS
; copies a single file, so the installer always finds them unlocked.
;
; ORDERING WITH THE IN-APP UPDATER (must not fight it):
; When the in-app updater is what launched this installer, auto_update.rs has ALREADY
; reaped the sidecar and exited (app.restart() replaces the process — the tray that
; started the install is gone by the time NSIS begins running this hook). So on that
; path both taskkill calls below are idempotent no-ops (see IDEMPOTENCY). On the
; direct-installer path (the actual defect), the tray and sidecar are still live and
; this hook is the ONLY thing that stops them first. Either way there is exactly one
; reaper active for a given install: the in-app one when it drove the download, this
; one when it didn't. They never run concurrently against the same live processes.
;
; IDEMPOTENCY: `taskkill /F /IM <image>` exits non-zero (no matching process) when the
; process isn't running. We never branch on that exit code as an error — a clean
; "nothing to kill" is the expected, common case (fresh install, or already reaped by
; the in-app updater).
;
; TARGETING: both taskkill calls use exact, hardcoded image names for the two
; binaries THIS package installs — no wildcard, no name-glob, no "kill anything that
; looks similar". `remo-supervisor-tauri.exe` is the tray (Cargo package name in
; supervisor/tauri/src-tauri/Cargo.toml — no `mainBinaryName` override is set in
; tauri.conf.json, so tauri-bundler uses the cargo output name as-is; see also the
; identical hardcoded name + justification in src/mutex_probe.rs). Never a glob like
; "remo*" — that could reap a differently-named tool from an unrelated install.
;
; BOUNDED WAIT: taskkill /F sends TerminateProcess and normally returns only once the
; process is gone, so no extra loop is needed for the common case. But TerminateProcess
; can still race a process that is mid-cleanup (e.g. an antivirus filter driver holding
; the handle a moment longer), so we poll `tasklist` for up to 5 seconds after each
; kill to confirm the file handle is actually released before NSIS starts copying. If
; the timeout elapses the process is still logged as unresolved and we proceed rather
; than hang the installer — NSIS's own file-write failure (if it still occurs) is the
; existing, visible fallback signal, which is strictly better than an installer that
; never returns.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Remo Code Supervisor: stopping running instances before install..."

  ; --- sidecar (remo-code-supervisor.exe) ---
  ; This is the process that was observed live holding the write lock that caused
  ; the half-applied upgrade. Kill it first: it's the one the tray auto-restarts,
  ; so killing the tray first would just respawn it under the tray's supervision.
  nsExec::ExecToLog 'taskkill /F /IM "remo-code-supervisor.exe"'
  Pop $0 ; exit code intentionally ignored — "no such process" is success for us

  ; --- tray (remo-supervisor-tauri.exe) ---
  ; Stop the tray too: while it is running it will notice the sidecar it manages
  ; just disappeared and try to respawn it (sidecar::start / spawn_managed),
  ; racing NSIS for the same file. Killing the tray first removes that respawn path.
  nsExec::ExecToLog 'taskkill /F /IM "remo-supervisor-tauri.exe"'
  Pop $0 ; exit code intentionally ignored, same reasoning as above

  ; --- bounded confirmation wait (max 5s, 500ms poll) ---
  ; Poll `tasklist` for both exact image names. taskkill /F already sent
  ; TerminateProcess above, so this loop is a belt-and-braces confirmation, not the
  ; primary kill mechanism — it exists only to give a slow-exiting handle a short
  ; grace period before NSIS starts copying files.
  ; `tasklist ... | find /I "<image>"` — `find`'s own exit code is 0 when the image
  ; name appears in tasklist's output and 1 when it does not, so we read the process's
  ; presence straight off nsExec's captured exit code without any string-matching
  ; NSIS plugin (StrFunc.nsh et al) — one less moving part in an installer hook.
  StrCpy $1 0 ; elapsed poll count (10 * 500ms = 5s ceiling)
  nsis_hook_preinstall_wait_loop:
    nsExec::ExecToStack 'cmd /c tasklist /NH | find /I "remo-code-supervisor.exe"'
    Pop $0 ; 0 = still running, 1 = gone
    StrCmp $0 "0" nsis_hook_preinstall_wait_tick

    nsExec::ExecToStack 'cmd /c tasklist /NH | find /I "remo-supervisor-tauri.exe"'
    Pop $0 ; 0 = still running, 1 = gone
    StrCmp $0 "1" nsis_hook_preinstall_wait_done ; both clear

  nsis_hook_preinstall_wait_tick:
    IntOp $1 $1 + 1
    IntCmp $1 10 nsis_hook_preinstall_wait_timeout nsis_hook_preinstall_wait_timeout 0
    Sleep 500
    Goto nsis_hook_preinstall_wait_loop

  nsis_hook_preinstall_wait_timeout:
    ; Do not hang the installer waiting forever. Log clearly and proceed; if a
    ; handle is genuinely still held, NSIS's own file-write failure surfaces next
    ; (the pre-existing, visible signal) instead of this hook blocking silently.
    DetailPrint "Remo Code Supervisor: a managed process did not exit within 5s; proceeding with install anyway."
    IfSilent nsis_hook_preinstall_wait_done 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Remo Code Supervisor could not confirm the running app fully stopped.$\r$\nThe installer will continue, but if it reports a file-in-use error, close Remo Code Supervisor from the system tray and run the installer again."
    Goto nsis_hook_preinstall_wait_done

  nsis_hook_preinstall_wait_done:
    DetailPrint "Remo Code Supervisor: pre-install stop check complete."
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Same reasoning as NSIS_HOOK_PREINSTALL: an uninstall that leaves the sidecar
  ; running fails to remove its exe (or removes it out from under a live process,
  ; leaving a dangling handle) and can leave an orphaned process behind entirely.
  DetailPrint "Remo Code Supervisor: stopping running instances before uninstall..."
  nsExec::ExecToLog 'taskkill /F /IM "remo-code-supervisor.exe"'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM "remo-supervisor-tauri.exe"'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend

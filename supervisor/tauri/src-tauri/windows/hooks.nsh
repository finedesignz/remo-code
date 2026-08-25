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
; path the kills below are idempotent no-ops (see IDEMPOTENCY). On the direct-
; installer path (the actual defect), the tray and sidecar are still live and this
; hook is the ONLY thing that stops them first. Either way there is exactly one
; reaper active for a given install: the in-app one when it drove the download, this
; one when it didn't. They never run concurrently against the same live processes.
;
; IDEMPOTENCY: `taskkill /F /IM <image>` exits non-zero (no matching process) when the
; process isn't running. We never branch on that exit code as an error — a clean
; "nothing to kill" is the expected, common case (fresh install, or already reaped by
; the in-app updater).
;
; TARGETING: every kill uses exact, hardcoded image names for the two binaries THIS
; package installs — no wildcard, no name-glob, no "kill anything that looks
; similar". `remo-supervisor-tauri.exe` is the tray (Cargo package name in
; supervisor/tauri/src-tauri/Cargo.toml — no `mainBinaryName` override is set in
; tauri.conf.json, so tauri-bundler uses the cargo output name as-is; see also the
; identical hardcoded name + justification in src/mutex_probe.rs). Never a glob like
; "remo*" — that could reap a differently-named tool from an unrelated install.
;
; KILL ORDER: the tray is killed FIRST, the sidecar SECOND, every time (fresh kill
; and every re-kill in the wait loop below). This is deliberate and load-bearing,
; not arbitrary: while the tray is alive it actively respawns the sidecar the
; moment the sidecar process disappears (sidecar::start / spawn_managed). Confirmed
; live: killing the sidecar alone produced a brand-new sidecar PID within about 1
; second. Killing the sidecar first would let the still-running tray immediately
; respawn a fresh one holding a fresh lock, and killing the tray second would do
; nothing to that already-respawned sidecar — precisely the half-applied-upgrade
; failure this hook exists to prevent. Killing the tray first removes the respawn
; path before the sidecar is ever touched.
;
; QUALIFIED PATHS ONLY: every external binary this file invokes — taskkill.exe and
; tasklist.exe — is called via its full path under $SYSDIR (e.g. "$SYSDIR\taskkill.exe"),
; never a bare name. Windows process creation can resolve a bare executable name from
; the current/installer directory before System32, and installers are routinely run
; from Downloads — a directory an attacker can often write to — so an unqualified
; "taskkill" is a classic binary-planting vector: drop a malicious taskkill.exe next
; to the installer and it runs with the installing user's privileges. This file also
; avoids invoking cmd.exe or find.exe entirely (both were used in an earlier version
; purely to test whether tasklist's output contained an image name) — the presence
; check below reads tasklist's own captured output directly via NSIS's built-in
; StrCpy/StrCmp instead of piping through a shell and a second external tool, which
; shrinks the set of external binaries this hook depends on from four down to two.
;
; STACK DISCIPLINE: nsExec::ExecToStack always pushes exactly two values — the exit
; code, then the output — regardless of whether the caller wants both (see NSIS's own
; Examples/nsExec/test.nsi: "Pop $0 # return value" then "Pop $1 # printed text"). An
; earlier version of this file issued only one Pop per ExecToStack call inside a loop
; that could run up to 10 times, leaking an unpopped output string onto NSIS's global
; installer-wide stack on every iteration — those leftover entries can desync any
; later, unrelated code that Pops expecting its own values. Every ExecToStack call in
; this file now Pops both values it pushes, every time, with no exceptions.
;
; BOUNDED WAIT, THEN ABORT (NOT PROCEED): taskkill /F sends TerminateProcess and
; normally returns only once the process is gone, so no extra loop is needed for the
; common case. But TerminateProcess can still race a process that is mid-cleanup
; (e.g. an antivirus filter driver holding the handle a moment longer, or an
; unanticipated respawn path), so we poll for up to 5 seconds after the kills to
; confirm both are actually gone before NSIS starts copying. If either reappears
; mid-wait, the loop re-issues both kills (tray first, same reasoning as above)
; rather than just observing and giving up. If the timeout elapses with a managed
; process still present, the hook does NOT let the install proceed — an earlier
; version fell through to "proceed anyway" here, which is exactly the half-applied
; upgrade this hook exists to prevent (a still-locked file gets silently skipped by
; NSIS with no visible error). Instead it calls `Abort`, which halts the
; install/uninstall outright and sets the process exit code to 2 (NSIS's documented
; "aborted by script" value), so both an interactive user and an automated/silent
; caller get a clear, unambiguous failure instead of a silent half-apply.
;
; SHARED BETWEEN INSTALL AND UNINSTALL: the same stop-and-wait logic backs both
; NSIS_HOOK_PREINSTALL and NSIS_HOOK_PREUNINSTALL via the REMO_STOP_AND_WAIT macro
; below, parameterized on a label-uniqueness suffix so it can be inserted twice in one
; script without colliding labels. An uninstall that leaves the sidecar running can
; fail to remove its exe cleanly, or leave a respawned instance orphaned by the
; uninstall — the same races this hook guards against on install, so both hooks get
; the identical guarantee instead of only one of them offering it.

; Kill both binaries, tray first. `Pop $0` discards the exit code every time — "no
; such process" (a common case: fresh install, already reaped by the in-app updater,
; or the tray/sidecar already killed on this exact pass) is success for us, never an
; error to branch on.
!macro REMO_KILL_BOTH
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "remo-supervisor-tauri.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "remo-code-supervisor.exe"'
  Pop $0
!macroend

; Sets OUTVAR to "1" if a process with image name IMAGE is currently running, "0"
; otherwise. Reads tasklist's own captured output directly: no cmd.exe, no find.exe,
; no NSIS string-matching plugin (StrFunc.nsh et al) — the check compares the first
; len(IMAGE) characters of tasklist's stdout against the literal image name. When
; nothing matches, tasklist prints a localized "no tasks" message instead (English:
; "INFO: No tasks..."), which never equals our image-name prefix in any locale, so
; this stays correct without depending on that message's exact wording.
; Uses relative jumps (+N), not named labels, so this macro is safe to insert any
; number of times in the same script regardless of IMAGE's text — a label derived
; from IMAGE would both collide across repeated insertions (the same two image names
; are checked from both the preinstall and preuninstall call sites below) and be
; invalid NSIS label syntax anyway (image names contain "." and "-").
!macro REMO_CHECK_PRESENT IMAGE OUTVAR
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${IMAGE}" /NH'
  Pop $9 ; exit code — tasklist returns 0 regardless of match count; popped only to
         ; balance the stack (see STACK DISCIPLINE above), never branched on
  Pop $8 ; captured stdout
  StrLen $7 "${IMAGE}"
  StrCpy $6 $8 $7
  StrCmp $6 "${IMAGE}" 0 +3
  StrCpy ${OUTVAR} "1"
  Goto +2
  StrCpy ${OUTVAR} "0"
!macroend

; Full stop-and-wait sequence, shared by NSIS_HOOK_PREINSTALL and
; NSIS_HOOK_PREUNINSTALL. UN is a label-uniqueness suffix (e.g. "preinstall" /
; "preuninstall") so this macro's internal labels do not collide when inserted twice
; in the same generated installer.nsi.
!macro REMO_STOP_AND_WAIT UN
  DetailPrint "Remo Code Supervisor: stopping running instances..."
  !insertmacro REMO_KILL_BOTH

  StrCpy $1 0 ; elapsed poll count (10 * 500ms = 5s ceiling)
  remo_wait_loop_${UN}:
    !insertmacro REMO_CHECK_PRESENT "remo-supervisor-tauri.exe" $0
    StrCmp $0 "1" remo_wait_respawned_${UN}

    !insertmacro REMO_CHECK_PRESENT "remo-code-supervisor.exe" $0
    StrCmp $0 "0" remo_wait_done_${UN} ; both clear

  remo_wait_respawned_${UN}:
    ; Either binary is present again. Re-kill both (tray first, same reasoning as
    ; above) before advancing the poll counter, so a fresh respawn gets exactly the
    ; same treatment as the original kill, not just a passive re-check.
    !insertmacro REMO_KILL_BOTH

    ; IntCmp val1 val2 equal less greater — equal and greater both route to the
    ; timeout (10 ticks * 500ms = 5s ceiling reached or exceeded); less falls
    ; through to Sleep + re-loop. The literal `0` in the "less" slot is NSIS's
    ; documented fall-through-to-next-instruction marker (see e.g. NSIS's own
    ; FileFunc.nsh: `IntCmp $R6 $6 0 0 FileFunc_Locate_findnext`), NOT an empty
    ; string — an empty label there does not fall through and hangs the script
    ; (verified locally: a throwaway .nsi with `IntCmp $1 5 done "" done` never
    ; returned within a 2-minute wall-clock timeout, vs. the `0` form completing
    ; instantly).
    IntOp $1 $1 + 1
    IntCmp $1 10 remo_wait_timeout_${UN} 0 remo_wait_timeout_${UN}
    Sleep 500
    Goto remo_wait_loop_${UN}

  remo_wait_timeout_${UN}:
    ; Do NOT hang the installer forever, but do NOT proceed either. A "safety
    ; check" that gives up after 5s and lets the install continue is not a safety
    ; check - it is a delay with a log line, and it recreates the exact
    ; half-applied-upgrade failure this hook exists to prevent: NSIS would copy
    ; over a file a still-running process holds locked, silently skip that one
    ; file, and leave a mismatched tray/sidecar pair behind with no visible
    ; error. Abort instead: with the tray-first kill order and the respawn
    ; re-kill above, a genuine 5s timeout means something is truly wedged (a
    ; hung process, an AV hold, a permissions problem) - the correct response is
    ; to stop and let the user retry or reboot into a clean state, not to gamble
    ; on NSIS's own file-write failure still catching it.
    ;
    ; Re-check both binaries one more time so the message below names exactly
    ; which one is still stuck, rather than a generic "something is running".
    !insertmacro REMO_CHECK_PRESENT "remo-supervisor-tauri.exe" $2
    !insertmacro REMO_CHECK_PRESENT "remo-code-supervisor.exe" $3
    StrCpy $4 ""
    StrCmp $2 "1" 0 +2
      StrCpy $4 "$4- Remo Code Supervisor (tray)$\r$\n"
    StrCmp $3 "1" 0 +2
      StrCpy $4 "$4- Remo Code Supervisor (sidecar)$\r$\n"

    DetailPrint "Remo Code Supervisor: could not stop the running app within 5s - aborting rather than risk a half-applied upgrade."

    ; Silent installs (/S) - the scripted/IT-deploy path where a half-apply is
    ; most likely to go unnoticed - must fail rather than continue quietly, and
    ; must not pop a dialog (that would defeat the point of /S and could hang an
    ; unattended run waiting on a click nobody will give). `Abort` alone already
    ; sets the installer's exit code to 2 ("aborted by script", NSIS's documented
    ; behavior for any script-driven Abort, distinct from the user-cancel value
    ; of 1) - no separate SetErrorLevel call is needed or added, so an automated
    ; caller can detect the failure from the process exit code alone.
    IfSilent remo_wait_abort_${UN} 0
    MessageBox MB_OK|MB_ICONSTOP "Remo Code Supervisor could not be fully stopped, so the install cannot continue safely:$\r$\n$\r$\n$4$\r$\nClose it from the system tray (or reboot), then run the installer again."

    remo_wait_abort_${UN}:
    ; `Abort "message"` halts the Section immediately and shows the message in
    ; the installer's own status/details display (not a second MessageBox - it
    ; does not duplicate the dialog just shown above for the interactive case,
    ; and is silently skipped in /S besides still halting and setting the exit
    ; code). Valid from a Section (which is where Tauri's generated
    ; installer.nsi inserts NSIS_HOOK_PREINSTALL / NSIS_HOOK_PREUNINSTALL) as
    ; well as an uninstall Section, so this is safe and equivalent in both hooks.
    Abort "Remo Code Supervisor is still running and could not be stopped."

  remo_wait_done_${UN}:
    DetailPrint "Remo Code Supervisor: stop check complete."
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro REMO_STOP_AND_WAIT "preinstall"
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro REMO_STOP_AND_WAIT "preuninstall"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend

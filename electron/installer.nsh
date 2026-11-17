; Extra NSIS macros for Imagine's Windows installer.
;
; Included by electron-builder (`nsis.include: electron/installer.nsh`). Only
; one macro is defined, and it removes the one question the assembled installer
; would otherwise ask.
;
; electron-builder's assisted installer draws a page with two radio buttons:
; "install for all users" (which needs an administrator) and "only for me".
; Imagine is a per-user app — its data lives in %APPDATA%\Imagine, its shortcuts
; in the current user's folders, its uninstall entry in HKCU — so "all users"
; is not a mode this package has, and a page whose first option is disabled
; with "(must run as admin)" is exactly the administrator prompt the app was
; built to avoid.
;
; `customInstallMode` runs in the page function before the page is drawn. The
; multi-user template checks these two variables first: forcing the current
; user makes it call `setInstallModePerUser` and `Abort`, which skips the page.
; The uninstaller includes the same macro and lands on the same mode, so it
; removes the per-user installation without asking anything either. A silent
; install (`/S`) never draws the page and already defaults to per-user, so this
; only changes what a person clicking through the wizard sees.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

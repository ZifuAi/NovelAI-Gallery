; NovelAI Gallery — Windows installer
;
; Per-user install (no admin prompt), Start-menu + desktop shortcuts,
; and an uninstaller registered in Apps & features.

Unicode true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APP_NAME     "NovelAI Gallery"
!define APP_EXE      "NovelAI Gallery.exe"
!define APP_VERSION  "1.1"
!define APP_KEY      "NovelAIGallery"

Name "${APP_NAME}"
OutFile "NovelAI-Gallery-Setup.exe"
BrandingText "${APP_NAME} ${APP_VERSION}"

; Per-user install keeps this out of UAC entirely.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_KEY}" "InstallDir"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING

!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP_NAME} now"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} is installed.$\r$\n$\r$\nOne more step: the gallery only fills up once the browser extension is installed. The app will walk you through it the first time you open it."

; On an upgrade the directory page is pointless - it's already installed
; somewhere - so it's skipped and the existing location reused.
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfUpgrading
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --------------------------------------------------------------------
; Upgrading
;
; Installing over an existing copy has to do three things: find where it
; already lives (rather than installing a second copy somewhere else),
; close it if it's running (Windows won't replace a locked .exe), and
; leave the library completely alone.
;
; The updater inside the app runs this with /S for a silent upgrade, and
; adds /RESTART so the app comes back by itself afterwards.
; --------------------------------------------------------------------

Var PreviousVersion
Var Upgrading

Function .onInit
  StrCpy $Upgrading "0"

  ReadRegStr $0 HKCU "Software\${APP_KEY}" "InstallDir"
  StrCmp $0 "" checkDone 0
    IfFileExists "$0\${APP_EXE}" 0 checkDone
      StrCpy $INSTDIR $0
      StrCpy $Upgrading "1"
      ReadRegStr $PreviousVersion HKCU \
        "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}" "DisplayVersion"
  checkDone:

  ; Whether upgrading or not, a running copy would lock the executable.
  ; taskkill is on every supported Windows and needs no plugin.
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  Sleep 400
FunctionEnd

Function SkipIfUpgrading
  StrCmp $Upgrading "1" 0 +2
    Abort   ; skip the directory page and keep the existing location
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=${APP_EXE}" "novelai-gallery.exe"
  File "icon.ico"

  WriteRegStr HKCU "Software\${APP_KEY}" "InstallDir" "$INSTDIR"

  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Register with Apps & features so it uninstalls like any normal program.
  !define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\icon.ico"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${APP_NAME}"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; The in-app updater passes /RESTART so the app reopens once the files
  ; are in place. Only meaningful with /S; a person running the installer
  ; by hand gets the finish page's "Open now" button instead.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/RESTART" $R1
  IfErrors noRestart 0
    Exec '"$INSTDIR\${APP_EXE}"'
  noRestart:
SectionEnd

Section "Uninstall"
  ; Recursive on purpose: WebView2 keeps a cache folder beside the .exe,
  ; and a plain RMDir left that - and therefore the whole install
  ; directory - behind after every uninstall.
  RMDir /r "$INSTDIR"

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_KEY}"
  DeleteRegKey HKCU "Software\${APP_KEY}"

  ; WebView2 falls back to this location for its cache when it can't write
  ; beside the executable, so clear both rather than guessing which applied.
  RMDir /r "$LOCALAPPDATA\${APP_NAME}"

  ; The library is the one thing that might be worth keeping, so it is the
  ; one thing we ask about. It defaults to No: a mis-click while
  ; uninstalling must not be able to delete a library someone spent months
  ; building.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also delete your saved images and settings?$\r$\n$\r$\nThis permanently removes the whole gallery from:$\r$\n$APPDATA\${APP_NAME}$\r$\n$\r$\nChoose No to keep them for a future reinstall." \
    IDNO KeepLibrary

  RMDir /r "$APPDATA\${APP_NAME}"

KeepLibrary:
SectionEnd

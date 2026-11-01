Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "x64.nsh"

Name "Loopra"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\Loopra"
InstallDirRegKey HKCU "Software\Loopra" "InstallLocation"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
CRCCheck force
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${APP_VERSION_INFO}"
VIAddVersionKey /LANG=1033 "ProductName" "Loopra"
VIAddVersionKey /LANG=1033 "FileDescription" "Loopra Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Loopra contributors"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Loopra.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString CloseLoopra ${LANG_SIMPCHINESE} "请先关闭此目录中的 Loopra，再重新运行安装或卸载。"
LangString CloseLoopra ${LANG_ENGLISH} "Close Loopra in this folder before installing or uninstalling."
LangString InstallFailed ${LANG_SIMPCHINESE} "无法安装 Loopra，已保留原版本。请检查目录权限和可用空间。"
LangString InstallFailed ${LANG_ENGLISH} "Loopra could not be installed. The previous version was preserved. Check folder permissions and free space."
LangString Needs64Bit ${LANG_SIMPCHINESE} "Loopra 需要 64 位 Windows。"
LangString Needs64Bit ${LANG_ENGLISH} "Loopra requires 64-bit Windows."
LangString NeedsARM64 ${LANG_SIMPCHINESE} "请在 ARM64 Windows 上运行此安装包，Intel/AMD 电脑请下载 amd64 安装包。"
LangString NeedsARM64 ${LANG_ENGLISH} "This installer requires ARM64 Windows. Download the amd64 installer for Intel/AMD PCs."
LangString DesktopShortcut ${LANG_SIMPCHINESE} "桌面快捷方式"
LangString DesktopShortcut ${LANG_ENGLISH} "Desktop shortcut"

; Exclusive write access also detects an app that is still running. Never kill
; the user's process from an installer: online updates wait for it to exit.
!macro CheckClosed PREFIX
Function ${PREFIX}CheckClosed
  IfFileExists "$INSTDIR\Loopra.exe" 0 done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Loopra.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r0'
  ${If} $0 == -1
    IfSilent +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(CloseLoopra)"
    SetErrorLevel 5
    Quit
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  done:
FunctionEnd
!macroend
!insertmacro CheckClosed ""
!insertmacro CheckClosed "un."

Section "Loopra" SEC_APP
  SectionIn RO
  SetShellVarContext current
  Call CheckClosed
  SetOutPath "$INSTDIR"
  IfFileExists "$INSTDIR\Loopra.exe" 0 install
    ClearErrors
    Delete "$INSTDIR\Loopra.exe.old"
    Rename "$INSTDIR\Loopra.exe" "$INSTDIR\Loopra.exe.old"
    IfErrors failed
  install:
  ClearErrors
  SetOverwrite on
  File /oname=Loopra.exe "${APP_BINARY}"
  IfErrors rollback
  File /oname=loopra-install.json "${APP_MARKER}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors rollback
  WriteRegStr HKCU "Software\Loopra" "InstallLocation" "$INSTDIR"
  IfErrors rollback
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "DisplayName" "Loopra"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "Publisher" "Loopra"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "DisplayIcon" "$INSTDIR\Loopra.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra" "NoRepair" 1
  IfErrors rollback
  CreateDirectory "$SMPROGRAMS\Loopra"
  CreateShortcut "$SMPROGRAMS\Loopra\Loopra.lnk" "$INSTDIR\Loopra.exe"
  Delete "$INSTDIR\Loopra.exe.old"
  Goto done
  rollback:
    Delete "$INSTDIR\Loopra.exe"
    IfFileExists "$INSTDIR\Loopra.exe.old" 0 fresh_cleanup
      Rename "$INSTDIR\Loopra.exe.old" "$INSTDIR\Loopra.exe"
      Goto failed
    fresh_cleanup:
      Delete "$INSTDIR\loopra-install.json"
      Delete "$INSTDIR\Uninstall.exe"
  failed:
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "$(InstallFailed)"
    SetErrorLevel 1
    Quit
  done:
SectionEnd

Section /o "$(DesktopShortcut)" SEC_DESKTOP
  CreateShortcut "$DESKTOP\Loopra.lnk" "$INSTDIR\Loopra.exe"
SectionEnd

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "$(Needs64Bit)"
    SetErrorLevel 2
    Quit
  ${EndIf}
!if "${APP_ARCH}" == "arm64"
  ${IfNot} ${IsNativeARM64}
    IfSilent +2
      MessageBox MB_OK|MB_ICONSTOP "$(NeedsARM64)"
    SetErrorLevel 2
    Quit
  ${EndIf}
!endif
  ; Upgrades retain the existing optional desktop shortcut.
  IfFileExists "$DESKTOP\Loopra.lnk" 0 +2
    SectionSetFlags ${SEC_DESKTOP} ${SF_SELECTED}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  Call un.CheckClosed
  Delete "$INSTDIR\Loopra.exe"
  Delete "$INSTDIR\Loopra.exe.old"
  Delete "$INSTDIR\loopra-install.json"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\Loopra\Loopra.lnk"
  RMDir "$SMPROGRAMS\Loopra"
  Delete "$DESKTOP\Loopra.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Loopra"
  DeleteRegKey HKCU "Software\Loopra"
  ; Only remove an empty app folder. User data and unrelated files are retained.
  RMDir "$INSTDIR"
SectionEnd

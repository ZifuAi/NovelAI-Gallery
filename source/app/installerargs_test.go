package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The updater and the installer script have to agree on these flags. They
// live in different languages and different files, so nothing but a test
// keeps them in step - and getting it wrong means an update that either
// hangs on a wizard nobody can see, or never reopens the app.
func TestInstallerFlagsMatchTheInstallerScript(t *testing.T) {
	args := installerArgs()

	if len(args) != 2 || args[0] != "/S" || args[1] != "/RESTART" {
		t.Fatalf("installerArgs() = %v, want [/S /RESTART]", args)
	}

	nsi, err := os.ReadFile("installer.nsi")
	if err != nil {
		t.Skip("installer.nsi not present")
	}
	script := string(nsi)

	// /RESTART has to be a flag the script actually reads, not one it
	// silently ignores.
	if !regexp.MustCompile(`\$\{GetOptions\}[^\n]*"/RESTART"`).MatchString(script) {
		t.Error("installer.nsi does not read /RESTART; the app would never reopen after an update")
	}
	// And reading it has to lead to actually starting the app again.
	if !strings.Contains(script, `Exec '"$INSTDIR\${APP_EXE}"'`) {
		t.Error("installer.nsi reads /RESTART but never starts the app")
	}
	// Silent mode is what makes /RESTART meaningful, and NSIS gives /S for
	// free - but the script must not put a MessageBox in the install path,
	// because a silent run would then wait forever on a dialog nobody sees.
	install := script
	if i := strings.Index(script, `Section "Uninstall"`); i > 0 {
		install = script[:i] // the uninstall section may ask; installing may not
	}
	if strings.Contains(install, "MessageBox") {
		t.Error("the install section shows a MessageBox; a silent update would hang on it")
	}
}

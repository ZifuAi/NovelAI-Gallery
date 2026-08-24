package main

// installerArgs is the command line the in-app updater hands to the
// downloaded installer.
//
// It lives on its own, away from the Windows-only launch code, so the flags
// can actually be tested rather than assumed. They have to match what
// installer.nsi understands: /S for a silent run, because the person
// already agreed to the update inside the app and a second wizard would
// just be a wall of Next buttons, and /RESTART so the app comes back by
// itself once its files have been replaced.
func installerArgs() []string {
	return []string{"/S", "/RESTART"}
}

//go:build !windows

package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
)

// Non-Windows builds have no WebView2, so the app just serves the gallery
// and blocks. Used for development and testing on Linux; the shipped
// product is Windows-only.
// applyWindowChrome only means something on Windows, where the title bar
// is drawn by the OS. Kept here so the HTTP layer stays platform-agnostic.
func applyWindowChrome(c WindowChrome) {
	log.Println("window chrome (ignored on this platform):", c)
}

func runWindow(url string) {
	log.Println("headless mode (non-Windows build); open", url)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
}

package main

import (
	"fmt"
	"strconv"
	"strings"
)

// The window's title bar is drawn by Windows, not by the page, so it has
// to be told the theme's colors separately. The UI posts them here
// whenever the theme changes; the platform-specific half of this
// (window_windows.go) hands them to the desktop window manager.
//
// On anything other than Windows this is a no-op, which keeps the app
// buildable and testable on Linux.

type WindowChrome struct {
	Caption string `json:"caption"` // title bar background
	Text    string `json:"text"`    // title bar text and glyphs
	Border  string `json:"border"`  // window border
	Dark    bool   `json:"dark"`    // dark theme, for the pre-Win11 fallback
}

// colorRef converts a CSS color to a Windows COLORREF (0x00BBGGRR).
// Accepts "#rgb", "#rrggbb" and "rgb()/rgba()" - the three forms the
// theme tokens are actually written in. Returns ok=false for anything
// else, and the caller then leaves that attribute alone rather than
// painting the title bar an arbitrary color.
func colorRef(css string) (uint32, bool) {
	s := strings.TrimSpace(strings.ToLower(css))
	if s == "" {
		return 0, false
	}

	if strings.HasPrefix(s, "#") {
		hex := s[1:]
		if len(hex) == 3 {
			hex = string([]byte{hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]})
		}
		if len(hex) != 6 {
			return 0, false
		}
		v, err := strconv.ParseUint(hex, 16, 32)
		if err != nil {
			return 0, false
		}
		r := uint32(v>>16) & 0xff
		g := uint32(v>>8) & 0xff
		b := uint32(v) & 0xff
		return b<<16 | g<<8 | r, true
	}

	if strings.HasPrefix(s, "rgb") {
		open := strings.Index(s, "(")
		close := strings.LastIndex(s, ")")
		if open == -1 || close <= open {
			return 0, false
		}
		parts := strings.FieldsFunc(s[open+1:close], func(r rune) bool {
			return r == ',' || r == '/' || r == ' '
		})
		if len(parts) < 3 {
			return 0, false
		}
		var c [3]uint32
		for i := 0; i < 3; i++ {
			n, err := strconv.ParseFloat(strings.TrimSpace(parts[i]), 64)
			if err != nil || n < 0 || n > 255 {
				return 0, false
			}
			c[i] = uint32(n)
		}
		return c[2]<<16 | c[1]<<8 | c[0], true
	}

	return 0, false
}

func (c WindowChrome) String() string {
	return fmt.Sprintf("caption=%s text=%s border=%s dark=%v", c.Caption, c.Text, c.Border, c.Dark)
}

// explorerSelectCmdLine builds the command line for "show this file in
// File Explorer, selected".
//
// This has to be assembled by hand. Go quotes each argument the way the C
// runtime expects, so `/select,C:\...\NovelAI Gallery\...\x.png` - which
// contains a space, because the data folder does - comes out as one fully
// quoted argument:
//
//	explorer.exe "/select,C:\Users\...\NovelAI Gallery\...\x.png"
//
// Explorer doesn't parse its command line that way. It reads the leading
// quote as the start of a path, fails to make sense of "/select,C:\...",
// and quietly opens Documents instead - which looks exactly like the
// button doing nothing. The form it wants has the quotes around the path
// only:
//
//	explorer.exe /select,"C:\Users\...\NovelAI Gallery\...\x.png"
func explorerSelectCmdLine(exe, path string) string {
	return fmt.Sprintf(`"%s" /select,"%s"`, exe, path)
}

// explorerOpenCmdLine opens a folder, no selection.
func explorerOpenCmdLine(exe, path string) string {
	return fmt.Sprintf(`"%s" "%s"`, exe, path)
}

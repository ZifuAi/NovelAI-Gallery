//go:build windows

package main

import (
	"log"
	"os"
	"sync"
	"unsafe"

	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

// Title bar theming.
//
// The caption is drawn by the desktop window manager, so CSS can't reach
// it - a themed app with a stock white title bar looks half-finished. The
// DWM does expose the colors as window attributes, which is the supported
// way to do this and keeps the real minimise/maximise/close buttons, snap
// layouts, and every accessibility behaviour that comes with them. A
// hand-drawn title bar would have to reimplement all of that, and would
// get it subtly wrong.
//
// Windows 11 (build 22000+) honours the caption/text/border colors.
// Windows 10 has only the immersive dark mode flag, which is set as well,
// so an older machine still gets a dark title bar with a dark theme
// instead of a white one. Every call is best-effort: an unsupported
// attribute returns an error code that is deliberately ignored.

const (
	dwmwaUseImmersiveDarkModeOld = 19 // Windows 10 1809-1909
	dwmwaUseImmersiveDarkMode    = 20
	dwmwaBorderColor             = 34 // Windows 11 22000+
	dwmwaCaptionColor            = 35
	dwmwaTextColor               = 36
)

const (
	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	swpFrameChanged = 0x0020
)

const (
	wmSetIcon   = 0x0080
	iconSmall   = 0
	iconBig     = 1
	gclpHIcon   = -14 // GCLP_HICON
	gclpHIconSm = -34 // GCLP_HICONSM
)

var (
	dwmapi                    = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")

	user32              = windows.NewLazySystemDLL("user32.dll")
	procSetWindowPos    = user32.NewProc("SetWindowPos")
	procSendMessageW    = user32.NewProc("SendMessageW")
	procSetClassLongPtr = user32.NewProc("SetClassLongPtrW")

	shell32           = windows.NewLazySystemDLL("shell32.dll")
	procExtractIconEx = shell32.NewProc("ExtractIconExW")

	windowMu      sync.Mutex
	mainView      webview2.WebView
	mainHWND      uintptr
	pendingChrome *WindowChrome
)

func setAttr(hwnd uintptr, attr uint32, value unsafe.Pointer, size uint32) {
	procDwmSetWindowAttribute.Call(hwnd, uintptr(attr), uintptr(value), uintptr(size))
}

// Negative window/class indices can't be written as a uintptr constant, so
// they go through a variable.
func classIndex(i int) uintptr { return uintptr(i) }

// setWindowIcon puts the app's own icon on the window.
//
// The webview library registers its window class with IDI_APPLICATION -
// the generic Windows program icon - which is what shows in the title bar,
// the taskbar and Alt+Tab, no matter what icon the .exe carries. Explorer
// reads the icon out of the file itself, which is why the shortcut looks
// right while the running window doesn't.
//
// The icon is pulled from this executable by path rather than by resource
// id: the id the icon lands under depends on the tool that stamped it (it
// is 0 here, which MAKEINTRESOURCE can't address unambiguously), whereas
// ExtractIconEx just asks for the first icon group and hands back properly
// sized large and small versions.
func setWindowIcon(hwnd uintptr) {
	defer func() {
		if r := recover(); r != nil {
			log.Println("could not set the window icon:", r)
		}
	}()

	exe, err := os.Executable()
	if err != nil {
		return
	}
	path, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return
	}

	var large, small windows.Handle
	procExtractIconEx.Call(
		uintptr(unsafe.Pointer(path)), 0,
		uintptr(unsafe.Pointer(&large)), uintptr(unsafe.Pointer(&small)), 1,
	)
	if large == 0 && small == 0 {
		return // no icon stamped into the binary; leave the default alone
	}
	if large == 0 {
		large = small
	}
	if small == 0 {
		small = large
	}

	procSendMessageW.Call(hwnd, wmSetIcon, iconBig, uintptr(large))
	procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, uintptr(small))
	// The class icon is the fallback the taskbar and Alt+Tab use, so set
	// that too or the window icon can still come back generic.
	procSetClassLongPtr.Call(hwnd, classIndex(gclpHIcon), uintptr(large))
	procSetClassLongPtr.Call(hwnd, classIndex(gclpHIconSm), uintptr(small))
}

func setChrome(hwnd uintptr, c WindowChrome) {
	// LazyProc.Call panics if the entry point is missing. dwmapi has had
	// DwmSetWindowAttribute since Vista so this shouldn't happen, but a
	// panic here would take the whole app down over a cosmetic detail.
	defer func() {
		if r := recover(); r != nil {
			log.Println("could not set window chrome:", r)
		}
	}()

	dark := int32(0)
	if c.Dark {
		dark = 1
	}
	setAttr(hwnd, dwmwaUseImmersiveDarkMode, unsafe.Pointer(&dark), 4)
	setAttr(hwnd, dwmwaUseImmersiveDarkModeOld, unsafe.Pointer(&dark), 4)

	if v, ok := colorRef(c.Caption); ok {
		setAttr(hwnd, dwmwaCaptionColor, unsafe.Pointer(&v), 4)
	}
	if v, ok := colorRef(c.Text); ok {
		setAttr(hwnd, dwmwaTextColor, unsafe.Pointer(&v), 4)
	}
	if v, ok := colorRef(c.Border); ok {
		setAttr(hwnd, dwmwaBorderColor, unsafe.Pointer(&v), 4)
	}

	// The dark-mode flag in particular doesn't always repaint on its own.
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
		swpNoMove|swpNoSize|swpNoZOrder|swpNoActivate|swpFrameChanged)
}

// applyWindowChrome is called from the HTTP layer, i.e. not on the UI
// thread, so the actual work is dispatched onto it.
func applyWindowChrome(c WindowChrome) {
	windowMu.Lock()
	view, hwnd := mainView, mainHWND
	if hwnd == 0 {
		// The window isn't up yet; remember it and apply on creation.
		saved := c
		pendingChrome = &saved
	}
	windowMu.Unlock()

	if hwnd == 0 {
		return
	}
	if view != nil {
		view.Dispatch(func() { setChrome(hwnd, c) })
		return
	}
	setChrome(hwnd, c)
}

// runWindow opens the real application window. It uses the Edge WebView2
// runtime that ships with Windows rather than bundling a browser engine,
// which is what keeps the installer small.
func runWindow(url string) {
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug: os.Getenv("NOVELAI_GALLERY_DEBUG") == "1",
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  1320,
			Height: 880,
			Center: true,
		},
	})
	if w == nil {
		fatal("Could not open the app window.\n\n" +
			"NovelAI Gallery uses Microsoft Edge WebView2, which is normally " +
			"already installed on Windows 10 and 11. If it is missing, install " +
			"the free \"Evergreen WebView2 Runtime\" from Microsoft and start " +
			"NovelAI Gallery again.")
		return
	}
	defer w.Destroy()

	windowMu.Lock()
	mainView = w
	mainHWND = uintptr(w.Window())
	queued := pendingChrome
	pendingChrome = nil
	hwnd := mainHWND
	windowMu.Unlock()

	setWindowIcon(hwnd)

	// Paint the caption dark straight away rather than flashing white
	// while the page loads and reports its real theme.
	setChrome(hwnd, WindowChrome{Caption: "#16181f", Text: "#eceef4", Border: "#2a2f3d", Dark: true})
	if queued != nil {
		setChrome(hwnd, *queued)
	}

	w.Navigate(url)
	w.Run()
}

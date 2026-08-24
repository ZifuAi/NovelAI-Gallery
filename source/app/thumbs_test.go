package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 120, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The layouts place tiles from the aspect ratio in the PNG header, so a
// thumbnail that rounds to a different shape would shift the grid.
func TestThumbSizeKeepsAspectAndNeverUpscales(t *testing.T) {
	cases := []struct{ w, h, wantW, wantH int }{
		{1024, 1536, 427, 640}, // portrait, the common NovelAI shape
		{1536, 1024, 640, 427}, // landscape
		{1024, 1024, 640, 640}, // square
		{320, 480, 320, 480},   // already small: left alone
		{640, 640, 640, 640},   // exactly the limit
	}
	for _, c := range cases {
		w, h := thumbSize(c.w, c.h)
		if w != c.wantW || h != c.wantH {
			t.Errorf("thumbSize(%d, %d) = %d x %d, want %d x %d",
				c.w, c.h, w, h, c.wantW, c.wantH)
		}
		if w > c.w || h > c.h {
			t.Errorf("thumbSize(%d, %d) upscaled to %d x %d", c.w, c.h, w, h)
		}
		// And the shape survives to within a pixel of rounding.
		srcRatio := float64(c.w) / float64(c.h)
		dstRatio := float64(w) / float64(h)
		if diff := srcRatio - dstRatio; diff > 0.005 || diff < -0.005 {
			t.Errorf("thumbSize(%d, %d) changed the aspect ratio: %.4f -> %.4f",
				c.w, c.h, srcRatio, dstRatio)
		}
	}
}

func TestMakeThumbProducesASmallerJPEG(t *testing.T) {
	src := pngBytes(t, 1024, 1536)
	out, err := makeThumb(src)
	if err != nil {
		t.Fatal(err)
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if format != "jpeg" {
		t.Errorf("format = %q, want jpeg", format)
	}
	if cfg.Width != 427 || cfg.Height != 640 {
		t.Errorf("thumbnail is %d x %d, want 427 x 640", cfg.Width, cfg.Height)
	}
	if _, err := jpeg.Decode(bytes.NewReader(out)); err != nil {
		t.Errorf("the output is not a readable JPEG: %v", err)
	}

	// The point of the whole exercise is fewer pixels to decode per tile.
	srcPixels := 1024 * 1536
	dstPixels := cfg.Width * cfg.Height
	if ratio := float64(srcPixels) / float64(dstPixels); ratio < 5 {
		t.Errorf("only %.1fx fewer pixels; that is not worth a cache", ratio)
	}
}

// A smooth gradient compresses far better as PNG than any JPEG of it will,
// so the byte-size claim has to be made against something representative.
// A generated image is full of fine detail, which is what this imitates.
func TestThumbIsMuchSmallerForARealisticImage(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 1024, 1536))
	seed := uint32(12345)
	for y := 0; y < 1536; y++ {
		for x := 0; x < 1024; x++ {
			// A cheap deterministic PRNG - detail that does not compress,
			// the way real image content does not.
			seed = seed*1664525 + 1013904223
			img.Set(x, y, color.RGBA{uint8(seed >> 24), uint8(seed >> 16), uint8(seed >> 8), 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	src := buf.Bytes()

	out, err := makeThumb(src)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) >= len(src)/5 {
		t.Errorf("thumbnail is %d bytes against an original of %d - expected at least 5x smaller",
			len(out), len(src))
	}
	t.Logf("original %d KB -> thumbnail %d KB", len(src)/1024, len(out)/1024)
}

// A file that can't be decoded has to fail cleanly, because the caller's
// answer to an error is "serve the original" - it must not panic.
func TestMakeThumbRejectsRubbishWithoutPanicking(t *testing.T) {
	for _, bad := range [][]byte{
		nil,
		[]byte("not an image at all"),
		append([]byte("\x89PNG\r\n\x1a\n"), 0x00, 0x01, 0x02),
	} {
		if _, err := makeThumb(bad); err == nil {
			t.Errorf("expected an error for %d bytes of rubbish", len(bad))
		}
	}
}

func TestEnsureThumbCachesAndPrunes(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	rec, err := store.Insert(pngBytes(t, 800, 600), nil)
	if err != nil {
		t.Fatal(err)
	}

	path, err := store.EnsureThumb(rec)
	if err != nil {
		t.Fatal(err)
	}
	first, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	// Asking again must reuse the file, not rebuild it.
	again, err := store.EnsureThumb(rec)
	if err != nil || again != path {
		t.Fatalf("second call returned %q, %v", again, err)
	}
	second, _ := os.Stat(path)
	if !second.ModTime().Equal(first.ModTime()) {
		t.Error("the thumbnail was rebuilt when a cached one already existed")
	}

	// No half-written files left behind.
	if _, err := os.Stat(path + ".part"); err == nil {
		t.Error("a .part file survived; a partial thumbnail could be served")
	}

	// A thumbnail whose image is gone is cleaned up at startup - but only
	// then, so that undoing a delete brings the picture straight back.
	orphan := filepath.Join(store.thumbsDir(), "not-a-real-id.jpg")
	os.WriteFile(orphan, []byte("stale"), 0o644)
	store.pruneOrphanThumbs()
	if _, err := os.Stat(orphan); err == nil {
		t.Error("an orphaned thumbnail was not pruned")
	}
	if _, err := os.Stat(path); err != nil {
		t.Error("pruning removed a thumbnail that still has an image")
	}
}

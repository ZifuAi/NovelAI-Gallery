package main

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Thumbnails.
//
// Every grid tile used to load the original PNG. A NovelAI image is
// typically 1-3 MB at 1024x1536 or larger, so a library of a few hundred
// was fine and a library of ten thousand would not be: the browser decodes
// every one of those at full resolution to draw it 190 pixels wide.
//
// So each image gets a small JPEG cached beside it, and the gallery loads
// that instead. The original PNG is never touched or replaced - it *is*
// the metadata, and it stays the thing you open, zoom, reveal in Explorer
// and hand back to NovelAI.
//
// JPEG rather than PNG because these are photographic images where quality
// 82 at thumbnail size is indistinguishable and roughly a tenth the bytes.
// The resampler is a plain box filter written against the standard library:
// vendored builds need no network, and for the large reductions involved
// here - usually 3x or more - averaging every source pixel that lands in a
// destination pixel is both the cheapest and the most accurate choice.

const (
	// Longest edge. The card slider tops out near 400px and displays can be
	// 2x, so this covers the worst case without needing a second size.
	thumbMaxEdge = 640
	thumbQuality = 82
)

// thumbGen serialises generation per image, so two requests for the same
// missing thumbnail don't both decode the same PNG.
var thumbGen sync.Map // id -> *sync.Mutex

func (s *Store) thumbsDir() string { return filepath.Join(s.dir, "thumbs") }

func (s *Store) thumbPath(id string) string {
	return filepath.Join(s.thumbsDir(), id+".jpg")
}

// thumbSize returns the scaled size for a source, never scaling up: an
// image already smaller than the limit is better served as it is.
func thumbSize(w, h int) (int, int) {
	if w <= 0 || h <= 0 {
		return 0, 0
	}
	if w <= thumbMaxEdge && h <= thumbMaxEdge {
		return w, h
	}
	if w >= h {
		return thumbMaxEdge, max(1, int(float64(h)*float64(thumbMaxEdge)/float64(w)+0.5))
	}
	return max(1, int(float64(w)*float64(thumbMaxEdge)/float64(h)+0.5)), thumbMaxEdge
}

// downscale averages every source pixel falling inside each destination
// pixel. For the reductions here that is what a good resampler would do
// anyway, and it needs nothing outside the standard library.
func downscale(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))

	for dy := 0; dy < dstH; dy++ {
		y0 := b.Min.Y + dy*sh/dstH
		y1 := b.Min.Y + (dy+1)*sh/dstH
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for dx := 0; dx < dstW; dx++ {
			x0 := b.Min.X + dx*sw/dstW
			x1 := b.Min.X + (dx+1)*sw/dstW
			if x1 <= x0 {
				x1 = x0 + 1
			}

			var r, g, bl, n uint64
			for y := y0; y < y1; y++ {
				for x := x0; x < x1; x++ {
					// 16-bit components, summed wide so a large block can't
					// overflow, then brought back down to 8 bits at the end.
					cr, cg, cb, _ := src.At(x, y).RGBA()
					r += uint64(cr)
					g += uint64(cg)
					bl += uint64(cb)
					n++
				}
			}
			if n == 0 {
				continue
			}
			i := dst.PixOffset(dx, dy)
			dst.Pix[i+0] = uint8(r / n >> 8)
			dst.Pix[i+1] = uint8(g / n >> 8)
			dst.Pix[i+2] = uint8(bl / n >> 8)
			dst.Pix[i+3] = 0xff
		}
	}
	return dst
}

// makeThumb turns PNG bytes into JPEG thumbnail bytes.
func makeThumb(png []byte) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(png))
	if err != nil {
		return nil, fmt.Errorf("could not read that image: %w", err)
	}
	b := src.Bounds()
	w, h := thumbSize(b.Dx(), b.Dy())
	if w == 0 || h == 0 {
		return nil, fmt.Errorf("that image has no size")
	}

	var out bytes.Buffer
	if err := jpeg.Encode(&out, downscale(src, w, h), &jpeg.Options{Quality: thumbQuality}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// EnsureThumb returns the path to an image's thumbnail, making it first if
// it doesn't exist yet. An error means the caller should fall back to the
// original - a thumbnail failing is a reason to be slower, never a reason
// to show a broken image.
func (s *Store) EnsureThumb(rec *Record) (string, error) {
	if rec == nil {
		return "", fmt.Errorf("no such image")
	}
	path := s.thumbPath(rec.ID)
	if st, err := os.Stat(path); err == nil && st.Size() > 0 {
		return path, nil
	}

	// One generator per image, so a burst of tiles asking for the same
	// missing thumbnail decodes the PNG once rather than N times.
	lockAny, _ := thumbGen.LoadOrStore(rec.ID, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()
	defer thumbGen.Delete(rec.ID)

	// Another request may have made it while this one waited.
	if st, err := os.Stat(path); err == nil && st.Size() > 0 {
		return path, nil
	}

	src := s.ImagePath(rec)
	data, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	thumb, err := makeThumb(data)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(s.thumbsDir(), 0o755); err != nil {
		return "", err
	}
	// Write to a temporary name and rename, so a half-written file can
	// never be served as a thumbnail.
	tmp := path + ".part"
	if err := os.WriteFile(tmp, thumb, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return path, nil
}

func (s *Store) removeThumb(id string) { os.Remove(s.thumbPath(id)) }

// BackfillThumbs walks the library making any thumbnail that is missing.
//
// It runs in the background at startup so an existing library becomes fast
// without anyone waiting for it, and takes the lock only long enough to
// copy the list - generating under the store lock would stall every other
// request while it decoded.
func (s *Store) BackfillThumbs() {
	s.pruneOrphanThumbs()

	s.mu.RLock()
	pending := make([]*Record, 0, len(s.records))
	for _, r := range s.records {
		if r == nil {
			continue
		}
		if st, err := os.Stat(s.thumbPath(r.ID)); err == nil && st.Size() > 0 {
			continue
		}
		pending = append(pending, r)
	}
	s.mu.RUnlock()

	for _, r := range pending {
		if _, err := s.EnsureThumb(r); err != nil {
			// One unreadable file shouldn't stop the rest; that image just
			// keeps being served full-size.
			continue
		}
	}
}

// pruneOrphanThumbs deletes thumbnails whose image is gone.
//
// Deleting an image deliberately leaves its thumbnail alone, because a
// delete can be undone and the picture should come straight back rather
// than being regenerated. That makes startup the right moment to clean up:
// by then the undo history is gone and the trash has been swept, so
// anything without a record is genuinely orphaned.
func (s *Store) pruneOrphanThumbs() {
	entries, err := os.ReadDir(s.thumbsDir())
	if err != nil {
		return // no thumbnails yet, nothing to prune
	}

	s.mu.RLock()
	live := make(map[string]bool, len(s.records))
	for _, r := range s.records {
		if r != nil {
			live[r.ID] = true
		}
	}
	s.mu.RUnlock()

	for _, e := range entries {
		name := e.Name()
		id := strings.TrimSuffix(strings.TrimSuffix(name, ".part"), ".jpg")
		if id == name && !strings.HasSuffix(name, ".jpg") {
			continue // not something we wrote
		}
		if !live[id] {
			os.Remove(filepath.Join(s.thumbsDir(), name))
		}
	}
}

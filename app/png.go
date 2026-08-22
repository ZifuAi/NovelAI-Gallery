package main

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"io"
)

// PNG metadata reader.
//
// NovelAI embeds generation metadata directly into the PNG as tEXt/iTXt
// chunks, so keeping the original file bytes keeps the metadata for free.
// This only needs to read those chunks back out for indexing and display.
//
// PNG layout: 8-byte signature, then chunks of
//   [4-byte length][4-byte type][length bytes data][4-byte CRC]

var pngSignature = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// Meta is the normalized metadata attached to each stored image.
type Meta struct {
	IsNovelAI      bool                   `json:"isNovelAI"`
	Width          int                    `json:"width"`
	Height         int                    `json:"height"`
	Prompt         string                 `json:"prompt"`
	NegativePrompt string                 `json:"negativePrompt"`
	Seed           any                    `json:"seed"`
	Steps          any                    `json:"steps"`
	Sampler        string                 `json:"sampler"`
	Scale          any                    `json:"scale"`
	Strength       any                    `json:"strength"`
	Noise          any                    `json:"noise"`
	Model          string                 `json:"model"`
	Software       string                 `json:"software"`
	Comment        map[string]any         `json:"comment"`
	Raw            map[string]string      `json:"raw"`
}

func isPNG(b []byte) bool {
	return len(b) >= 8 && bytes.Equal(b[:8], pngSignature)
}

type pngChunk struct {
	typ  string
	data []byte
}

func parseChunks(b []byte) []pngChunk {
	var out []pngChunk
	if !isPNG(b) {
		return out
	}
	off := 8
	for off+8 <= len(b) {
		length := int(binary.BigEndian.Uint32(b[off : off+4]))
		typ := string(b[off+4 : off+8])
		dataStart := off + 8
		dataEnd := dataStart + length
		// Guard against a truncated or malformed file rather than panicking.
		if length < 0 || dataEnd+4 > len(b) || dataEnd < dataStart {
			break
		}
		out = append(out, pngChunk{typ: typ, data: b[dataStart:dataEnd]})
		off = dataEnd + 4
		if typ == "IEND" {
			break
		}
	}
	return out
}

// decodeText pulls the keyword/value pair out of a tEXt or iTXt chunk.
func decodeText(c pngChunk) (string, string, bool) {
	switch c.typ {
	case "tEXt":
		i := bytes.IndexByte(c.data, 0)
		if i < 0 {
			return "", "", false
		}
		return string(c.data[:i]), string(c.data[i+1:]), true

	case "iTXt":
		// keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
		i := bytes.IndexByte(c.data, 0)
		if i < 0 || i+3 > len(c.data) {
			return "", "", false
		}
		keyword := string(c.data[:i])
		compressed := c.data[i+1] == 1

		p := i + 3
		langEnd := bytes.IndexByte(c.data[p:], 0)
		if langEnd < 0 {
			return "", "", false
		}
		p += langEnd + 1
		transEnd := bytes.IndexByte(c.data[p:], 0)
		if transEnd < 0 {
			return "", "", false
		}
		p += transEnd + 1
		if p > len(c.data) {
			return "", "", false
		}

		if compressed {
			zr, err := zlib.NewReader(bytes.NewReader(c.data[p:]))
			if err != nil {
				return keyword, "", true
			}
			defer zr.Close()
			inflated, err := io.ReadAll(zr)
			if err != nil {
				return keyword, "", true
			}
			return keyword, string(inflated), true
		}
		return keyword, string(c.data[p:]), true
	}
	return "", "", false
}

func str(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// extractMetadata reads NovelAI's convention:
//
//	Title       "AI generated image"
//	Description the positive prompt
//	Software    "NovelAI"
//	Source      model identifier
//	Comment     JSON with the rest (steps, sampler, seed, scale, uc, ...)
func extractMetadata(b []byte) Meta {
	m := Meta{Raw: map[string]string{}}

	for _, c := range parseChunks(b) {
		if c.typ == "IHDR" && len(c.data) >= 8 {
			m.Width = int(binary.BigEndian.Uint32(c.data[0:4]))
			m.Height = int(binary.BigEndian.Uint32(c.data[4:8]))
		}
		if c.typ == "tEXt" || c.typ == "iTXt" {
			if k, v, ok := decodeText(c); ok {
				m.Raw[k] = v
			}
		}
	}

	if raw, ok := m.Raw["Comment"]; ok && raw != "" {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			m.Comment = parsed
		}
	}

	m.Software = m.Raw["Software"]
	m.Model = m.Raw["Source"]
	m.Prompt = m.Raw["Description"]

	if m.Comment != nil {
		if m.Prompt == "" {
			m.Prompt = str(m.Comment, "prompt")
		}
		if uc := str(m.Comment, "uc"); uc != "" {
			m.NegativePrompt = uc
		} else {
			m.NegativePrompt = str(m.Comment, "negative_prompt")
		}
		m.Seed = m.Comment["seed"]
		m.Steps = m.Comment["steps"]
		m.Sampler = str(m.Comment, "sampler")
		m.Scale = m.Comment["scale"]
		m.Strength = m.Comment["strength"]
		m.Noise = m.Comment["noise"]
		if m.Model == "" {
			m.Model = str(m.Comment, "source")
		}
		if m.Model == "" {
			m.Model = str(m.Comment, "model")
		}
	}

	m.IsNovelAI = m.Software == "NovelAI" || m.Comment != nil
	return m
}

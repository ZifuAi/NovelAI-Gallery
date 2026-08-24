//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// Sealing a secret with DPAPI.
//
// CryptProtectData encrypts against the logged-in Windows account, so the
// token on disk is unreadable to another user of the same PC and unusable
// if the file is copied elsewhere. Windows manages the key; the app never
// holds one, which is the point - a key this program could reach is a key
// anything running as this program could reach.

var (
	crypt32             = syscall.NewLazyDLL("crypt32.dll")
	procProtectData     = crypt32.NewProc("CryptProtectData")
	procUnprotectData   = crypt32.NewProc("CryptUnprotectData")
	kernel32Local       = syscall.NewLazyDLL("kernel32.dll")
	procLocalFreeSecret = kernel32Local.NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func newBlob(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

// bytes copies the result out before the OS buffer is freed.
func (b dataBlob) bytes() []byte {
	if b.cbData == 0 || b.pbData == nil {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

// entropy ties the ciphertext to this application, so a blob sealed by
// something else on the same account cannot be swapped in.
var secretEntropy = []byte("NovelAI Tools token v1")

func sealSecret(clear []byte) ([]byte, error) {
	in := newBlob(clear)
	ent := newBlob(secretEntropy)
	var out dataBlob

	r, _, err := procProtectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0, // description
		uintptr(unsafe.Pointer(&ent)),
		0, 0,
		0, // flags
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("could not encrypt the token: %v", err)
	}
	defer procLocalFreeSecret.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

func openSecret(sealed []byte) ([]byte, error) {
	in := newBlob(sealed)
	ent := newBlob(secretEntropy)
	var out dataBlob

	r, _, err := procUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0,
		uintptr(unsafe.Pointer(&ent)),
		0, 0,
		0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return nil, fmt.Errorf("could not decrypt the token: %v", err)
	}
	defer procLocalFreeSecret.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

// secretProtection describes what is actually protecting the token, so the
// UI can tell the truth rather than a reassuring guess.
func secretProtection() string { return "encrypted for your Windows account" }

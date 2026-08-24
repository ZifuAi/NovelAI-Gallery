//go:build !windows

package main

// Off Windows there is no DPAPI, and inventing encryption with a key kept
// beside the ciphertext would protect nothing while looking like it did.
// The dev build stores the token as-is behind 0600 permissions, and says so.

func sealSecret(clear []byte) ([]byte, error)  { return clear, nil }
func openSecret(sealed []byte) ([]byte, error) { return sealed, nil }

func secretProtection() string { return "stored unencrypted (development build)" }

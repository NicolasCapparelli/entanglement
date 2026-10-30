# Client-side encryption wire format (version `e1`)

Optional. A device given a `cipher` wraps its backend so the server only ever
stores ciphertext. State digests are computed by the engine over plaintext and
pass through unchanged; the server only compares them. Implemented identically
in Dart (`cryptography`) and TS (`@noble/ciphers`); both pass
`spec/vectors/cipher.json`.

## Token

    e1.<keyId>.<base64url(nonce[24] ‖ ciphertext ‖ tag[16])>

- XChaCha20-Poly1305, 32-byte key, random 24-byte nonce per seal.
- `keyId`: 1-32 chars of `[A-Za-z0-9_-]`. A device holds several keys and
  decrypts with the one named; it encrypts with its active key (rotation).
- base64url, no padding. Plaintext is UTF-8.
- Associated data: UTF-8 of `entanglement/e1|<context>`, so a server cannot
  move a ciphertext to another slot.

## What is encrypted, and its context

| Field | Wire form | Context |
|---|---|---|
| Document value (commit change, checkpoint entity) | canonical JSON `{"$enc":"<token>"}`; plaintext is the canonical JSON of the value | `value\|<collection>\|<id>` |
| Commit `message` | token string | `message\|<commitId>` |
| Commit `deviceLabel` | token string | `deviceLabel\|<commitId>` |
| Restore point `label` | token string | `restoreLabel\|<revision>\|<kind>` |
| Restore point `deviceLabel` | token string | `restoreDevice\|<revision>\|<kind>` |

Deletes (`null` values) and null fields stay null. Everything else (ids,
collection names, revisions, digests, schema versions, times) is plaintext
metadata the server needs. A reader rejects anything that is not a valid
token (no plaintext fallback).

## Vectors

`spec/vectors/cipher.json`: `tokens` (key, nonce, context, plaintext -> token),
`values` (document wrap/unwrap) and `failures` (wrong context, unknown key,
tampering, plaintext, truncation). Seals use the fixed nonce given.

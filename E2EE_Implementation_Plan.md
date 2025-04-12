# E2EE Implementation Plan: Extension <-> Web UI

## 1. Goal

Implement End-to-End Encryption (E2EE) for the WebSocket connection established between the VS Code Extension client and the separate Web UI client (running in a standard browser). This secures the communication channel after the initial connection setup via the server.

## 2. Encryption Scope

- **Encrypt:** Only the `payload` field of the `WebSocketMessage` objects exchanged between the Extension and the Web UI.
- **Do Not Encrypt:** All other metadata fields (`id`, `type`, `action`, `status`, `event`, `data`, `error`, `clientType`, etc.).

## 3. Cryptography Library

- **Library:** `libsodium-wrappers` will be used for all cryptographic operations in both the Extension (Node.js) and Web UI (Browser) environments.
- **Algorithms:**
  - Key Pair Generation: X25519 (`crypto_box_keypair`)
  - Key Exchange (ECDH): `crypto_scalarmult`
  - Authenticated Symmetric Encryption: ChaCha20-Poly1305 with IETF nonce (`crypto_aead_chacha20poly1305_ietf_encrypt` / `decrypt`)
  - Hashing (for verification): Blake2b (`crypto_generichash`)
  - Key Derivation (from shared secret): HKDF or `crypto_kdf`

## 4. Key Management & Storage

### 4.1. VS Code Extension

- **Key Pair:** Generate a persistent X25519 key pair upon first run after feature deployment.
- **Private Key Storage:** Store the Extension's private key securely using VS Code's `SecretStorage` API.
- **Peer Public Key Storage:** Store the public keys of paired Web UI devices, associated with a unique Web UI device ID (provided by the Web UI during pairing), also in `SecretStorage`.

### 4.2. Web UI (Browser)

- **Key Pair:** Generate a persistent X25519 key pair upon first run after feature deployment.
- **Device ID:** Generate a unique, persistent device ID (e.g., UUID) and store it in `localStorage`.
- **Private Key Storage:** Store the Web UI's private key (e.g., as a hex-encoded string) in the browser's `localStorage`.
  - **Security Warning:** This method is vulnerable to Cross-Site Scripting (XSS) attacks. This risk is acknowledged and accepted for implementation simplicity.
- **Peer Public Key Storage:** Store the public key of the paired Extension instance in `localStorage`.

## 5. Pairing Process (Per Extension <-> Web UI Device Pair)

This process establishes the secure channel between a specific Extension instance and a specific Web UI browser instance. It occurs *after* the standard connection flow (login, session selection, basic WebSocket connection via server).

1. **Connection:** Extension and Web UI establish their respective WebSocket connections to the server for the selected session ID.
2. **Pairing Check:** The E2EE wrappers on both sides check their persistent storage (`SecretStorage` / `localStorage`) to see if a public key for the peer device already exists.
3. **If Not Paired (First Time):**
    a.  **Initiation:** Web UI sends a `request-e2ee-pairing` message to the Extension, including its unique device ID.
    b.  **Code Generation:** Extension generates a short, temporary pairing code (e.g., 6 digits).
    c.  **Code Display:** Extension displays the code via a VS Code notification (`window.showInformationMessage`) instructing the user to enter it in the Web UI.
    d.  **Public Key Exchange:** Extension and Web UI exchange their public keys via `e2ee-pubkey-exchange` messages.
    e.  **Code Input:** Web UI prompts the user to enter the pairing code.
    f.  **Shared Secret Derivation:** Both clients compute the shared secret using ECDH (`crypto_scalarmult`) with their private key and the peer's public key.
    g.  **Verification Hash Calculation:** Both clients compute a verification hash using a secure hash function (e.g., `crypto_generichash`) over the derived shared secret and the pairing code.
    h.  **Verification Hash Exchange:** Clients exchange these hashes via `e2ee-verify` messages.
    i.  **Verification Check:** Each client compares the received hash with their locally computed expected hash.
    j.  **Pairing Success:** If hashes match, the pairing is successful. Store the peer's public key persistently. Derive the symmetric session key from the shared secret (e.g., using `crypto_kdf`). Mark the connection as paired and ready for encrypted communication.
    k.  **Pairing Failure:** If hashes don't match, display an error to the user (e.g., "Incorrect pairing code"). Abort E2EE setup for this session.
4. **If Already Paired:**
    a.  **Public Key Exchange:** Public keys are still exchanged via `e2ee-pubkey-exchange`.
    b.  **Shared Secret Derivation:** Both clients compute the shared secret using ECDH.
    c.  **Session Key Derivation:** Derive the symmetric session key from the shared secret. Mark the connection as paired and ready. No user interaction (pairing code) is required.

## 6. Implementation Details

- **Shared Module:** Create `src/services/e2ee/` containing:
  - Cryptographic utility functions (wrapping `libsodium-wrappers`).
  - Key storage helper classes/interfaces abstracting `SecretStorage` and `localStorage`.
  - Pairing state management logic.
- **WebSocket Wrappers:**
  - `EncryptedWebSocketClient` (in `src/services/websocket/`) wrapping the original `WebSocketClient`.
  - `EncryptedWsClient` (in `webview-ui/src/lib/`) wrapping the original `WsClient`.
  - Responsibilities: Manage E2EE state (unpaired, pairing, paired), handle E2EE messages, intercept/encrypt outgoing payloads, intercept/decrypt incoming payloads. Add an `isEncrypted: true` flag to messages containing encrypted payloads.
- **Integration:** Update Extension (`extension.ts`/service setup) and Web UI (`App.tsx`/initialization) to use the new encrypted wrappers.
- **UI:** Add necessary React components in the Web UI for the pairing code input prompt and feedback messages.
- **Dependencies:** Add `libsodium-wrappers` to `package.json` (root) and `webview-ui/package.json`.

## 7. Dependencies

- `libsodium-wrappers`

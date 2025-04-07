# End-to-End Encryption Plan (Webview <-> Extension)

This document outlines the plan to implement end-to-end encryption (E2EE) for the communication channel between the VS Code extension's webview UI and the extension host process. This ensures that messages exchanged via `vscode.postMessage` are confidential and tamper-proof, and the intermediate WebSocket server does not have access to the plaintext data.

## 1. Cryptography Library

* **Library:** `libsodium-wrappers` will be integrated into both the extension (`src`) and the webview (`webview-ui`).
* **Reasoning:** Provides high-level, secure, and well-audited APIs for:
  * Key Generation (X25519)
  * Authenticated Key Exchange (X25519)
  * Authenticated Encryption with Associated Data (AEAD) (ChaCha20-Poly1305)

## 2. Key Management

* **Key Types:** Long-term public/private key pairs (X25519) for identity and establishing trust, and ephemeral session keys for message encryption.
* **Generation:** Generated upon first pairing attempt by both the extension and the webview.
* **Storage:**
  * **Extension:**
    * Private Key: `vscode.SecretStorage` (Secure storage provided by VS Code).
    * Webview's Public Key: Extension's global state or persistent storage (e.g., `context.globalState`).
  * **Webview:**
    * Private Key: `localStorage`.
    * Extension's Public Key: `localStorage`.
  * **Note:** `localStorage` is deemed acceptable for the webview context within VS Code for this use case.

## 3. Pairing Process (Pairing Code Verification)

* **Goal:** Securely exchange long-term public keys, verified by a user-transferred code, preventing Man-in-the-Middle (MitM) attacks during initial setup.
* **Flow:**
    1. **Initiation:** User clicks "Pair Device" in the webview.
    2. **Webview Keys:** Webview generates its key pair, stores the private key in `localStorage`.
    3. **Request:** Webview sends its public key to the extension via `postMessage`.
    4. **Extension Keys & Code:** Extension generates its key pair (if needed), stores the private key in `SecretStorage`. It generates a short, random pairing code (e.g., 6 digits).
    5. **Code Display:** Extension displays the code via `vscode.window.showInformationMessage`.
    6. **Code Entry:** Webview prompts the user to enter the displayed code.
    7. **Verification Calculation (Extension):** Extension calculates a verification value (e.g., HMAC or derived key hash) using both public keys and the *generated* pairing code.
    8. **Challenge:** Extension sends its public key and the calculated verification value to the webview via `postMessage`.
    9. **Verification Calculation (Webview):** Webview calculates the *expected* verification value using both public keys and the *user-entered* code.
    10. **Validation:** Webview compares its calculated value with the received value.
        * **Match:** Pairing successful. Webview stores the extension's public key in `localStorage` and sends a success message to the extension. Extension stores the webview's public key. State becomes "Paired".
        * **Mismatch:** Pairing failed. Webview shows an error ("Invalid Code"). State remains "Unpaired".

## 4. Secure Session Establishment (Post-Pairing)

* **Trigger:** On subsequent loads when both sides detect stored keys for the other party, or immediately after successful pairing.
* **Mechanism:** Diffie-Hellman key exchange (X25519) using long-term keys.
    1. Webview sends its public key (`sessionHello`) to the extension.
    2. Extension verifies the key, calculates the shared secret, stores it, and responds with its public key (`sessionAck`).
    3. Webview receives the ack, calculates the shared secret using its private key and the extension's public key, and stores it.
* **Result:** A unique, ephemeral shared secret key for the current session. This provides forward secrecy.

## 5. Message Encryption/Decryption

* **Algorithm:** Authenticated Encryption (ChaCha20-Poly1305 using the ephemeral session key).
* **Process:**
  * Messages (excluding specific types like pairing/session/state) exchanged via `postMessage` after session establishment are wrapped in an `encryptedMessage` type containing an `encryptedPayload`.
  * The sender encrypts the original message (JSON stringified) into the `encryptedPayload`.
  * The receiver decrypts the `encryptedPayload` and processes the original inner message.
  * AEAD ensures both confidentiality and integrity.
* **Implementation:**
  * Modify message sending points (e.g., `ClineProvider.postMessageToWebview`, handlers in `ChatView.tsx`) to check for the session secret and encrypt if applicable.
  * Modify message receiving points (`webviewMessageHandler.ts`, `App.tsx`'s `onMessage`) to check for `encryptedMessage`, decrypt, and re-process the inner message.

## 6. UI/UX (Webview)

* Display connection/pairing status (Unpaired, Pairing, Awaiting Code, Verifying, Paired, Error).
* Button to initiate pairing.
* Input field for pairing code.
* Display pairing errors.
* Optional: Button to unpair/reset keys.

## 7. Implementation Progress (As of 2025-04-07 ~7:53 PM UTC+7)

**Completed:**

* **Dependencies:** Added `libsodium-wrappers` and `@types/libsodium-wrappers` to both extension and webview projects.
* **Crypto Utilities:** Created `src/services/crypto/cryptoUtils.ts` and `webview-ui/src/lib/cryptoUtils.ts` with core functions (key gen, secret calculation, encrypt/decrypt, pairing code/verification).
* **Extension Key Management:** Integrated key generation/loading in `extension.ts` using `SecretStorage`. Modified `ClineProvider` and related functions (`registerCommands`) to handle the extension's public key.
* **Shared Types:** Added message types (`pairingRequest`, `pairingSuccess`, `sessionHello`, `sessionAck`, `pairingChallenge`, `pairingStatus`, `encryptedMessage`) and payload properties (`extensionPublicKey`, `verificationValue`, `status`, `encryptedPayload`) to `WebviewMessage.ts` and `ExtensionMessage.ts`.
* **Pairing Logic (Extension):** Added handlers for `pairingRequest` and `pairingSuccess` in `webviewMessageHandler.ts`.
* **Pairing Logic (Webview):** Added state, effects, UI elements (in `App.tsx`), and handlers (`handlePairClick`, `handleVerifyCodeClick`, `onMessage` updates) for the pairing flow.
* **Session Key Exchange Logic:** Implemented handlers for `sessionHello` (extension) and `sessionAck` (webview), including shared secret calculation and storage (`sessionSharedSecret` state/property). Added calls to initiate the exchange upon successful pairing.
* **Encryption (Extension Sending):** Modified `ClineProvider.postMessageToWebview` to encrypt outgoing messages (except excluded types) when `sessionSharedSecret` exists.
* **Decryption (Extension Receiving):** Added logic to `webviewMessageHandler.ts` to handle incoming `encryptedMessage`, decrypt the payload, and re-process the inner message.
* **Encryption Setup (Webview Sending):** Added `sessionSharedSecret` prop to `ChatView`, added `postEncryptedMessage` helper function. Updated `handleSendMessage` and `startNewTask` in `ChatView.tsx` to use the helper.

**Remaining:**

* **Webview Encryption:** Update remaining message sending calls in `ChatView.tsx` (`handlePrimaryButtonClick`, `handleSecondaryButtonClick`, `selectImages`, potentially others like TTS/sound calls) to use `postEncryptedMessage`.
* **Webview Decryption:** Implement decryption logic in `App.tsx`'s `onMessage` handler for incoming `encryptedMessage` types from the extension.
* **Error Handling:** Refine error handling and user feedback for pairing and session establishment failures on both sides.
* **Testing:** Thoroughly test the entire E2EE flow, including initial pairing, loading existing pairs, message exchange, and error conditions.
* **Security Review:** Consider potential edge cases or vulnerabilities (though libsodium handles much of the complexity).
* **Unpairing UI (Optional):** Add UI elements and logic to allow users to unpair and reset keys if needed.

## Mermaid Diagram (Simplified Flow)

```mermaid
sequenceDiagram
    participant WebviewUI
    participant User
    participant Extension
    participant VSCodeAPI
    participant LocalStorage
    participant SecretStorage

    alt Initial Pairing
        Note over WebviewUI, Extension: State: Unpaired
        WebviewUI->>User: Show "Pair Device" Button
        User->>WebviewUI: Click "Pair Device"
        WebviewUI->>WebviewUI: Generate Webview KeyPair
        WebviewUI->>LocalStorage: Store Webview Private Key
        WebviewUI->>Extension: postMessage(type: 'pairingRequest', webviewPublicKey)

        Extension->>Extension: Generate Extension KeyPair (if needed)
        Extension->>SecretStorage: Store Extension Private Key
        Extension->>Extension: Generate Pairing Code (e.g., 123456)
        Extension->>VSCodeAPI: showInformationMessage("Enter Code: 123456")
        VSCodeAPI->>User: Display Pairing Code

        WebviewUI->>User: Prompt for Pairing Code
        User->>WebviewUI: Enter Code (e.g., 123456)

        Extension->>Extension: Calculate Verification Value (using keys + code '123456')
        Extension->>WebviewUI: postMessage(type: 'pairingChallenge', extensionPublicKey, verificationValue)

        WebviewUI->>WebviewUI: Calculate Own Verification Value (using keys + entered code)
        alt Keys & Code Match
            WebviewUI->>LocalStorage: Store Extension Public Key
            WebviewUI->>Extension: postMessage(type: 'pairingSuccess')
            Extension->>Extension: Store Webview Public Key (e.g., global state)
            Note over WebviewUI, Extension: State: Paired
            %% Session Exchange Triggered Here
            WebviewUI->>Extension: postMessage(type: 'sessionHello', webviewPublicKey)
            Extension->>WebviewUI: postMessage(type: 'sessionAck', extensionPublicKey)
            WebviewUI->>WebviewUI: Compute Ephemeral Session Shared Secret
            Extension->>Extension: Compute Ephemeral Session Shared Secret
            Note over WebviewUI, Extension: Secure Session Established
        else Keys or Code Mismatch
            WebviewUI->>User: Show Error: Invalid Code
            Note over WebviewUI, Extension: State: Unpaired (retry possible)
        end
    end

    alt Subsequent Load (Already Paired)
        Note over WebviewUI, Extension: State: Paired
        WebviewUI->>LocalStorage: Retrieve Keys
        Extension->>SecretStorage: Retrieve Keys
        Extension->>Extension: Retrieve Stored Webview Public Key

        %% Session Key Exchange (Diffie-Hellman)
        WebviewUI->>Extension: postMessage(type: 'sessionHello', webviewPublicKey)
        Extension->>WebviewUI: postMessage(type: 'sessionAck', extensionPublicKey)
        WebviewUI->>WebviewUI: Compute Ephemeral Session Shared Secret
        Extension->>Extension: Compute Ephemeral Session Shared Secret
        Note over WebviewUI, Extension: Secure Session Established

        %% Encrypted Communication
        WebviewUI->>Extension: postMessage(type: 'encryptedMessage', encryptedPayload: encrypt(payload, sessionSecret))
        Extension->>WebviewUI: postMessage(type: 'encryptedMessage', encryptedPayload: encrypt(response, sessionSecret))
    end

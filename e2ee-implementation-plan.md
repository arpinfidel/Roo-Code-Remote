# End-to-End Encryption (E2EE) Implementation Plan

## Introduction and Requirements

This document outlines the implementation plan for adding end-to-end encryption (E2EE) between the extension client and web UI client in the Roo-Code application. The implementation will follow these requirements:

1. Encapsulate the logic as much as possible
2. Only wrap the websocket client
3. Minimize changes to existing code
4. Only encrypt the payload, not the metadata
5. Use a pairing code to prevent man-in-the-middle (MITM) attacks
6. Pairing should be per-device, not per-session
7. Separate logic for:
   - Pairing/connection status
   - Websocket connection
   - Messaging logic
8. Ensure proper integration with UI elements

## Current Architecture Overview

The current communication flow works as follows:

1. The extension client (`WebSocketClient` in `src/services/websocket/client.ts`) connects to the server
2. The web UI client (`WsClient` in `webview-ui/src/lib/ws-client.ts`) connects to the server
3. The server (`server/ws.go`) relays messages between clients based on session ID
4. Authentication is handled via Firebase, with tokens passed from the web UI to the extension

Messages are sent as JSON objects with fields like id, type, action, payload, etc. The server enriches messages with metadata like timestamp, clientID, clientType, etc.

## E2EE Implementation Design

### Core Components

#### 1. Encryption Service

This service will handle all cryptographic operations, including key generation, encryption, and decryption.

```typescript
// src/services/encryption/EncryptionService.ts
export class EncryptionService {
  private keyPair: CryptoKeyPair | null = null;
  private sharedKey: CryptoKey | null = null;
  private deviceId: string; // Unique per device
  private pairingCode: string | null = null;
  private pairingStatus: 'unpaired' | 'pairing' | 'paired' = 'unpaired';
  
  // Methods for key generation, encryption, decryption
  async generateKeyPair(): Promise<void> {...}
  async deriveSharedKey(publicKey: JsonWebKey): Promise<void> {...}
  async encrypt(data: any): Promise<EncryptedData> {...}
  async decrypt(encryptedData: EncryptedData): Promise<any> {...}
  
  // Pairing methods
  generatePairingCode(): string {...}
  verifyPairingCode(code: string): boolean {...}
  
  // Status methods
  getPairingStatus(): 'unpaired' | 'pairing' | 'paired' {...}
}
```

#### 2. Encrypted WebSocket Client Wrapper (Extension)

This wrapper will intercept messages before they are sent and after they are received to handle encryption/decryption.

```typescript
// src/services/encryption/EncryptedWebSocketClient.ts
export class EncryptedWebSocketClient {
  private wsClient: WebSocketClient;
  private encryptionService: EncryptionService;
  
  constructor(config: WebSocketConfig, encryptionService: EncryptionService) {
    this.wsClient = new WebSocketClient(config);
    this.encryptionService = encryptionService;
    this.setupEventHandlers();
  }
  
  // Wrap original methods
  public connect(): Promise<void> {...}
  public send(message: WebSocketMessage): Promise<void> {...}
  public disconnect(): void {...}
  
  // Handle encryption/decryption
  private async encryptMessage(message: WebSocketMessage): Promise<WebSocketMessage> {...}
  private async decryptMessage(message: WebSocketMessage): Promise<WebSocketMessage> {...}
  
  // Event handling
  private setupEventHandlers(): void {...}
}
```

#### 3. Encrypted WebSocket Client Wrapper (Web UI)

Similar to the extension wrapper, but for the web UI client.

```typescript
// webview-ui/src/lib/encrypted-ws-client.ts
export class EncryptedWsClient {
  private wsClient: WsClient;
  private encryptionService: EncryptionService;
  
  constructor(wsClient: WsClient, encryptionService: EncryptionService) {
    this.wsClient = wsClient;
    this.encryptionService = encryptionService;
    this.setupEventHandlers();
  }
  
  // Wrap original methods
  public connect(): Promise<void> {...}
  public send(message: Omit<WsMessage, "id">): Promise<void> {...}
  public disconnect(): void {...}
  
  // Handle encryption/decryption
  private async encryptMessage(message: WsMessage): Promise<WsMessage> {...}
  private async decryptMessage(message: WsMessage): Promise<WsMessage> {...}
  
  // Event handling
  private setupEventHandlers(): void {...}
}
```

#### 4. Pairing Manager

This service will handle the pairing process between devices.

```typescript
// src/services/encryption/PairingManager.ts
export class PairingManager {
  private encryptionService: EncryptionService;
  private storage: PairingStorage;
  
  constructor(encryptionService: EncryptionService, storage: PairingStorage) {
    this.encryptionService = encryptionService;
    this.storage = storage;
  }
  
  // Pairing methods
  async initiatePairing(): Promise<string> {...}
  async completePairing(pairingData: PairingData): Promise<boolean> {...}
  async isPaired(): Promise<boolean> {...}
  
  // Storage methods
  async savePairingData(): Promise<void> {...}
  async loadPairingData(): Promise<PairingData | null> {...}
}
```

#### 5. Pairing Storage

This service will handle the persistent storage of pairing information.

```typescript
// src/services/encryption/PairingStorage.ts
export interface PairingData {
  deviceId: string;
  publicKey: JsonWebKey;
  timestamp: number;
}

export class PairingStorage {
  private context: vscode.ExtensionContext;
  
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }
  
  async savePairingData(deviceId: string, data: PairingData): Promise<void> {...}
  async loadPairingData(deviceId: string): Promise<PairingData | null> {...}
  async listPairedDevices(): Promise<string[]> {...}
  async removePairingData(deviceId: string): Promise<void> {...}
}
```

### Message Format

To maintain compatibility with the existing system while adding encryption:

```typescript
interface EncryptedData {
  iv: string;        // Initialization vector (Base64)
  data: string;      // Encrypted data (Base64)
  deviceId: string;  // Device identifier
}

interface EncryptedMessage extends WebSocketMessage {
  encrypted: boolean;
  encryptedPayload?: EncryptedData;
  // Original payload field remains for unencrypted messages
}
```

### Pairing Process

1. **Initial Setup**:
   - Both clients generate their own key pairs on first run
   - Extension stores its private key securely
   - Web UI stores its keys in localStorage

2. **Pairing Flow**:
   - Extension generates a 6-digit pairing code
   - User enters this code in the web UI
   - Web UI sends its public key to the extension with the pairing code
   - Extension verifies the code and derives a shared secret
   - Extension sends its public key to the web UI
   - Web UI derives the same shared secret
   - Both sides store the pairing information with the device ID

3. **Message Exchange**:
   - Sender encrypts the payload using the shared key
   - Receiver decrypts the payload using the shared key
   - Metadata remains unencrypted for routing

### Security Considerations

1. **Key Storage**:
   - Extension: Store keys in the extension's secure storage
   - Web UI: Store keys in localStorage with appropriate security measures

2. **Pairing Code**:
   - Short-lived (expires after use)
   - Rate-limited to prevent brute force attacks
   - Displayed only in the extension UI

3. **Device Management**:
   - Allow users to view and remove paired devices
   - Implement key rotation for long-term security

4. **Error Handling**:
   - Graceful degradation if encryption fails
   - Clear error messages for troubleshooting

## Implementation Plan

### Phase 1: Core Encryption Services

1. Implement `EncryptionService` with WebCrypto API
   - Key generation
   - Encryption/decryption
   - Pairing code generation

2. Implement `PairingStorage` for persistent storage
   - Extension side: Use vscode.ExtensionContext.globalState
   - Web UI side: Use localStorage with encryption

3. Implement `PairingManager` to handle the pairing process
   - Initiate pairing
   - Complete pairing
   - Verify pairing status

4. Add unit tests for encryption/decryption

### Phase 2: Client Wrappers

1. Implement `EncryptedWebSocketClient` for the extension
   - Wrap the existing WebSocketClient
   - Add encryption/decryption of payloads
   - Forward events from the underlying client

2. Implement `EncryptedWsClient` for the web UI
   - Wrap the existing WsClient
   - Add encryption/decryption of payloads
   - Forward events from the underlying client

3. Modify `WebSocketApiAdapter` to use the encrypted client
   - Update the constructor to initialize the encrypted client
   - Ensure all existing functionality works with the wrapper

4. Update the context providers to support encryption
   - Add encryption status to the context
   - Expose pairing methods to the UI

### Phase 3: UI Integration

1. Add pairing UI components to the web UI
   - Pairing dialog for entering the code
   - Encryption status indicator
   - Device management UI

2. Add encryption status indicators
   - Icon in the status bar
   - Text in the connection status area

3. Implement pairing code generation and verification
   - Display the code in the extension
   - Verify the code entered in the web UI

4. Add device management UI for viewing/removing paired devices
   - List of paired devices
   - Option to remove devices
   - Option to regenerate keys

### Phase 4: Testing and Refinement

1. Test the complete E2EE flow
   - Pairing process
   - Message encryption/decryption
   - Error handling

2. Ensure backward compatibility
   - Graceful degradation if encryption fails
   - Support for unpaired devices

3. Optimize performance
   - Minimize encryption overhead
   - Cache keys for better performance

4. Add error handling and recovery mechanisms
   - Clear error messages
   - Automatic recovery from errors

## Integration with Existing Code

### Extension Side

1. Modify `ClineProvider` to initialize the encryption service

   ```typescript
   // src/core/webview/ClineProvider.ts
   export class ClineProvider extends EventEmitter<ClineProviderEvents> implements vscode.WebviewViewProvider {
     // ...existing code...
     private encryptionService: EncryptionService;
     private pairingManager: PairingManager;
     
     constructor(readonly context: vscode.ExtensionContext, readonly outputChannel: vscode.OutputChannel) {
       super();
       // ...existing code...
       this.encryptionService = new EncryptionService();
       const pairingStorage = new PairingStorage(context);
       this.pairingManager = new PairingManager(this.encryptionService, pairingStorage);
     }
     
     // ...existing code...
   }
   ```

2. Update `WebSocketApiAdapter` to use the encrypted client

   ```typescript
   // src/services/websocket/api-adapter.ts
   export class WebSocketApiAdapter {
     // ...existing code...
     
     constructor(api: API, config: WebSocketConfig) {
       this.api = api;
       this.config = config;
       
       // Get the encryption service from the provider
       const encryptionService = api.getProvider()?.encryptionService;
       
       // Create the encrypted client
       const encryptedClient = new EncryptedWebSocketClient({
         serverUrl: config.serverUrl || "",
         provider: config.provider,
         reconnectInterval: config.reconnectInterval || 5000,
         maxRetries: config.maxRetries || 5,
         clientType: "extension",
         sessionId: config.sessionId,
       }, encryptionService);
       
       this.wsClient = encryptedClient;
       
       // ...existing code...
     }
     
     // ...existing code...
   }
   ```

3. Add UI for pairing and encryption status

   ```typescript
   // src/webview/components/PairingStatus.ts
   export function renderPairingStatus(provider: ClineProvider): vscode.WebviewViewProvider {
     // Render pairing status and controls in the extension UI
   }
   ```

### Web UI Side

1. Create an encryption context provider

   ```tsx
   // webview-ui/src/context/encryption-context.tsx
   import React, { createContext, useContext, useState, useEffect } from 'react';
   import { EncryptionService } from '../lib/encryption-service';
   
   interface EncryptionContextValue {
     encryptionService: EncryptionService;
     pairingStatus: 'unpaired' | 'pairing' | 'paired';
     initiatePairing: () => Promise<string>;
     completePairing: (code: string) => Promise<boolean>;
   }
   
   const EncryptionContext = createContext<EncryptionContextValue | null>(null);
   
   export function EncryptionProvider({ children }: { children: React.ReactNode }) {
     const [encryptionService] = useState(() => new EncryptionService());
     const [pairingStatus, setPairingStatus] = useState<'unpaired' | 'pairing' | 'paired'>('unpaired');
     
     // ...implementation...
     
     return (
       <EncryptionContext.Provider value={{
         encryptionService,
         pairingStatus,
         initiatePairing,
         completePairing,
       }}>
         {children}
       </EncryptionContext.Provider>
     );
   }
   
   export function useEncryption() {
     const context = useContext(EncryptionContext);
     if (!context) {
       throw new Error('useEncryption must be used within an EncryptionProvider');
     }
     return context;
   }
   ```

2. Wrap the existing `WsClient` with the encrypted client

   ```tsx
   // webview-ui/src/context/ws-context.tsx
   import { EncryptedWsClient } from '../lib/encrypted-ws-client';
   import { useEncryption } from './encryption-context';
   
   export const WsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
     const [client] = useState(() => new WsClient());
     const { encryptionService, pairingStatus } = useEncryption();
     const [encryptedClient, setEncryptedClient] = useState<EncryptedWsClient | null>(null);
     
     useEffect(() => {
       if (pairingStatus === 'paired') {
         setEncryptedClient(new EncryptedWsClient(client, encryptionService));
       } else {
         setEncryptedClient(null);
       }
     }, [client, encryptionService, pairingStatus]);
     
     // ...existing code...
     
     const sendCommand = async (command: Omit<WsMessage, "id">) => {
       if (status !== "connected") {
         throw new Error("Not connected to WebSocket server");
       }
       
       if (encryptedClient && pairingStatus === 'paired') {
         return encryptedClient.send(command);
       } else {
         return client.send(command);
       }
     };
     
     // ...existing code...
   }
   ```

3. Add UI components for pairing and encryption status

   ```tsx
   // webview-ui/src/components/encryption/PairingDialog.tsx
   import React, { useState } from 'react';
   import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField } from '@mui/material';
   import { useEncryption } from '../../context/encryption-context';
   
   export const PairingDialog: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
     const [pairingCode, setPairingCode] = useState('');
     const { completePairing } = useEncryption();
     
     const handleSubmit = async () => {
       const success = await completePairing(pairingCode);
       if (success) {
         onClose();
       }
     };
     
     return (
       <Dialog open={isOpen} onClose={onClose}>
         <DialogTitle>Pair with Extension</DialogTitle>
         <DialogContent>
           <TextField
             label="Pairing Code"
             value={pairingCode}
             onChange={(e) => setPairingCode(e.target.value)}
             fullWidth
           />
         </DialogContent>
         <DialogActions>
           <Button onClick={onClose}>Cancel</Button>
           <Button onClick={handleSubmit}>Pair</Button>
         </DialogActions>
       </Dialog>
     );
   }
   ```

## UI/UX Considerations

### Extension UI

1. **Pairing Code Display**:
   - Show the pairing code in a clear, easy-to-read format
   - Include instructions for entering the code in the web UI
   - Add a timer to indicate when the code expires

2. **Encryption Status**:
   - Add an icon to indicate encryption status
   - Show the number of paired devices
   - Provide a way to manage paired devices

3. **Error Handling**:
   - Show clear error messages if encryption fails
   - Provide troubleshooting steps
   - Allow for manual retry of failed operations

### Web UI

1. **Pairing Dialog**:
   - Clean, simple interface for entering the pairing code
   - Clear instructions
   - Visual feedback on success/failure

2. **Encryption Status**:
   - Add an icon to the navigation bar to indicate encryption status
   - Show a tooltip with more details on hover
   - Include a link to manage paired devices

3. **Device Management**:
   - List of paired devices with timestamps
   - Option to remove devices
   - Option to regenerate keys

4. **Error Handling**:
   - Show clear error messages if encryption fails
   - Provide an option to retry
   - Gracefully degrade to unencrypted communication if necessary

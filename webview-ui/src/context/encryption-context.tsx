import React, { createContext, useContext, useState, useEffect } from 'react';
import { EncryptionService, PairingStatus } from '../lib/encryption/encryption-service';
import { EncryptedWsClient } from '../lib/encryption/encrypted-ws-client';
import { WsClient } from '../lib/ws-client';
import { useWs } from './ws-context';

/**
 * Interface for encryption context
 */
interface EncryptionContextValue {
  encryptionService: EncryptionService;
  pairingStatus: PairingStatus;
  isPaired: boolean;
  deviceId: string;
  initiatePairing: () => Promise<void>;
  completePairing: (code: string) => Promise<boolean>;
  resetPairing: () => Promise<void>;
  getEncryptedClient: (wsClient: WsClient) => EncryptedWsClient;
}

/**
 * Create the encryption context
 */
const EncryptionContext = createContext<EncryptionContextValue | null>(null);

/**
 * Provider for encryption context
 */
export const EncryptionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { client: wsClient } = useWs();
  const [encryptionService] = useState(() => new EncryptionService());
  const [pairingStatus, setPairingStatus] = useState<PairingStatus>('unpaired');
  const [isPaired, setIsPaired] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [encryptedClients] = useState<Map<WsClient, EncryptedWsClient>>(new Map());
  
  // Initialize the encryption service
  useEffect(() => {
    const initialize = async () => {
      // Get the device ID
      setDeviceId(encryptionService.getDeviceId());
      
      // Get the pairing status
      const status = encryptionService.getPairingStatus();
      setPairingStatus(status);
      setIsPaired(status === 'paired');
    };
    
    initialize();
  }, [encryptionService]);
  
  /**
   * Initiate pairing with the extension
   */
  const initiatePairing = async (): Promise<void> => {
    try {
      // Send the initiate pairing message through WebSocket
      wsClient.send({
        type: 'initiatePairing',
        payload: {
          deviceId: encryptionService.getDeviceId()
        }
      });
    } catch (error) {
      console.error('Error initiating pairing:', error);
    }
  };
  
  /**
   * Complete pairing with the extension
   * @param code The pairing code
   * @returns Whether pairing was successful
   */
  const completePairing = async (code: string): Promise<boolean> => {
    try {
      // Export the public key
      const publicKeyJwk = await encryptionService.exportPublicKey();
      const publicKeyPem = await encryptionService.exportPublicKeyAsPem();
      
      // Send the request through WebSocket
      wsClient.send({
        type: 'requestPublicKey',
        payload: {
          pairingCode: code,
          deviceId: encryptionService.getDeviceId(),
          publicKey: publicKeyPem
        }
      });
      
      // This will be handled asynchronously when the extension responds
      // For now, return true to indicate the request was sent
      return true;
    } catch (error) {
      console.error('Error completing pairing:', error);
      return false;
    }
  };
  
  /**
   * Reset the pairing
   */
  const resetPairing = async (): Promise<void> => {
    await encryptionService.resetPairing();
    setPairingStatus('unpaired');
    setIsPaired(false);
    
    // Notify the extension through WebSocket
    wsClient.send({
      type: 'resetPairing',
      payload: {
        deviceId: encryptionService.getDeviceId()
      }
    });
  };
  
  /**
   * Get or create an encrypted client for a WebSocket client
   * @param wsClient The WebSocket client
   * @returns The encrypted client
   */
  const getEncryptedClient = (wsClient: WsClient): EncryptedWsClient => {
    // Check if we already have an encrypted client for this WebSocket client
    if (encryptedClients.has(wsClient)) {
      return encryptedClients.get(wsClient)!;
    }
    
    // Create a new encrypted client
    const encryptedClient = new EncryptedWsClient(wsClient, encryptionService);
    encryptedClients.set(wsClient, encryptedClient);
    return encryptedClient;
  };
  // Listen for messages from the WebSocket server
  useEffect(() => {
    const handleWebSocketMessage = async (event: CustomEvent) => {
      const message = event.detail; // Assuming message data is in event.detail
      
      if (!message || !message.type) return;

      // Handle encryption status updates
      if (message.type === 'encryptionStatus') {
        if (message.bool) {
          setPairingStatus('paired');
          setIsPaired(true);
        } else {
          setPairingStatus('unpaired');
          setIsPaired(false);
        }
      }
      
      // Handle pairing-related messages
      if (message.type === 'publicKey') {
        try {
          // Import the extension's public key
          const extensionPublicKey = await encryptionService.importPublicKeyFromPem(message.publicKey);
          
          // Derive the shared key
          await encryptionService.deriveSharedKey(extensionPublicKey);
          
          setPairingStatus('paired');
          setIsPaired(true);
          
          // Notify the extension that pairing is complete
          wsClient.send({
            type: 'pairingComplete',
            payload: {
              deviceId: encryptionService.getDeviceId(),
              publicKey: await encryptionService.exportPublicKeyAsPem() // Send our key back for confirmation
            }
          });
        } catch (error) {
          console.error('Error processing public key and completing pairing:', error);
          // Optionally reset pairing status or show error to user
          setPairingStatus('unpaired');
          setIsPaired(false);
        }
      } else if (message.type === 'pairingReset') {
        // Reset the pairing if notified by the extension
        await encryptionService.resetPairing();
        setPairingStatus('unpaired');
        setIsPaired(false);
      }
      // Note: 'pairingCode' message is no longer sent to the webview
    };

    // Add listener to the wsClient
    wsClient.on('message', handleWebSocketMessage);

    // Cleanup listener on unmount
    return () => {
      wsClient.off('message', handleWebSocketMessage);
    };
  }, [encryptionService, wsClient]); // Add wsClient as dependency
  return (
    <EncryptionContext.Provider
      value={{
        encryptionService,
        pairingStatus,
        isPaired,
        deviceId,
        initiatePairing,
        completePairing,
        resetPairing,
        getEncryptedClient,
      }}
    >
      {children}
    </EncryptionContext.Provider>
  );
};

/**
 * Hook for using the encryption context
 */
export const useEncryption = (): EncryptionContextValue => {
  const context = useContext(EncryptionContext);
  if (!context) {
    throw new Error('useEncryption must be used within an EncryptionProvider');
  }
  return context;
};
import { WsClient } from '../ws-client';
import { EncryptionService, EncryptedData } from './encryption-service';

/**
 * Interface for WebSocket message
 */
interface WsMessage {
  id: string;
  type: string;
  action?: string;
  payload?: unknown;
  encrypted?: boolean;
  encryptedPayload?: EncryptedData;
}

/**
 * Wrapper for WsClient that adds encryption
 */
export class EncryptedWsClient {
  private wsClient: WsClient;
  private encryptionService: EncryptionService;
  private isPaired: boolean = false;
  private eventTarget = new EventTarget();
  
  /**
   * Constructor
   * @param wsClient The WebSocket client
   * @param encryptionService The encryption service
   */
  constructor(wsClient: WsClient, encryptionService: EncryptionService) {
    this.wsClient = wsClient;
    this.encryptionService = encryptionService;
    this.setupEventHandlers();
    
    // Check if we're paired
    this.isPaired = this.encryptionService.getPairingStatus() === 'paired';
  }
  
  /**
   * Set up event handlers for the WebSocket client
   */
  private setupEventHandlers(): void {
    // Listen for messages from the WebSocket
    window.addEventListener('message', async (event) => {
      try {
        // Check if the message is encrypted
        const message = event.data;
        if (message && message.encrypted && message.encryptedPayload) {
          // Only decrypt if we're paired
          if (this.isPaired) {
            try {
              // Decrypt the payload
              const decryptedPayload = await this.encryptionService.decrypt(message.encryptedPayload);
              
              // Create a new message with the decrypted payload
              const decryptedMessage = {
                ...message,
                payload: decryptedPayload,
                encrypted: undefined,
                encryptedPayload: undefined
              };
              
              // Dispatch the decrypted message
              const customEvent = new MessageEvent('message', {
                data: decryptedMessage
              });
              window.dispatchEvent(customEvent);
              
              // Don't propagate the original message
              event.stopPropagation();
            } catch (error) {
              console.error('Error decrypting message:', error);
              // Let the original message propagate
            }
          }
        }
      } catch (error) {
        console.error('Error handling message:', error);
        // Let the original message propagate
      }
    }, true); // Use capture to intercept before other handlers
  }
  
  /**
   * Connect to the WebSocket server
   * @returns A promise that resolves when connected
   */
  public connect(): Promise<void> {
    return this.wsClient.connect();
  }
  
  /**
   * Send a message to the WebSocket server
   * @param message The message to send
   * @returns A promise that resolves when the message is sent
   */
  public async send(message: Omit<WsMessage, "id">): Promise<void> {
    // Check if we're paired and should encrypt
    if (this.isPaired && message.payload) {
      try {
        // Encrypt the payload
        const encryptedPayload = await this.encryptionService.encrypt(message.payload);
        
        // Create a new message with the encrypted payload
        const encryptedMessage = {
          ...message,
          encrypted: true,
          encryptedPayload,
          payload: undefined // Remove the original payload
        };
        
        // Send the encrypted message
        return this.wsClient.send(encryptedMessage);
      } catch (error) {
        console.error('Error encrypting message:', error);
        // Fall back to sending the original message
        return this.wsClient.send(message);
      }
    } else {
      // Send the original message
      return this.wsClient.send(message);
    }
  }
  
  /**
   * Disconnect from the WebSocket server
   */
  public disconnect(): void {
    this.wsClient.disconnect();
  }
  
  /**
   * Update the pairing status
   * @param isPaired Whether we're paired
   */
  public updatePairingStatus(isPaired: boolean): void {
    this.isPaired = isPaired;
  }
  
  /**
   * Get the underlying WebSocket client
   * @returns The WebSocket client
   */
  public getWsClient(): WsClient {
    return this.wsClient;
  }
  
  /**
   * Add an event listener
   * @param event The event to listen for
   * @param listener The listener function
   */
  public on(event: string, listener: EventListener): void {
    this.eventTarget.addEventListener(event, listener);
  }
  
  /**
   * Remove an event listener
   * @param event The event to stop listening for
   * @param listener The listener function
   */
  public off(event: string, listener: EventListener): void {
    this.eventTarget.removeEventListener(event, listener);
  }
  
  /**
   * Emit an event
   * @param event The event to emit
   * @param detail The event detail
   */
  private emit(event: string, detail?: unknown): void {
    this.eventTarget.dispatchEvent(new CustomEvent(event, { detail }));
  }
}
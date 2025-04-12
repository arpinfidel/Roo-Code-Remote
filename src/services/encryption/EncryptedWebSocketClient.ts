import { EventEmitter } from 'events';
import { WebSocketClient } from '../websocket/client';
import { WebSocketConfig, WebSocketMessage } from '../websocket/types';
import { EncryptionService, EncryptedData } from './EncryptionService';

/**
 * Interface for encrypted message
 */
interface EncryptedMessage extends WebSocketMessage {
  encrypted: boolean;
  encryptedPayload?: EncryptedData;
}

/**
 * Wrapper for WebSocketClient that adds encryption
 */
export class EncryptedWebSocketClient extends EventEmitter {
  private wsClient: WebSocketClient;
  private encryptionService: EncryptionService;
  private isPaired: boolean = false;
  
  /**
   * Constructor
   * @param config The WebSocket configuration
   * @param encryptionService The encryption service
   */
  constructor(config: WebSocketConfig, encryptionService: EncryptionService) {
    super();
    this.wsClient = new WebSocketClient(config);
    this.encryptionService = encryptionService;
    this.setupEventHandlers();
    
    // Check if we're paired
    this.isPaired = this.encryptionService.getPairingStatus() === 'paired';
  }
  
  /**
   * Set up event handlers for the WebSocket client
   */
  private setupEventHandlers(): void {
    // Forward all events from the WebSocket client
    this.wsClient.on('connecting', () => this.emit('connecting'));
    this.wsClient.on('connected', () => this.emit('connected'));
    this.wsClient.on('disconnected', () => this.emit('disconnected'));
    this.wsClient.on('error', (err) => this.emit('error', err));
    
    // Handle incoming messages
    this.wsClient.on('message', async (message: WebSocketMessage) => {
      try {
        // Check if the message is encrypted
        const encryptedMessage = message as EncryptedMessage;
        if (encryptedMessage.encrypted && encryptedMessage.encryptedPayload) {
          // Only decrypt if we're paired
          if (this.isPaired) {
            try {
              // Decrypt the payload
              const decryptedPayload = this.encryptionService.decrypt(encryptedMessage.encryptedPayload);
              
              // Create a new message with the decrypted payload
              const decryptedMessage: WebSocketMessage = {
                ...message,
                payload: decryptedPayload
              };
              
              // Emit the decrypted message
              this.emit('message', decryptedMessage);
            } catch (error) {
              console.error('Error decrypting message:', error);
              // Forward the original message if decryption fails
              this.emit('message', message);
            }
          } else {
            // Forward the original message if we're not paired
            this.emit('message', message);
          }
        } else {
          // Forward unencrypted messages
          this.emit('message', message);
        }
      } catch (error) {
        console.error('Error handling message:', error);
        // Forward the original message if there's an error
        this.emit('message', message);
      }
    });
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
  public async send(message: WebSocketMessage): Promise<void> {
    // Check if we're paired and should encrypt
    if (this.isPaired && message.payload) {
      try {
        // Encrypt the payload
        const encryptedPayload = this.encryptionService.encrypt(message.payload);
        
        // Create a new message with the encrypted payload
        const encryptedMessage: EncryptedMessage = {
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
  public getWebSocketClient(): WebSocketClient {
    return this.wsClient;
  }
}
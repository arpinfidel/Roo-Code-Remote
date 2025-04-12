import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for encrypted data
 */
export interface EncryptedData {
  iv: string;        // Base64 encoded initialization vector
  data: string;      // Base64 encoded encrypted data
  deviceId: string;  // Device identifier
}

/**
 * Pairing status enum
 */
export type PairingStatus = 'unpaired' | 'pairing' | 'paired';

/**
 * Service for handling encryption, decryption, and pairing in the browser
 */
export class EncryptionService {
  private keyPair: CryptoKeyPair | null = null;
  private sharedKey: CryptoKey | null = null;
  private deviceId: string;
  private pairingStatus: PairingStatus = 'unpaired';
  
  /**
   * Constructor
   * @param deviceId Optional device ID, will generate one if not provided
   */
  constructor(deviceId?: string) {
    this.deviceId = deviceId || this.loadDeviceId() || uuidv4();
    this.saveDeviceId(this.deviceId);
    this.initialize();
  }
  
  /**
   * Initialize the encryption service
   */
  private async initialize(): Promise<void> {
    try {
      // Try to load existing key pair
      const keyPair = await this.loadKeyPair();
      if (keyPair) {
        this.keyPair = keyPair;
        
        // Check if we have a shared key
        const sharedKey = await this.loadSharedKey();
        if (sharedKey) {
          this.sharedKey = sharedKey;
          this.pairingStatus = 'paired';
        }
      } else {
        // Generate a new key pair
        await this.generateKeyPair();
      }
    } catch (error) {
      console.error('Error initializing encryption service:', error);
    }
  }
  
  /**
   * Generate a new key pair
   * @returns The generated key pair
   */
  public async generateKeyPair(): Promise<CryptoKeyPair> {
    this.keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey']
    );
    
    // Save the key pair
    await this.saveKeyPair(this.keyPair);
    
    return this.keyPair;
  }
  
  /**
   * Export the public key
   * @returns The public key as a JWK
   */
  public async exportPublicKey(): Promise<JsonWebKey> {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    
    return window.crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
  }
  
  /**
   * Export the public key as PEM
   * @returns The public key in PEM format
   */
  public async exportPublicKeyAsPem(): Promise<string> {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    
    // Export the public key as raw
    const rawKey = await window.crypto.subtle.exportKey('raw', this.keyPair.publicKey);
    
    // Convert to base64
    const base64Key = this.arrayBufferToBase64(rawKey);
    
    // Format as PEM
    return `-----BEGIN PUBLIC KEY-----\n${this.formatPem(base64Key)}\n-----END PUBLIC KEY-----`;
  }
  
  /**
   * Import a public key from PEM format
   * @param pem The public key in PEM format
   * @returns The imported public key
   */
  public async importPublicKeyFromPem(pem: string): Promise<CryptoKey> {
    // Remove PEM header and footer
    const base64 = pem
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s/g, '');
    
    // Convert to ArrayBuffer
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Import the key
    return window.crypto.subtle.importKey(
      'spki',
      bytes.buffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      []
    );
  }
  
  /**
   * Derive a shared key from a public key
   * @param publicKey The public key to derive the shared key from
   */
  public async deriveSharedKey(publicKey: CryptoKey): Promise<void> {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    
    this.sharedKey = await window.crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: publicKey,
      },
      this.keyPair.privateKey,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt', 'decrypt']
    );
    
    // Save the shared key
    await this.saveSharedKey(this.sharedKey);
    
    this.pairingStatus = 'paired';
  }
  
  /**
   * Encrypt data
   * @param data The data to encrypt
   * @returns The encrypted data
   */
  public async encrypt(data: any): Promise<EncryptedData> {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived');
    }
    
    // Generate a random IV
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    // Encode the data
    const encodedData = new TextEncoder().encode(JSON.stringify(data));
    
    // Encrypt the data
    const encryptedData = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      this.sharedKey,
      encodedData
    );
    
    return {
      iv: this.arrayBufferToBase64(iv.buffer),
      data: this.arrayBufferToBase64(encryptedData),
      deviceId: this.deviceId,
    };
  }
  
  /**
   * Decrypt data
   * @param encryptedData The encrypted data
   * @returns The decrypted data
   */
  public async decrypt(encryptedData: EncryptedData): Promise<any> {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived');
    }
    
    // Decode the base64 strings
    const iv = this.base64ToArrayBuffer(encryptedData.iv);
    const data = this.base64ToArrayBuffer(encryptedData.data);
    
    // Decrypt the data
    const decryptedData = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(iv),
      },
      this.sharedKey,
      data
    );
    
    // Decode the data
    const decodedData = new TextDecoder().decode(decryptedData);
    
    // Parse the JSON
    return JSON.parse(decodedData);
  }
  
  /**
   * Complete pairing with a code and public key
   * @param pairingCode The pairing code
   * @param publicKeyPem The public key in PEM format
   * @returns Whether pairing was successful
   */
  public async completePairing(pairingCode: string, publicKeyPem: string): Promise<boolean> {
    try {
      // Import the public key
      const publicKey = await this.importPublicKeyFromPem(publicKeyPem);
      
      // Derive the shared key
      await this.deriveSharedKey(publicKey);
      
      return true;
    } catch (error) {
      console.error('Error completing pairing:', error);
      return false;
    }
  }
  
  /**
   * Get the pairing status
   * @returns The current pairing status
   */
  public getPairingStatus(): PairingStatus {
    return this.pairingStatus;
  }
  
  /**
   * Get the device ID
   * @returns The device ID
   */
  public getDeviceId(): string {
    return this.deviceId;
  }
  
  /**
   * Reset the pairing
   */
  public async resetPairing(): Promise<void> {
    this.pairingStatus = 'unpaired';
    this.sharedKey = null;
    
    // Clear the shared key from storage
    localStorage.removeItem('e2ee.sharedKey');
  }
  
  /**
   * Save the key pair to localStorage
   * @param keyPair The key pair to save
   */
  private async saveKeyPair(keyPair: CryptoKeyPair): Promise<void> {
    try {
      // Export the keys
      const publicKey = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const privateKey = await window.crypto.subtle.exportKey('jwk', keyPair.privateKey);
      
      // Save to localStorage
      localStorage.setItem('e2ee.publicKey', JSON.stringify(publicKey));
      localStorage.setItem('e2ee.privateKey', JSON.stringify(privateKey));
    } catch (error) {
      console.error('Error saving key pair:', error);
    }
  }
  
  /**
   * Load the key pair from localStorage
   * @returns The loaded key pair, or null if not found
   */
  private async loadKeyPair(): Promise<CryptoKeyPair | null> {
    try {
      // Load from localStorage
      const publicKeyJson = localStorage.getItem('e2ee.publicKey');
      const privateKeyJson = localStorage.getItem('e2ee.privateKey');
      
      if (!publicKeyJson || !privateKeyJson) {
        return null;
      }
      
      // Parse the keys
      const publicKeyJwk = JSON.parse(publicKeyJson);
      const privateKeyJwk = JSON.parse(privateKeyJson);
      
      // Import the keys
      const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        publicKeyJwk,
        {
          name: 'ECDH',
          namedCurve: 'P-256',
        },
        true,
        []
      );
      
      const privateKey = await window.crypto.subtle.importKey(
        'jwk',
        privateKeyJwk,
        {
          name: 'ECDH',
          namedCurve: 'P-256',
        },
        true,
        ['deriveKey']
      );
      
      return { publicKey, privateKey };
    } catch (error) {
      console.error('Error loading key pair:', error);
      return null;
    }
  }
  
  /**
   * Save the shared key to localStorage
   * @param sharedKey The shared key to save
   */
  private async saveSharedKey(sharedKey: CryptoKey): Promise<void> {
    try {
      // We can't export the shared key directly, so we'll save a flag
      localStorage.setItem('e2ee.hasSharedKey', 'true');
    } catch (error) {
      console.error('Error saving shared key:', error);
    }
  }
  
  /**
   * Load the shared key from localStorage
   * @returns The loaded shared key, or null if not found
   */
  private async loadSharedKey(): Promise<CryptoKey | null> {
    try {
      // Check if we have a shared key
      const hasSharedKey = localStorage.getItem('e2ee.hasSharedKey') === 'true';
      
      if (!hasSharedKey || !this.keyPair) {
        return null;
      }
      
      // We can't actually load the shared key, so we'll return null
      // The shared key will need to be re-derived
      return null;
    } catch (error) {
      console.error('Error loading shared key:', error);
      return null;
    }
  }
  
  /**
   * Save the device ID to localStorage
   * @param deviceId The device ID to save
   */
  private saveDeviceId(deviceId: string): void {
    localStorage.setItem('e2ee.deviceId', deviceId);
  }
  
  /**
   * Load the device ID from localStorage
   * @returns The loaded device ID, or null if not found
   */
  private loadDeviceId(): string | null {
    return localStorage.getItem('e2ee.deviceId');
  }
  
  /**
   * Convert an ArrayBuffer to a Base64 string
   * @param buffer The ArrayBuffer to convert
   * @returns The Base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  
  /**
   * Convert a Base64 string to an ArrayBuffer
   * @param base64 The Base64 string to convert
   * @returns The ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
  
  /**
   * Format a Base64 string as PEM
   * @param base64 The Base64 string to format
   * @returns The formatted string
   */
  private formatPem(base64: string): string {
    let formatted = '';
    for (let i = 0; i < base64.length; i += 64) {
      formatted += base64.slice(i, i + 64) + '\n';
    }
    return formatted.trim();
  }
}
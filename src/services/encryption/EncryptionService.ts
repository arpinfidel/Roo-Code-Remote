import * as crypto from 'crypto';
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
 * Service for handling encryption, decryption, and pairing
 */
export class EncryptionService {
  private keyPair: { publicKey: string; privateKey: string } | null = null;
  private sharedKey: Buffer | null = null;
  private deviceId: string;
  private pairingCode: string | null = null;
  private pairingStatus: PairingStatus = 'unpaired';
  private pairingTimeout: NodeJS.Timeout | null = null;
  
  /**
   * Constructor
   * @param deviceId Optional device ID, will generate one if not provided
   */
  constructor(deviceId?: string) {
    this.deviceId = deviceId || uuidv4();
  }
  
  /**
   * Generate a new key pair
   * @returns The generated key pair
   */
  public generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
    
    this.keyPair = { publicKey, privateKey };
    return this.keyPair;
  }
  
  /**
   * Get the public key
   * @returns The public key in PEM format
   */
  public getPublicKey(): string {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    return this.keyPair.publicKey;
  }
  
  /**
   * Derive a shared key from a public key
   * @param publicKey The public key to derive the shared key from
   */
  public deriveSharedKey(publicKey: string): void {
    if (!this.keyPair) {
      throw new Error('Key pair not generated');
    }
    
    const privateKeyObj = crypto.createPrivateKey(this.keyPair.privateKey);
    const publicKeyObj = crypto.createPublicKey(publicKey);
    
    // Derive shared secret using ECDH
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateKeyObj.export({ type: 'pkcs8', format: 'der' }).slice(36));
    
    // Get the public key in the right format
    const publicKeyDer = publicKeyObj.export({ type: 'spki', format: 'der' });
    const publicKeyUncompressed = Buffer.concat([
      Buffer.from([0x04]), // Uncompressed point format
      publicKeyDer.slice(-64) // Last 64 bytes are the x and y coordinates
    ]);
    
    // Compute the shared secret
    const sharedSecret = ecdh.computeSecret(publicKeyUncompressed);
    
    // Derive a key using HKDF
    this.sharedKey = crypto.createHash('sha256').update(sharedSecret).digest();
    
    this.pairingStatus = 'paired';
  }
  
  /**
   * Encrypt data
   * @param data The data to encrypt
   * @returns The encrypted data
   */
  public encrypt(data: any): EncryptedData {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived');
    }
    
    // Generate a random IV
    const iv = crypto.randomBytes(16);
    
    // Create cipher
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sharedKey, iv);
    
    // Encrypt the data
    const jsonData = JSON.stringify(data);
    const encrypted = Buffer.concat([
      cipher.update(jsonData, 'utf8'),
      cipher.final()
    ]);
    
    // Get the auth tag
    const authTag = cipher.getAuthTag();
    
    // Combine encrypted data and auth tag
    const encryptedWithTag = Buffer.concat([encrypted, authTag]);
    
    return {
      iv: iv.toString('base64'),
      data: encryptedWithTag.toString('base64'),
      deviceId: this.deviceId
    };
  }
  
  /**
   * Decrypt data
   * @param encryptedData The encrypted data
   * @returns The decrypted data
   */
  public decrypt(encryptedData: EncryptedData): any {
    if (!this.sharedKey) {
      throw new Error('Shared key not derived');
    }
    
    // Decode the base64 strings
    const iv = Buffer.from(encryptedData.iv, 'base64');
    const encryptedBuffer = Buffer.from(encryptedData.data, 'base64');
    
    // Split the encrypted data and auth tag
    const authTagLength = 16; // GCM auth tag is 16 bytes
    const encryptedDataLength = encryptedBuffer.length - authTagLength;
    const encrypted = encryptedBuffer.slice(0, encryptedDataLength);
    const authTag = encryptedBuffer.slice(encryptedDataLength);
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.sharedKey, iv);
    decipher.setAuthTag(authTag);
    
    // Decrypt the data
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    // Parse the JSON
    return JSON.parse(decrypted.toString('utf8'));
  }
  
  /**
   * Generate a pairing code
   * @returns The generated pairing code
   */
  public generatePairingCode(): string {
    // Generate a 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    this.pairingCode = code;
    this.pairingStatus = 'pairing';
    
    // Set a timeout to expire the code after 5 minutes
    if (this.pairingTimeout) {
      clearTimeout(this.pairingTimeout);
    }
    
    this.pairingTimeout = setTimeout(() => {
      if (this.pairingStatus === 'pairing') {
        this.pairingStatus = 'unpaired';
        this.pairingCode = null;
      }
    }, 5 * 60 * 1000);
    
    return code;
  }
  
  /**
   * Verify a pairing code
   * @param code The code to verify
   * @returns Whether the code is valid
   */
  public verifyPairingCode(code: string): boolean {
    return this.pairingCode === code;
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
   * Set the key pair
   * @param keyPair The key pair to set
   */
  public setKeyPair(keyPair: { publicKey: string; privateKey: string }): void {
    this.keyPair = keyPair;
  }
  
  /**
   * Reset the pairing
   */
  public resetPairing(): void {
    this.pairingStatus = 'unpaired';
    this.pairingCode = null;
    this.sharedKey = null;
    if (this.pairingTimeout) {
      clearTimeout(this.pairingTimeout);
      this.pairingTimeout = null;
    }
  }
}
import * as vscode from 'vscode';
import { EncryptionService, PairingStatus } from './EncryptionService';
import { PairingStorage, PairingData } from './PairingStorage';

/**
 * Manager for handling device pairing
 */
export class PairingManager {
  private encryptionService: EncryptionService;
  public storage: PairingStorage;
  
  /**
   * Constructor
   * @param encryptionService The encryption service
   * @param storage The pairing storage
   */
  constructor(encryptionService: EncryptionService, storage: PairingStorage) {
    this.encryptionService = encryptionService;
    this.storage = storage;
    this.initialize();
  }
  
  /**
   * Initialize the pairing manager
   */
  private async initialize(): Promise<void> {
    // Load or generate key pair
    const keyPair = this.storage.loadKeyPair();
    if (keyPair) {
      this.encryptionService.setKeyPair(keyPair);
    } else {
      const newKeyPair = this.encryptionService.generateKeyPair();
      await this.storage.saveKeyPair(newKeyPair);
    }
  }
  
  /**
   * Initiate pairing with a new device
   * @returns The pairing code
   */
  public initiatePairing(): string {
    return this.encryptionService.generatePairingCode();
  }
  
  /**
   * Complete pairing with a device
   * @param deviceId The device ID
   * @param publicKey The device's public key
   * @param pairingCode The pairing code
   * @param deviceName Optional device name
   * @returns Whether pairing was successful
   */
  public async completePairing(
    deviceId: string,
    publicKey: string,
    pairingCode: string,
    deviceName?: string
  ): Promise<boolean> {
    // Verify the pairing code
    if (!this.encryptionService.verifyPairingCode(pairingCode)) {
      return false;
    }
    
    try {
      // Derive the shared key
      this.encryptionService.deriveSharedKey(publicKey);
      
      // Save the pairing data
      const pairingData: PairingData = {
        deviceId,
        publicKey,
        timestamp: Date.now(),
        name: deviceName
      };
      
      await this.storage.savePairingData(deviceId, pairingData);
      return true;
    } catch (error) {
      console.error('Error completing pairing:', error);
      return false;
     }
    }
    
    /**
     * Finalize pairing after client confirmation
     * @param deviceId The device ID
     * @param clientPublicKey The client's public key
     */
    public async finalizePairing(deviceId: string, clientPublicKey: string): Promise<void> {
     const existingPairingData = this.storage.loadPairingData(deviceId);
     if (existingPairingData) {
      const updatedPairingData: PairingData = {
      	...existingPairingData,
      	publicKey: clientPublicKey, // Store client's key
      	timestamp: Date.now() // Update timestamp
      };
      await this.storage.savePairingData(deviceId, updatedPairingData);
     } else {
      console.error(`Attempted to finalize pairing for unknown deviceId: ${deviceId}`);
     }
    }
  
  /**
   * Check if a device is paired
   * @param deviceId The device ID
   * @returns Whether the device is paired
   */
  public isDevicePaired(deviceId: string): boolean {
    return this.storage.loadPairingData(deviceId) !== null;
  }
  
  /**
   * Get all paired devices
   * @returns A map of device IDs to pairing data
   */
  public getPairedDevices(): Record<string, PairingData> {
    return this.storage.getPairedDevices();
  }
  
  /**
   * Remove a paired device
   * @param deviceId The device ID
   */
  public async removePairedDevice(deviceId: string): Promise<void> {
    await this.storage.removePairingData(deviceId);
  }
  
  /**
   * Get the current pairing status
   * @returns The pairing status
   */
  public getPairingStatus(): PairingStatus {
    return this.encryptionService.getPairingStatus();
  }
  
  /**
   * Reset all pairings
   */
  public async resetAllPairings(): Promise<void> {
    await this.storage.clearAllPairingData();
    this.encryptionService.resetPairing();
  }
  
  /**
   * Establish a connection with a paired device
   * @param deviceId The device ID
   * @returns Whether the connection was established
   */
  public async connectWithDevice(deviceId: string): Promise<boolean> {
    const pairingData = this.storage.loadPairingData(deviceId);
    if (!pairingData) {
      return false;
    }
    
    try {
      this.encryptionService.deriveSharedKey(pairingData.publicKey);
      return true;
    } catch (error) {
      console.error('Error connecting with device:', error);
      return false;
    }
  }
}
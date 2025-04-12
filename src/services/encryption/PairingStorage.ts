import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface for pairing data
 */
export interface PairingData {
  deviceId: string;
  publicKey: string;
  timestamp: number;
  name?: string;
}

/**
 * Storage for pairing data
 */
export class PairingStorage {
  private context: vscode.ExtensionContext;
  private readonly PAIRED_DEVICES_KEY = 'e2ee.pairedDevices';
  private readonly KEY_PAIR_KEY = 'e2ee.keyPair';
  
  /**
   * Constructor
   * @param context The extension context
   */
  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }
  
  /**
   * Save pairing data for a device
   * @param deviceId The device ID
   * @param data The pairing data
   */
  public async savePairingData(deviceId: string, data: PairingData): Promise<void> {
    const pairedDevices = this.getPairedDevices();
    pairedDevices[deviceId] = data;
    await this.context.globalState.update(this.PAIRED_DEVICES_KEY, pairedDevices);
  }
  
  /**
   * Load pairing data for a device
   * @param deviceId The device ID
   * @returns The pairing data, or null if not found
   */
  public loadPairingData(deviceId: string): PairingData | null {
    const pairedDevices = this.getPairedDevices();
    return pairedDevices[deviceId] || null;
  }
  
  /**
   * List all paired devices
   * @returns An array of device IDs
   */
  public listPairedDevices(): string[] {
    const pairedDevices = this.getPairedDevices();
    return Object.keys(pairedDevices);
  }
  
  /**
   * Get all paired devices
   * @returns A map of device IDs to pairing data
   */
  public getPairedDevices(): Record<string, PairingData> {
    return this.context.globalState.get<Record<string, PairingData>>(this.PAIRED_DEVICES_KEY) || {};
  }
  
  /**
   * Remove pairing data for a device
   * @param deviceId The device ID
   */
  public async removePairingData(deviceId: string): Promise<void> {
    const pairedDevices = this.getPairedDevices();
    delete pairedDevices[deviceId];
    await this.context.globalState.update(this.PAIRED_DEVICES_KEY, pairedDevices);
  }
  
  /**
   * Save the key pair
   * @param keyPair The key pair to save
   */
  public async saveKeyPair(keyPair: { publicKey: string; privateKey: string }): Promise<void> {
    await this.context.globalState.update(this.KEY_PAIR_KEY, keyPair);
  }
  
  /**
   * Load the key pair
   * @returns The key pair, or null if not found
   */
  public loadKeyPair(): { publicKey: string; privateKey: string } | null {
    return this.context.globalState.get<{ publicKey: string; privateKey: string }>(this.KEY_PAIR_KEY) || null;
  }
  
  /**
   * Clear all pairing data
   */
  public async clearAllPairingData(): Promise<void> {
    await this.context.globalState.update(this.PAIRED_DEVICES_KEY, {});
  }
}
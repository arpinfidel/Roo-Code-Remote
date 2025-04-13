// src/utils/base64.ts

// Simple Buffer-based Base64 conversion for Node.js environment (VSCode Extension)

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    return Buffer.from(buffer).toString('base64');
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const buffer = Buffer.from(base64, 'base64');
    // Create a new ArrayBuffer from the Buffer's underlying ArrayBuffer segment
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
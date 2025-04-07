interface KeyPair {
    publicKey: JsonWebKey;
    privateKey: JsonWebKey;
    keyId: string;
}

interface SharedKey {
    key: JsonWebKey;
    keyId: string;
    pairedClientId: string;
}

const KEY_STORAGE_KEY = "roo-e2ee-keys";

export class E2EECrypto {
    private currentKeyId?: string;

    private pairingCode?: string;

    constructor() {
        // Initialize any required state
    }

    async generatePairingCode(): Promise<string> {
        // Generate random 6-digit code
        this.pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
        return this.pairingCode;
    }

    async generateKeyPair(): Promise<KeyPair> {
        const keyPair = await window.crypto.subtle.generateKey(
            {
                name: "ECDH",
                namedCurve: "P-256",
            },
            true,
            ["deriveKey"]
        );

        const publicKey = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
        const privateKey = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);
        const keyId = window.crypto.randomUUID();

        this.currentKeyId = keyId;
        return { publicKey, privateKey, keyId };
    }

    async deriveSharedKey(peerPublicKey: JsonWebKey, keyPair: KeyPair, peerClientId: string): Promise<SharedKey> {
        try {
            const publicKey = await window.crypto.subtle.importKey(
                "jwk",
                peerPublicKey,
                { name: "ECDH", namedCurve: "P-256" },
                true,
                []
            );

            const privateKey = await window.crypto.subtle.importKey(
                "jwk",
                keyPair.privateKey,
                { name: "ECDH", namedCurve: "P-256" },
                true,
                ["deriveKey"]
            );

            const sharedKey = await window.crypto.subtle.deriveKey(
                {
                    name: "ECDH",
                    public: publicKey,
                },
                privateKey,
                {
                    name: "AES-GCM",
                    length: 256,
                },
                true,
                ["encrypt", "decrypt"]
            );

            const sharedKeyJwk = await window.crypto.subtle.exportKey("jwk", sharedKey);
            return {
                key: sharedKeyJwk,
                keyId: keyPair.keyId,
                pairedClientId: peerClientId
            };
        } catch (err) {
            console.error("Failed to derive shared key:", err);
            throw new Error("Key derivation failed");
        }
    }

    async encryptMessage(message: any, key: JsonWebKey): Promise<any> {
        if (!message.payload) return message;

        const importedKey = await window.crypto.subtle.importKey(
            "jwk",
            key,
            { name: "AES-GCM" },
            false,
            ["encrypt"]
        );

        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const payloadStr = JSON.stringify(message.payload);
        const payloadBytes = new TextEncoder().encode(payloadStr);

        const encryptedPayload = await window.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv,
            },
            importedKey,
            payloadBytes
        );

        return {
            ...message,
            payload: Array.from(new Uint8Array(encryptedPayload)),
            iv: btoa(String.fromCharCode.apply(null, Array.from(iv))),
            encrypted: true,
            keyId: this.currentKeyId
        };
    }

    async decryptMessage(message: any, key: JsonWebKey): Promise<any> {
        if (!message.encrypted || !message.payload || !message.iv) return message;

        const importedKey = await window.crypto.subtle.importKey(
            "jwk",
            key,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );

        const ivStr = atob(message.iv);
        const iv = new Uint8Array(ivStr.length);
        for (let i = 0; i < ivStr.length; i++) {
            iv[i] = ivStr.charCodeAt(i);
        }
        const encryptedPayload = new Uint8Array(message.payload);

        const decryptedPayload = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: iv,
            },
            importedKey,
            encryptedPayload
        );

        const payloadStr = new TextDecoder().decode(decryptedPayload);
        return {
            ...message,
            payload: JSON.parse(payloadStr),
            encrypted: false,
            iv: undefined,
            keyId: undefined
        };
    }

    private async getStoredKeys(): Promise<Record<string, SharedKey>> {
        const stored = localStorage.getItem(KEY_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
    }

    async storeSharedKey(key: SharedKey): Promise<void> {
        const keys = await this.getStoredKeys();
        keys[key.keyId] = key;
        localStorage.setItem(KEY_STORAGE_KEY, JSON.stringify(keys));
    }

    async getSharedKey(keyId: string): Promise<SharedKey | undefined> {
        const keys = await this.getStoredKeys();
        return keys[keyId];
    }
}
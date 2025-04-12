import React, { useState, useEffect } from 'react';
import { useEncryption } from '../../context/encryption-context';

/**
 * Dialog for pairing with the extension
 */
export const PairingDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [pairingCode, setPairingCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'pairing' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const { completePairing } = useEncryption();

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPairingCode('');
      setStatus('idle');
      setErrorMessage('');
    }
  }, [isOpen]);

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (pairingCode.length !== 6) {
      setErrorMessage('Pairing code must be 6 digits');
      return;
    }

    setStatus('pairing');
    try {
      const success = await completePairing(pairingCode);
      setStatus(success ? 'success' : 'error');
      if (!success) {
        setErrorMessage('Invalid pairing code');
      } else {
        // Close the dialog after a short delay
        setTimeout(() => {
          onClose();
        }, 1500);
      }
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : 'Unknown error');
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-vscode-editor rounded-md shadow-lg p-6 max-w-md w-full">
        <h2 className="text-xl font-semibold mb-4">Pair with Extension</h2>
        
        <p className="mb-4 text-vscode-foreground">
          Enter the 6-digit pairing code displayed in the VS Code extension to establish a secure connection.
        </p>
        
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="pairingCode" className="block text-sm font-medium mb-1">
              Pairing Code
            </label>
            <input
              id="pairingCode"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
              className="w-full px-3 py-2 bg-vscode-input border border-vscode-border rounded-md focus:outline-none focus:ring-2 focus:ring-vscode-focusBorder"
              disabled={status === 'pairing' || status === 'success'}
            />
            {status === 'error' && (
              <p className="mt-1 text-sm text-red-500">{errorMessage}</p>
            )}
          </div>
          
          {status === 'pairing' && (
            <div className="flex justify-center my-4">
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-vscode-focusBorder"></div>
            </div>
          )}
          
          {status === 'success' && (
            <p className="my-4 text-green-500">
              Pairing successful! Your connection is now encrypted.
            </p>
          )}
          
          <div className="flex justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-vscode-button-secondary text-vscode-foreground rounded-md hover:bg-opacity-80"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pairingCode.length !== 6 || status === 'pairing' || status === 'success'}
              className="px-4 py-2 bg-vscode-button text-vscode-button-foreground rounded-md hover:bg-opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Pair
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
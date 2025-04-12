import React, { useState } from 'react';
import { useEncryption } from '../../context/encryption-context';
import { PairingDialog } from './PairingDialog';

/**
 * Component for displaying encryption status and managing pairing
 */
export const EncryptionStatus: React.FC = () => {
  const { isPaired, initiatePairing, resetPairing } = useEncryption();
  const [isPairingDialogOpen, setIsPairingDialogOpen] = useState(false);
  
  /**
   * Handle pairing button click
   */
  const handlePairClick = async () => {
    await initiatePairing();
    setIsPairingDialogOpen(true);
  };
  
  /**
   * Handle reset button click
   */
  const handleResetClick = async () => {
    if (window.confirm('Are you sure you want to reset the encryption pairing? This will disconnect all encrypted sessions.')) {
      await resetPairing();
    }
  };
  
  return (
    <>
      <div className="flex items-center space-x-2">
        <div className="relative">
          {isPaired ? (
            <div className="flex items-center">
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                className="h-5 w-5 text-green-500" 
                viewBox="0 0 20 20" 
                fill="currentColor"
              >
                <path 
                  fillRule="evenodd" 
                  d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" 
                  clipRule="evenodd" 
                />
              </svg>
              <span className="ml-1 text-xs text-green-500">Encrypted</span>
            </div>
          ) : (
            <div className="flex items-center">
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                className="h-5 w-5 text-yellow-500" 
                viewBox="0 0 20 20" 
                fill="currentColor"
              >
                <path 
                  fillRule="evenodd" 
                  d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" 
                  clipRule="evenodd" 
                />
              </svg>
              <span className="ml-1 text-xs text-yellow-500">Not Encrypted</span>
            </div>
          )}
        </div>
        
        {!isPaired ? (
          <button
            onClick={handlePairClick}
            className="text-xs px-2 py-1 bg-vscode-button text-vscode-button-foreground rounded hover:bg-opacity-80"
            title="Pair with extension for end-to-end encryption"
          >
            Pair
          </button>
        ) : (
          <button
            onClick={handleResetClick}
            className="text-xs px-2 py-1 bg-vscode-button-secondary text-vscode-foreground rounded hover:bg-opacity-80"
            title="Reset encryption pairing"
          >
            Reset
          </button>
        )}
      </div>
      
      <PairingDialog 
        isOpen={isPairingDialogOpen} 
        onClose={() => setIsPairingDialogOpen(false)} 
      />
    </>
  );
};
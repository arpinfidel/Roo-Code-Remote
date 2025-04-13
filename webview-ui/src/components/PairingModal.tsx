import React from 'react';
import { useWs } from '../context/ws-context'; // Adjust path as needed
// Assuming a basic Modal structure or using a library like Shadcn/ui
// Replace with actual Modal components if available
// import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog"; // Example Shadcn/ui
// import { Button } from "./ui/button"; // Example Shadcn/ui

const PairingModal: React.FC = () => {
  const { pairingState, pairingCode, confirmPairing, resetPairing } = useWs();

  const isOpen = pairingState === 'awaiting-confirmation';

  if (!isOpen) {
    return null;
  }

  const handleConfirm = () => {
    confirmPairing().catch(err => {
      console.error("Failed to confirm pairing:", err);
      // TODO: Show error to user
    });
  };

  const handleCancel = () => {
    resetPairing(); // Reset pairing state and keys
  };

  // Basic Modal Structure (Replace with actual UI library components if used)
  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <h2 style={styles.title}>Pair Device</h2>
        <p style={styles.description}>
          Please compare the code below with the code shown on your other device. If they match, click "Confirm".
        </p>
        <div style={styles.codeContainer}>
          <span style={styles.code}>{pairingCode || '------'}</span>
        </div>
        <div style={styles.footer}>
          <button onClick={handleCancel} style={{ ...styles.button, ...styles.cancelButton }}>
            Cancel
          </button>
          <button onClick={handleConfirm} style={{ ...styles.button, ...styles.confirmButton }}>
            Confirm Code Matches
          </button>
        </div>
      </div>
    </div>
  );
};

// Basic inline styles for demonstration
const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: 'var(--vscode-sideBar-background, #252526)', // Use VSCode theme variables
    color: 'var(--vscode-foreground, #cccccc)',
    padding: '20px',
    borderRadius: '8px',
    minWidth: '300px',
    maxWidth: '500px',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.2)',
  },
  title: {
    marginTop: 0,
    marginBottom: '10px',
    fontSize: '1.2em',
    fontWeight: 'bold',
  },
  description: {
    marginBottom: '20px',
    fontSize: '0.9em',
    color: 'var(--vscode-descriptionForeground, #999999)',
  },
  codeContainer: {
    backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
    padding: '15px',
    borderRadius: '4px',
    textAlign: 'center',
    marginBottom: '20px',
  },
  code: {
    fontSize: '2em',
    fontWeight: 'bold',
    letterSpacing: '0.2em',
    fontFamily: 'monospace',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '10px',
  },
  button: {
    padding: '8px 15px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.9em',
  },
  cancelButton: {
    backgroundColor: 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: 'var(--vscode-button-secondaryForeground, #ffffff)',
  },
  confirmButton: {
    backgroundColor: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #ffffff)',
  },
};


export default PairingModal;
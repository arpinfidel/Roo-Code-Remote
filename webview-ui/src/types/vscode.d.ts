interface Window {
	vscode?: {
		postMessage(message: any): void
	}
	acquireVsCodeApi?: () => {
		postMessage(message: any): void
	}
}

interface Navigator {
	userAgent: string
}

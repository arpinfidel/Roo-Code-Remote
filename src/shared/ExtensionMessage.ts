import {
	ModelInfo,
	GlobalSettings,
	ApiConfigMeta,
	ProviderSettings as ApiConfiguration,
	HistoryItem,
	ModeConfig,
	CheckpointStorage,
	TelemetrySetting,
	ExperimentId,
	ClineAsk,
	ClineSay,
	ToolProgressStatus,
	ClineMessage,
} from "../schemas"
import { McpServer } from "./mcp"
import { GitCommit } from "../utils/git"
import { Mode } from "./modes"
import { PairingState } from "../services/e2ee/pairing" // Import PairingState

export type { ApiConfigMeta, ToolProgressStatus }

export interface LanguageModelChatSelector {
	vendor?: string
	family?: string
	version?: string
	id?: string
}

// Represents JSON data that is sent from extension to webview, called
// ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or
// 'settingsButtonClicked' or 'hello'. Webview will hold state.
export type WebSocketState = "connecting" | "connected" | "disconnected" | "error"

// Base interface for common properties (optional)
interface BaseExtensionMessage {
	text?: string;
	// ... other common optional fields if any
}

// Define specific message interfaces using discriminated unions
export type ExtensionMessage = BaseExtensionMessage & (
	| { type: "action"; action: "chatButtonClicked" | "mcpButtonClicked" | "settingsButtonClicked" | "historyButtonClicked" | "promptsButtonClicked" | "didBecomeVisible" | "popoutButtonClicked" | "helpButtonClicked" | "plusButtonClicked" }
	| { type: "state"; state: ExtensionState }
	| { type: "selectedImages"; images: string[] }
	| { type: "ollamaModels"; ollamaModels: string[] }
	| { type: "lmStudioModels"; lmStudioModels: string[] }
	| { type: "theme"; text: string } // Assuming theme is sent as stringified JSON
	| { type: "workspaceUpdated"; filePaths?: string[]; openedTabs?: Array<{ label: string; isActive: boolean; path?: string }> }
	| { type: "invoke"; invoke: "newChat" | "sendMessage" | "primaryButtonClick" | "secondaryButtonClick" | "setChatBoxMessage"; text?: string; images?: string[] } // Include text/images for sendMessage
	| { type: "partialMessage"; partialMessage: ClineMessage }
	| { type: "openRouterModels"; openRouterModels: Record<string, ModelInfo> }
	| { type: "glamaModels"; glamaModels: Record<string, ModelInfo> }
	| { type: "unboundModels"; unboundModels: Record<string, ModelInfo> }
	| { type: "requestyModels"; requestyModels: Record<string, ModelInfo> }
	| { type: "openAiModels"; openAiModels: string[] }
	| { type: "mcpServers"; mcpServers: McpServer[] }
	| { type: "enhancedPrompt"; text: string }
	| { type: "commitSearchResults"; commits: GitCommit[] }
	| { type: "listApiConfig"; listApiConfig: ApiConfigMeta[] }
	| { type: "vsCodeLmModels"; vsCodeLmModels: LanguageModelChatSelector[] }
	| { type: "vsCodeLmApiAvailable"; success: boolean }
	| { type: "requestVsCodeLmModels" } // No payload
	| { type: "updatePrompt"; promptText: string }
	| { type: "systemPrompt"; text: string }
	| { type: "autoApprovalEnabled"; success: boolean } // Assuming payload indicates new state
	| { type: "updateCustomMode"; customMode: ModeConfig }
	| { type: "deleteCustomMode"; slug: string }
	| { type: "currentCheckpointUpdated"; success: boolean } // Or maybe checkpoint data? Adjust as needed.
	| { type: "showHumanRelayDialog"; requestId: string; values: Record<string, any> }
	| { type: "humanRelayResponse"; requestId: string; values: Record<string, any> }
	| { type: "humanRelayCancel"; requestId: string }
	| { type: "browserToolEnabled"; success: boolean } // Assuming payload indicates new state
	| { type: "browserConnectionResult"; success: boolean; error?: string }
	| { type: "remoteBrowserEnabled"; success: boolean } // Assuming payload indicates new state
	| { type: "ttsStart"; text: string }
	| { type: "ttsStop" } // No payload
	| { type: "maxReadFileLine"; success: boolean } // Assuming payload indicates new state
	| { type: "fileSearchResults"; results: Array<{ path: string; type: "file" | "folder"; label?: string }>; requestId?: string } // Keep requestId optional here for success case
	| { type: "fileSearchError"; error: string; requestId?: string } // New type for errors
	| { type: "toggleApiConfigPin"; slug: string; success: boolean }
	| { type: "setToken"; credential?: string } // Assuming token is passed in credential field
	| { type: "websocketState"; websocketState: WebSocketState }
	// E2EE Types
	| { type: "e2eeState"; state: PairingState }
	| { type: "e2eeCode"; code: string }
	| { type: "e2eePaired"; peerKey: string }
	| { type: "e2eeUnpaired" } // No payload
);

export type ExtensionState = Pick<
	GlobalSettings,
	| "currentApiConfigName"
	| "listApiConfigMeta"
	| "pinnedApiConfigs"
	// | "lastShownAnnouncementId"
	| "customInstructions"
	// | "taskHistory" // Optional in GlobalSettings, required here.
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnly"
	| "alwaysAllowReadOnlyOutsideWorkspace"
	| "alwaysAllowWrite"
	| "alwaysAllowWriteOutsideWorkspace"
	// | "writeDelayMs" // Optional in GlobalSettings, required here.
	| "alwaysAllowBrowser"
	| "alwaysApproveResubmit"
	// | "requestDelaySeconds" // Optional in GlobalSettings, required here.
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "allowedCommands"
	| "browserToolEnabled"
	| "browserViewportSize"
	| "screenshotQuality"
	| "remoteBrowserEnabled"
	| "remoteBrowserHost"
	// | "enableCheckpoints" // Optional in GlobalSettings, required here.
	// | "checkpointStorage" // Optional in GlobalSettings, required here.
	| "ttsEnabled"
	| "ttsSpeed"
	| "soundEnabled"
	| "soundVolume"
	// | "maxOpenTabsContext" // Optional in GlobalSettings, required here.
	// | "maxWorkspaceFiles" // Optional in GlobalSettings, required here.
	// | "showRooIgnoredFiles" // Optional in GlobalSettings, required here.
	// | "maxReadFileLine" // Optional in GlobalSettings, required here.
	| "terminalOutputLineLimit"
	| "terminalShellIntegrationTimeout"
	// | "rateLimitSeconds" // Optional in GlobalSettings, required here.
	| "diffEnabled"
	| "fuzzyMatchThreshold"
	// | "experiments" // Optional in GlobalSettings, required here.
	| "language"
	// | "telemetrySetting" // Optional in GlobalSettings, required here.
	// | "mcpEnabled" // Optional in GlobalSettings, required here.
	// | "enableMcpServerCreation" // Optional in GlobalSettings, required here.
	// | "mode" // Optional in GlobalSettings, required here.
	| "modeApiConfigs"
	// | "customModes" // Optional in GlobalSettings, required here.
	| "customModePrompts"
	| "customSupportPrompts"
	| "enhancementApiConfigId"
> & {
	version: string
	osInfo: string
	clineMessages: ClineMessage[]
	currentTaskItem?: HistoryItem
	apiConfiguration?: ApiConfiguration
	uriScheme?: string
	shouldShowAnnouncement: boolean

	taskHistory: HistoryItem[]

	writeDelayMs: number
	requestDelaySeconds: number

	enableCheckpoints: boolean
	checkpointStorage: CheckpointStorage
	maxOpenTabsContext: number // Maximum number of VSCode open tabs to include in context (0-500)
	maxWorkspaceFiles: number // Maximum number of files to include in current working directory details (0-500)
	showRooIgnoredFiles: boolean // Whether to show .rooignore'd files in listings
	maxReadFileLine: number // Maximum number of lines to read from a file before truncating

	rateLimitSeconds: number // Minimum time between successive requests (0 = disabled).
	experiments: Record<ExperimentId, boolean> // Map of experiment IDs to their enabled state

	mcpEnabled: boolean
	enableMcpServerCreation: boolean

	mode: Mode
	customModes: ModeConfig[]
	toolRequirements?: Record<string, boolean> // Map of tool names to their requirements (e.g. {"apply_diff": true} if diffEnabled)

	cwd?: string // Current working directory
	telemetrySetting: TelemetrySetting
	telemetryKey?: string
	machineId?: string

	renderContext: "sidebar" | "editor"
	settingsImportedAt?: number
}

export type { ClineMessage, ClineAsk, ClineSay }

export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "appliedDiff"
		| "newFileCreated"
		| "readFile"
		| "fetchInstructions"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "switchMode"
		| "newTask"
		| "finishTask"
	path?: string
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	mode?: string
	reason?: string
	isOutsideWorkspace?: boolean
}

// Must keep in sync with system prompt.
export const browserActions = ["launch", "click", "hover", "type", "scroll_down", "scroll_up", "close"] as const

export type BrowserAction = (typeof browserActions)[number]

export interface ClineSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	text?: string
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
}

export interface ClineApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
}

export type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled"

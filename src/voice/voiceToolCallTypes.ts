import type { VoiceSessionManager } from "./voiceSessionManager.ts";
import type { VoiceRealtimeToolSettings } from "./voiceSessionTypes.ts";

export type VoiceToolCallManager = Pick<
  VoiceSessionManager,
  | "appConfig"
  | "browserManager"
  | "buildRealtimeFunctionTools"
  | "buildVoiceQueueStatePayload"
  | "client"
  | "endSession"
  | "ensureSessionMusicState"
  | "ensureSessionToolRuntimeState"
  | "ensureToolMusicQueueState"
  | "executeLocalVoiceToolCall"
  | "executeMcpVoiceToolCall"
  | "executeVoiceAdaptiveStyleAddTool"
  | "executeVoiceAdaptiveStyleRemoveTool"
  | "executeVoiceConversationSearchTool"
  | "executeVoiceMemorySearchTool"
  | "executeVoiceMemoryWriteTool"
  | "executeVoiceMusicPlayNowTool"
  | "executeVoiceMusicQueueAddTool"
  | "executeVoiceMusicQueueNextTool"
  | "executeVoiceMusicSearchTool"
  | "executeVoiceWebSearchTool"
  | "getVoiceMcpServerStatuses"
  | "getVoiceScreenShareCapability"
  | "haltSessionOutputForMusicPlayback"
  | "isMusicPlaybackActive"
  | "llm"
  | "memory"
  | "musicPlayer"
  | "musicSearch"
  | "normalizeMusicSelectionResult"
  | "offerVoiceScreenShareLink"
  | "parseOpenAiRealtimeToolArguments"
  | "playVoiceQueueTrackByIndex"
  | "recordVoiceToolCallEvent"
  | "requestPauseMusic"
  | "requestPlayMusic"
  | "requestRealtimePromptUtterance"
  | "requestStopMusic"
  | "resolveOpenAiRealtimeToolDescriptor"
  | "resolveVoiceRealtimeToolDescriptors"
  | "resolveVoiceSpeakerName"
  | "scheduleOpenAiRealtimeToolFollowupResponse"
  | "search"
  | "setMusicPhase"
  | "store"
  | "summarizeVoiceToolOutput"
  | "updateVoiceMcpStatus"
  | "waitForLeaveDirectivePlayback"
> & {
  createBrowserAgentSession?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => SubAgentInteractiveSession | null | undefined) | null;
  createCodeAgentSession?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    cwd?: string;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => SubAgentInteractiveSession | null | undefined) | null;
  runModelRequestedCodeTask?: ((args: {
    settings?: VoiceRealtimeToolSettings | null;
    task: string;
    cwd?: string;
    guildId: string;
    channelId: string;
    userId: string | null;
    source: string;
  }) => Promise<{
    text?: string;
    costUsd?: number;
    error?: unknown;
    blockedByPermission?: boolean;
    blockedByBudget?: boolean;
    blockedByParallelLimit?: boolean;
  }>) | null;
  subAgentSessions?: SubAgentSessionRegistry | null;
};

export type VoiceToolCallArgs = Record<string, unknown>;

export type RealtimeFunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  toolType: "function" | "mcp";
  serverName: string | null;
};

export interface SubAgentTurnResult {
  isError?: boolean;
  errorMessage?: string | null;
  text: string;
  costUsd?: number | null;
}

export interface SubAgentInteractiveSession {
  id: string;
  ownerUserId?: string | null;
  runTurn: (instruction: string) => Promise<SubAgentTurnResult>;
}

export interface SubAgentSessionRegistry {
  get: (sessionId: string) => SubAgentInteractiveSession | null | undefined;
  register: (session: SubAgentInteractiveSession) => void;
}

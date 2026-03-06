import { providerSupports } from "./voiceModes.ts";
import type { VoiceMcpServerStatus, VoiceRealtimeToolSettings, VoiceToolRuntimeSessionLike } from "./voiceSessionTypes.ts";
import type { VoiceToolCallManager } from "./voiceToolCallTypes.ts";

export {
  buildRealtimeFunctionTools,
  ensureSessionToolRuntimeState,
  getVoiceMcpServerStatuses,
  parseOpenAiRealtimeToolArguments,
  recordVoiceToolCallEvent,
  resolveOpenAiRealtimeToolDescriptor,
  resolveVoiceRealtimeToolDescriptors,
  summarizeVoiceToolOutput
} from "./voiceToolCallToolRegistry.ts";

type RealtimeFunctionOutputClient = NonNullable<VoiceToolRuntimeSessionLike["realtimeClient"]> & {
  sendFunctionCallOutput?: (payload: { callId: string; output: string }) => void;
};

type ToolExecutionSession = VoiceToolRuntimeSessionLike & {
  openAiPendingToolAbortControllers?: Map<string, AbortController>;
  realtimeClient?: RealtimeFunctionOutputClient | null;
};

export async function executeOpenAiRealtimeFunctionCall(
  manager: VoiceToolCallManager,
  { session, settings, pendingCall }: { session?: VoiceToolRuntimeSessionLike | null; settings?: VoiceRealtimeToolSettings | null; pendingCall: any }
) {
  if (!session || session.ending) return;
  const runtimeSession = session as ToolExecutionSession;
  const callId = String(pendingCall?.callId || "").trim().slice(0, 180);
  const toolName = String(pendingCall?.name || "").trim().slice(0, 120);
  if (!callId) return;

  const startedAtMs = Date.now();
  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const callArgs = manager.parseOpenAiRealtimeToolArguments(pendingCall?.argumentsText || "");
  const toolDescriptor = manager.resolveOpenAiRealtimeToolDescriptor(session, toolName);
  const toolType = toolDescriptor?.toolType === "mcp" ? "mcp" : "function";

  const abortController = new AbortController();
  if (!(runtimeSession.openAiPendingToolAbortControllers instanceof Map)) {
    runtimeSession.openAiPendingToolAbortControllers = new Map();
  }
  runtimeSession.openAiPendingToolAbortControllers.set(callId, abortController);

  manager.store.logAction({
    kind: "voice_runtime",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: "openai_realtime_tool_call_started",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: toolName || null,
      toolType,
      arguments: callArgs
    }
  });

  let success = false;
  let output: unknown = null;
  let errorMessage = "";
  try {
    if (!toolDescriptor) throw new Error(`unknown_tool:${toolName || "unnamed"}`);
    output = toolDescriptor.toolType === "mcp"
      ? await manager.executeMcpVoiceToolCall({ session, settings: resolvedSettings, toolDescriptor, args: callArgs })
      : await manager.executeLocalVoiceToolCall({
          session,
          settings: resolvedSettings,
          toolName: toolDescriptor.name,
          args: callArgs,
          signal: abortController.signal
        });
    success = true;
  } catch (error) {
    errorMessage = String(error?.message || error);
    output = { ok: false, error: { message: errorMessage } };
  } finally {
    runtimeSession.openAiPendingToolAbortControllers?.delete(callId);
  }

  const runtimeMs = Math.max(0, Date.now() - startedAtMs);
  const outputSummary = manager.summarizeVoiceToolOutput(output);
  manager.recordVoiceToolCallEvent({
    session,
    event: {
      callId,
      toolName: toolName || toolDescriptor?.name || "unknown_tool",
      toolType,
      arguments: callArgs,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      runtimeMs,
      success,
      outputSummary,
      error: success ? null : errorMessage,
      sourceEventType: String(pendingCall?.sourceEventType || "")
    }
  });

  try {
    if (typeof runtimeSession.realtimeClient?.sendFunctionCallOutput === "function") {
      let serializedOutput = "";
      if (typeof output === "string") {
        serializedOutput = output;
      } else {
        try {
          serializedOutput = JSON.stringify(output ?? null);
        } catch {
          serializedOutput = String(output ?? "");
        }
      }
      runtimeSession.realtimeClient.sendFunctionCallOutput({ callId, output: serializedOutput });
    }
  } catch (sendError) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `openai_realtime_tool_output_send_failed: ${String(sendError?.message || sendError)}`,
      metadata: { sessionId: session.id, callId, toolName: toolName || null }
    });
  }

  manager.store.logAction({
    kind: success ? "voice_runtime" : "voice_error",
    guildId: session.guildId,
    channelId: session.textChannelId,
    userId: manager.client.user?.id || null,
    content: success ? "openai_realtime_tool_call_completed" : "openai_realtime_tool_call_failed",
    metadata: {
      sessionId: session.id,
      callId,
      toolName: toolName || null,
      toolType,
      runtimeMs,
      outputSummary,
      error: success ? null : errorMessage
    }
  });

  if (session.openAiPendingToolCalls instanceof Map) session.openAiPendingToolCalls.delete(callId);
  if (session.openAiCompletedToolCallIds instanceof Map) {
    session.openAiCompletedToolCallIds.set(callId, Date.now());
    const completedRows = [...session.openAiCompletedToolCallIds.entries()].sort((a, b) => a[1] - b[1]).slice(-256);
    session.openAiCompletedToolCallIds = new Map(
      completedRows.filter(([, completedAtMs]) => Date.now() - completedAtMs <= 10 * 60 * 1000)
    );
  }
  if (session.openAiToolCallExecutions instanceof Map) session.openAiToolCallExecutions.delete(callId);
  if (!(session.openAiToolCallExecutions instanceof Map) || session.openAiToolCallExecutions.size <= 0) {
    manager.scheduleOpenAiRealtimeToolFollowupResponse({
      session,
      userId: session.lastOpenAiToolCallerUserId || null
    });
  }
}

export async function refreshRealtimeTools(
  manager: VoiceToolCallManager,
  {
    session,
    settings,
    reason = "voice_context_refresh"
  }: { session?: VoiceToolRuntimeSessionLike | null; settings?: VoiceRealtimeToolSettings | null; reason?: string } = {}
) {
  if (!session || session.ending) return;
  if (!providerSupports(session.mode || "", "updateTools")) return;
  const realtimeClient = session.realtimeClient;
  if (!realtimeClient || typeof realtimeClient.updateTools !== "function") return;

  manager.ensureSessionToolRuntimeState(session);
  const previousMcpStatuses = new Map<string, VoiceMcpServerStatus>();
  for (const entry of Array.isArray(session.mcpStatus) ? session.mcpStatus : []) {
    const serverName = String(entry?.serverName || "");
    if (serverName) previousMcpStatuses.set(serverName, entry);
  }
  session.mcpStatus = manager.getVoiceMcpServerStatuses().map((entry) => {
    const previous = previousMcpStatuses.get(String(entry.serverName || ""));
    return {
      ...entry,
      lastError: previous?.lastError || null,
      lastConnectedAt: previous?.lastConnectedAt || entry.lastConnectedAt || null,
      lastCallAt: previous?.lastCallAt || entry.lastCallAt || null
    };
  });

  const resolvedSettings = settings || session.settingsSnapshot || manager.store.getSettings();
  const tools = manager.buildRealtimeFunctionTools({ session, settings: resolvedSettings });
  const nextToolHash = JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      toolType: tool.toolType,
      serverName: tool.serverName || null,
      description: tool.description,
      parameters: tool.parameters
    }))
  );
  if (String(session.lastOpenAiRealtimeToolHash || "") === nextToolHash) return;

  try {
    realtimeClient.updateTools({
      tools: tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      })),
      toolChoice: "auto"
    });
    session.openAiToolDefinitions = tools;
    session.lastOpenAiRealtimeToolHash = nextToolHash;
    session.lastOpenAiRealtimeToolRefreshAt = Date.now();
    manager.store.logAction({
      kind: "voice_runtime",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: "openai_realtime_tools_updated",
      metadata: {
        sessionId: session.id,
        reason: String(reason || "voice_context_refresh"),
        localToolCount: tools.filter((tool) => tool.toolType === "function").length,
        mcpToolCount: tools.filter((tool) => tool.toolType === "mcp").length,
        toolNames: tools.map((tool) => tool.name)
      }
    });
  } catch (error) {
    manager.store.logAction({
      kind: "voice_error",
      guildId: session.guildId,
      channelId: session.textChannelId,
      userId: manager.client.user?.id || null,
      content: `openai_realtime_tools_update_failed: ${String(error?.message || error)}`,
      metadata: { sessionId: session.id, reason: String(reason || "voice_context_refresh") }
    });
  }
}

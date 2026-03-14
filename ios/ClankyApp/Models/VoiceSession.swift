import Foundation

/// Voice state snapshot from the `/api/voice/events` SSE stream.
struct VoiceStateSnapshot: Codable, Sendable {
    let activeCount: Int?
    let sessions: [VoiceSessionSnapshot]?
}

/// A single active voice session — subset of the full server snapshot,
/// focused on what's useful for the iOS mission control view.
struct VoiceSessionSnapshot: Codable, Sendable, Identifiable {
    var id: String { sessionId ?? "" }

    let sessionId: String?
    let guildId: String?
    let voiceChannelId: String?
    let textChannelId: String?
    let startedAt: String?
    let lastActivityAt: String?
    let mode: String?
    let realtimeToolOwnership: String?
    let botTurnOpen: Bool?
    let participantCount: Int?

    let participants: [VoiceParticipant]?
    let recentTurns: [VoiceRecentTurn]?
    let activeCaptures: [VoiceActiveCapture]?
    let music: VoiceMusicState?
    let assistantOutput: VoiceAssistantOutput?
    let conversation: VoiceConversationState?
    let streamWatch: VoiceStreamWatchState?
    let latency: VoiceLatencyState?
    let toolCalls: [VoiceToolCall]?
    let brainTools: [VoiceBrainTool]?
    let asrSessions: [VoiceAsrSession]?

    // Computed helpers
    var startDate: Date? {
        guard let startedAt else { return nil }
        return ISO8601DateFormatter().date(from: startedAt)
    }

    var durationSeconds: Int? {
        guard let start = startDate else { return nil }
        return Int(Date().timeIntervalSince(start))
    }

    var modeLabel: String {
        switch mode {
        case "openai_realtime": return "OpenAI Realtime"
        case "elevenlabs_realtime": return "ElevenLabs Realtime"
        case "voice_agent": return "Voice Agent"
        default: return mode?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Unknown"
        }
    }

    var isActive: Bool {
        sessionId != nil && !(sessionId?.isEmpty ?? true)
    }

    var musicIsPlaying: Bool {
        music?.active == true
    }
}

struct VoiceParticipant: Codable, Sendable, Identifiable {
    var id: String { userId ?? UUID().uuidString }
    let userId: String?
    let displayName: String?
}

struct VoiceRecentTurn: Codable, Sendable, Identifiable {
    var id: String { "\(role ?? "")_\(at ?? "")_\(text?.prefix(20) ?? "")" }
    let kind: String?
    let role: String?
    let speakerName: String?
    let text: String?
    let at: String?
    let addressing: VoiceTurnAddressing?

    var date: Date? {
        guard let at else { return nil }
        return ISO8601DateFormatter().date(from: at)
    }

    var isAssistant: Bool {
        role == "assistant"
    }

    var isThought: Bool {
        kind == "thought"
    }
}

struct VoiceTurnAddressing: Codable, Sendable {
    let talkingTo: String?
    let directedConfidence: Double?
    let source: String?
    let reason: String?
}

struct VoiceActiveCapture: Codable, Sendable, Identifiable {
    var id: String { userId ?? UUID().uuidString }
    let userId: String?
    let displayName: String?
    let startedAt: String?
    let ageMs: Int?
}

struct VoiceMusicState: Codable, Sendable {
    let phase: String?
    let active: Bool?
    let provider: String?
    let lastTrackTitle: String?
    let lastTrackArtists: [String]?
    let lastQuery: String?
    let disambiguationActive: Bool?
    let pendingQuery: String?
}

struct VoiceAssistantOutput: Codable, Sendable {
    let phase: String?
    let reason: String?
    let requestId: Int?
    let ttsPlaybackState: String?
    let ttsBufferedSamples: Int?
}

struct VoiceConversationState: Codable, Sendable {
    let lastAssistantReplyAt: String?
    let lastDirectAddressAt: String?
    let thoughtEngine: VoiceThoughtEngineState?
    let wake: VoiceWakeState?
}

struct VoiceThoughtEngineState: Codable, Sendable {
    let busy: Bool?
    let pendingThought: VoicePendingThought?
}

struct VoicePendingThought: Codable, Sendable {
    let status: String?
    let text: String?
    let draftText: String?
    let trigger: String?
    let ageMs: Int?
    let revision: Int?
    let lastDecisionReason: String?
    let lastDecisionAction: String?
}

struct VoiceWakeState: Codable, Sendable {
    let attentionMode: String?
    let active: Bool?
    let currentSpeakerActive: Bool?
    let recentAssistantReply: Bool?
    let msSinceAssistantReply: Int?
    let windowMs: Int?
}

struct VoiceStreamWatchState: Codable, Sendable {
    let active: Bool?
    let targetUserId: String?
    let ingestedFrameCount: Int?
    let brainContextCount: Int?
}

struct VoiceLatencyState: Codable, Sendable {
    let turnCount: Int?
    let averages: VoiceLatencyAverages?
    let recentTurns: [VoiceLatencyTurn]?
}

struct VoiceLatencyAverages: Codable, Sendable {
    let finalizedToAsrStartMs: Double?
    let asrToGenerationStartMs: Double?
    let generationToReplyRequestMs: Double?
    let replyRequestToAudioStartMs: Double?
    let totalMs: Double?
}

struct VoiceLatencyTurn: Codable, Sendable, Identifiable {
    var id: String { at ?? UUID().uuidString }
    let at: String?
    let totalMs: Double?
    let queueWaitMs: Double?
}

struct VoiceToolCall: Codable, Sendable, Identifiable {
    var id: String { callId ?? UUID().uuidString }
    let callId: String?
    let toolName: String?
    let toolType: String?
    let arguments: [String: JSONValue]?
    let startedAt: String?
    let completedAt: String?
    let runtimeMs: Int?
    let success: Bool?
    let outputSummary: String?
    let error: String?

    var isInFlight: Bool {
        completedAt == nil
    }
}

struct VoiceBrainTool: Codable, Sendable, Identifiable {
    var id: String { name ?? UUID().uuidString }
    let name: String?
    let toolType: String?
    let description: String?
}

struct VoiceAsrSession: Codable, Sendable, Identifiable {
    var id: String { userId ?? UUID().uuidString }
    let userId: String?
    let displayName: String?
    let connected: Bool?
    let phase: String?
    let model: String?
    let utterance: VoiceAsrUtterance?
}

struct VoiceAsrUtterance: Codable, Sendable {
    let partialText: String?
    let finalSegments: Int?
    let bytesSent: Int?
}

/// Historical voice session entry from /api/voice/history/sessions
struct VoiceHistorySession: Codable, Sendable, Identifiable {
    var id: String { sessionId ?? "" }
    let sessionId: String?
    let guildId: String?
    let mode: String?
    let startedAt: String?
    let endedAt: String?
    let durationSeconds: Int?
    let endReason: String?

    var startDate: Date? {
        guard let startedAt else { return nil }
        return ISO8601DateFormatter().date(from: startedAt)
    }

    var formattedDuration: String {
        guard let seconds = durationSeconds else { return "--" }
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
    }
}

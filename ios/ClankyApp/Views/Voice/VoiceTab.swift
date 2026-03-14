import SwiftUI

/// VOICE tab — live voice session cockpit with conversation timeline.
struct VoiceTab: View {
    @Environment(VoiceStore.self) private var voice
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if let session = voice.activeSession {
                        activeSessionView(session)
                    } else {
                        noSessionView
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    // MARK: - Active Session

    @ViewBuilder
    private func activeSessionView(_ session: VoiceSessionSnapshot) -> some View {
        // Session status card
        sessionStatusCard(session)

        // Music card (if playing)
        if let music = session.music, music.active == true {
            musicCard(music)
        }

        // Conversation timeline
        if let turns = session.recentTurns, !turns.isEmpty {
            conversationTimeline(turns)
        }

        // Latency vitals
        if let latency = session.latency {
            latencyCard(latency)
        }

        // Active tool calls
        if let toolCalls = session.toolCalls, !toolCalls.isEmpty {
            toolCallsCard(toolCalls)
        }
    }

    // MARK: - Session Status Card

    private func sessionStatusCard(_ session: VoiceSessionSnapshot) -> some View {
        PanelView(label: "ACTIVE SESSION", trailing: session.modeLabel) {
            VStack(alignment: .leading, spacing: 8) {
                // Duration + participant count
                HStack {
                    if let seconds = session.durationSeconds {
                        HStack(spacing: 4) {
                            Image(systemName: "clock")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                            Text(formatDuration(seconds))
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        }
                    }

                    Spacer()

                    HStack(spacing: 4) {
                        Image(systemName: "person.2")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                        Text("\(session.participantCount ?? 0)")
                            .font(.system(size: 12, weight: .medium, design: .monospaced))
                    }

                    if let wake = session.conversation?.wake {
                        Text(wake.attentionMode ?? "AMBIENT")
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                            .tracking(0.6)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(wake.active == true ? Color.positive.opacity(0.15) : Color.secondary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }

                // Participant list
                if let participants = session.participants, !participants.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(participants) { participant in
                            Text(participant.displayName ?? "?")
                                .font(.system(size: 10, weight: .regular, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(Color.secondary.opacity(0.08))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                }

                // Assistant output phase
                if let output = session.assistantOutput {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(outputPhaseColor(output.phase))
                            .frame(width: 6, height: 6)
                        Text(output.phase?.uppercased() ?? "IDLE")
                            .font(.system(size: 9, weight: .medium, design: .monospaced))
                            .tracking(0.6)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - Music Card

    private func musicCard(_ music: VoiceMusicState) -> some View {
        PanelView(label: "MUSIC", trailing: music.phase?.uppercased()) {
            VStack(alignment: .leading, spacing: 4) {
                if let title = music.lastTrackTitle {
                    Text(title)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .lineLimit(2)
                }
                if let artists = music.lastTrackArtists, !artists.isEmpty {
                    Text(artists.joined(separator: ", "))
                        .font(.system(size: 10, weight: .regular, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Conversation Timeline

    private func conversationTimeline(_ turns: [VoiceRecentTurn]) -> some View {
        PanelView(label: "CONVERSATION", trailing: "\(turns.count) turns") {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(turns.reversed()) { turn in
                    conversationTurnRow(turn)
                    if turn.id != turns.first?.id {
                        Divider()
                            .padding(.vertical, 4)
                    }
                }
            }
        }
    }

    private func conversationTurnRow(_ turn: VoiceRecentTurn) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // Speaker indicator
            Rectangle()
                .fill(turn.isAssistant ? Color.domainLLM : Color.domainVoice)
                .frame(width: 2)
                .opacity(turn.isThought ? 0.4 : 1)

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(turn.speakerName ?? (turn.isAssistant ? "ASSISTANT" : "USER"))
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .tracking(0.4)
                        .foregroundStyle(turn.isThought ? .tertiary : .secondary)

                    if turn.isThought {
                        Text("THOUGHT")
                            .font(.system(size: 8, weight: .medium, design: .monospaced))
                            .tracking(0.4)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }

                    Spacer()

                    if let date = turn.date {
                        RelativeTimestamp(date: date)
                    }
                }

                if let text = turn.text, !text.isEmpty {
                    Text(text)
                        .font(.system(size: 11, weight: .regular, design: .monospaced))
                        .foregroundStyle(turn.isThought ? .tertiary : .primary)
                        .italic(turn.isThought)
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Latency Card

    private func latencyCard(_ latency: VoiceLatencyState) -> some View {
        PanelView(label: "LATENCY", trailing: "\(latency.turnCount ?? 0) turns") {
            if let avg = latency.averages {
                HStack(spacing: 0) {
                    latencyMetric("ASR", value: avg.finalizedToAsrStartMs)
                    latencyMetric("GEN", value: avg.generationToReplyRequestMs)
                    latencyMetric("TTS", value: avg.replyRequestToAudioStartMs)
                    latencyMetric("TOTAL", value: avg.totalMs, highlight: true)
                }
            }
        }
    }

    private func latencyMetric(_ label: String, value: Double?, highlight: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(value.map { "\(Int($0))ms" } ?? "--")
                .font(.system(size: 14, weight: highlight ? .bold : .medium, design: .monospaced))
                .contentTransition(.numericText())
            Text(label)
                .font(.system(size: 8, weight: .medium, design: .monospaced))
                .tracking(0.6)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Tool Calls Card

    private func toolCallsCard(_ toolCalls: [VoiceToolCall]) -> some View {
        PanelView(label: "TOOL CALLS", trailing: "\(toolCalls.count)") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(toolCalls) { call in
                    HStack {
                        Circle()
                            .fill(call.isInFlight ? Color.orange : (call.success == true ? Color.positive : Color.negative))
                            .frame(width: 6, height: 6)

                        Text(call.toolName ?? "unknown")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))

                        Spacer()

                        if let ms = call.runtimeMs {
                            Text("\(ms)ms")
                                .font(.system(size: 10, weight: .regular, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        } else if call.isInFlight {
                            ProgressView()
                                .scaleEffect(0.6)
                        }
                    }
                }
            }
        }
    }

    // MARK: - No Session View

    private var noSessionView: some View {
        VStack(spacing: 16) {
            VStack(spacing: 8) {
                Image(systemName: "waveform")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(.tertiary)

                Text("NO ACTIVE SESSION")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(.secondary)

                Text("Join a voice channel to start monitoring")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)

            // Session history
            if !voice.history.isEmpty {
                PanelView(label: "RECENT SESSIONS", trailing: "\(voice.history.count)") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(voice.history.prefix(10)) { session in
                            historyRow(session)
                            if session.id != voice.history.prefix(10).last?.id {
                                Divider()
                                    .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
        }
    }

    private func historyRow(_ session: VoiceHistorySession) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.mode?.replacingOccurrences(of: "_", with: " ").uppercased() ?? "UNKNOWN")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .tracking(0.4)

                Text(session.endReason ?? "")
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(session.formattedDuration)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))

                if let date = session.startDate {
                    RelativeTimestamp(date: date)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - Helpers

    private func formatDuration(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
    }

    private func outputPhaseColor(_ phase: String?) -> Color {
        switch phase {
        case "generating": return .orange
        case "speaking": return .positive
        case "idle": return .secondary
        default: return .secondary
        }
    }
}

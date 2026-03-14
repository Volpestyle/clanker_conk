import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.clanky.app", category: "Voice")

/// Manages real-time voice session state from the voice SSE stream.
@Observable @MainActor
final class VoiceStore {
    private(set) var sessions: [VoiceSessionSnapshot] = []
    private(set) var isConnected = false
    private(set) var history: [VoiceHistorySession] = []
    private(set) var isLoadingHistory = false

    private var sseTask: Task<Void, Never>?

    var activeSession: VoiceSessionSnapshot? {
        sessions.first(where: { $0.isActive })
    }

    var hasActiveSession: Bool {
        activeSession != nil
    }

    // MARK: - SSE Connection

    func connect(using connectionStore: ConnectionStore) async {
        sseTask?.cancel()
        isConnected = false

        guard let client = connectionStore.client else {
            log.error("Voice connect requested without a configured client")
            return
        }

        log.info("Starting Voice SSE connection")
        connectionStore.updateVoiceStreamStatus(.connecting)

        let sse = client.voiceSSE()

        sseTask = Task { [weak self] in
            guard let self else { return }

            for await message in await sse.messages() {
                guard !Task.isCancelled else { break }

                switch message {
                case .opened:
                    log.info("Voice SSE connected")
                    isConnected = true
                    connectionStore.updateVoiceStreamStatus(.connected)

                case .event(let event):
                    handleEvent(event)

                case .retrying(let reason, let attempt, _):
                    log.error("Voice SSE retrying: \(reason, privacy: .public) attempt=\(attempt)")
                    isConnected = false
                    connectionStore.updateVoiceStreamStatus(.error)
                }
            }

            log.info("Voice SSE disconnected")
            isConnected = false
            connectionStore.updateVoiceStreamStatus(.disconnected)
        }
    }

    func disconnect() {
        sseTask?.cancel()
        sseTask = nil
        isConnected = false
    }

    // MARK: - History

    func loadHistory(using connectionStore: ConnectionStore) async {
        guard let client = connectionStore.client else { return }
        isLoadingHistory = true
        defer { isLoadingHistory = false }

        do {
            let (data, _) = try await client.fetch("GET", path: "/api/voice/history/sessions?limit=50")
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let sessions = try decoder.decode([VoiceHistorySession].self, from: data)
            history = sessions
        } catch {
            log.error("Failed to load voice history: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Event Handlers

    private func handleEvent(_ event: SSEClient.Event) {
        switch event.name {
        case "voice_state":
            handleVoiceState(event.data)

        default:
            break
        }
    }

    private func handleVoiceState(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let snapshot = try JSONDecoder().decode(VoiceStateSnapshot.self, from: jsonData)
            sessions = snapshot.sessions ?? []
        } catch {
            log.error("Failed to decode voice_state: \(String(describing: error), privacy: .public)")
        }
    }
}

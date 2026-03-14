import Foundation
import Observation
import os

/// Manages the real-time activity stream from the Clanky SSE endpoint.
/// Holds actions, stats, and filter state for the Pulse tab.
private let log = Logger(subsystem: "com.clanky.app", category: "Activity")

@Observable @MainActor
final class ActivityStore {
    private(set) var actions: [ClankyAction] = []
    private(set) var stats: StatsPayload?
    private(set) var isConnected = false

    var activeFilter: FilterDomain = .all

    var filteredActions: [ClankyAction] {
        if activeFilter == .all { return actions }
        return actions.filter { activeFilter.matches($0.domain) }
    }

    private let maxActions = 220
    private var sseTask: Task<Void, Never>?
    nonisolated private var _sseTaskForDeinit: Task<Void, Never>? {
        // Workaround: access via MainActor.assumeIsolated is not allowed in deinit.
        // We rely on disconnect() being called explicitly or the Task being cancelled by ARC.
        nil
    }

    func connect(using connectionStore: ConnectionStore) async {
        sseTask?.cancel()
        isConnected = false
        connectionStore.updateActivityStreamStatus(.connecting)

        guard let client = connectionStore.client else {
            log.error("Pulse connect requested without a configured client")
            connectionStore.updateActivityStreamStatus(.disconnected)
            return
        }

        log.info("Starting Pulse connection to \(client.baseURL.absoluteString, privacy: .public)")

        // Health check first
        await connectionStore.performHealthCheck()
        guard connectionStore.status.isConnected else {
            log.error("Pulse health check failed: \(connectionStore.status.label, privacy: .public)")
            connectionStore.updateActivityStreamStatus(.disconnected)
            return
        }

        let sse = client.activitySSE()

        sseTask = Task { [weak self] in
            guard let self else { return }

            for await message in await sse.messages() {
                guard !Task.isCancelled else { break }
                handleStreamMessage(message, connectionStore: connectionStore)
            }

            log.info("Pulse SSE disconnected")
            isConnected = false
            connectionStore.updateActivityStreamStatus(.disconnected)
        }
    }

    func disconnect() {
        sseTask?.cancel()
        sseTask = nil
        isConnected = false
        log.info("Pulse SSE disconnected by user")
    }

    // MARK: - SSE Event Handlers

    func handleStreamMessage(_ message: SSEClient.Message, connectionStore: ConnectionStore) {
        switch message {
        case .opened:
            if !isConnected {
                log.info("Pulse SSE connected")
            }
            isConnected = true
            connectionStore.updateActivityStreamStatus(.connected)

        case .event(let event):
            switch event.name {
            case "activity_snapshot":
                handleSnapshot(event.data)

            case "action_event":
                handleActionEvent(event.data)

            case "stats_update":
                handleStatsUpdate(event.data)

            default:
                break
            }

        case .retrying(let reason, let attempt, let delaySeconds):
            log.error(
                "Pulse SSE retrying after error \(reason, privacy: .public) attempt=\(attempt, privacy: .public) delaySeconds=\(delaySeconds, privacy: .public)"
            )
            isConnected = false
            connectionStore.updateActivityStreamStatus(.error)
        }
    }

    private func handleSnapshot(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let snapshot = try JSONDecoder().decode(ActivitySnapshot.self, from: jsonData)
            if let snapshotActions = snapshot.actions {
                actions = Array(snapshotActions.prefix(maxActions))
            }
            if let snapshotStats = snapshot.stats {
                stats = snapshotStats
            }
        } catch {
            log.error("Failed to decode activity snapshot: \(String(describing: error), privacy: .public)")
        }
    }

    private func handleActionEvent(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            let action = try JSONDecoder().decode(ClankyAction.self, from: jsonData)

            // Deduplicate
            if actions.contains(where: { $0.id == action.id }) { return }

            // Insert at top, trim to max
            actions.insert(action, at: 0)
            if actions.count > maxActions {
                actions = Array(actions.prefix(maxActions))
            }

            // Haptic feedback
            HapticEngine.onAction(action.kind)
        } catch {
            log.error("Failed to decode action event: \(String(describing: error), privacy: .public)")
        }
    }

    private func handleStatsUpdate(_ data: String) {
        guard let jsonData = data.data(using: .utf8) else { return }
        do {
            stats = try JSONDecoder().decode(StatsPayload.self, from: jsonData)
        } catch {
            log.error("Failed to decode stats update: \(String(describing: error), privacy: .public)")
        }
    }
}

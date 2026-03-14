import Foundation

enum PulseConnectionState: Equatable {
    case connecting
    case waitingForEvents
    case disconnected

    static func resolve(
        connectionStatus: ConnectionStatus,
        activityStreamStatus: SSEStreamStatus,
        hasActions: Bool
    ) -> PulseConnectionState? {
        guard !hasActions else { return nil }

        if case .connecting = connectionStatus {
            return .connecting
        }

        guard connectionStatus.isConnected else {
            return .disconnected
        }

        switch activityStreamStatus {
        case .connecting:
            return .connecting
        case .connected:
            return .waitingForEvents
        case .disconnected, .error:
            return .disconnected
        }
    }
}

import XCTest
@testable import Clanky

final class PulseConnectionStateTests: XCTestCase {
    func testShowsConnectingWhileHealthCheckIsInFlight() {
        let state = PulseConnectionState.resolve(
            connectionStatus: .connecting,
            activityStreamStatus: .disconnected,
            hasActions: false
        )

        XCTAssertEqual(state, .connecting)
    }

    func testShowsConnectingWhilePulseStreamIsStarting() {
        let state = PulseConnectionState.resolve(
            connectionStatus: .connected,
            activityStreamStatus: .connecting,
            hasActions: false
        )

        XCTAssertEqual(state, .connecting)
    }

    func testShowsWaitingForEventsAfterPulseStreamConnects() {
        let state = PulseConnectionState.resolve(
            connectionStatus: .connected,
            activityStreamStatus: .connected,
            hasActions: false
        )

        XCTAssertEqual(state, .waitingForEvents)
    }

    func testHidesEmptyStateWhenActionsExist() {
        let state = PulseConnectionState.resolve(
            connectionStatus: .connected,
            activityStreamStatus: .connected,
            hasActions: true
        )

        XCTAssertNil(state)
    }

    func testShowsDisconnectedWhenConnectionFails() {
        let state = PulseConnectionState.resolve(
            connectionStatus: .error("HTTP 401"),
            activityStreamStatus: .disconnected,
            hasActions: false
        )

        XCTAssertEqual(state, .disconnected)
    }
}

@MainActor
final class ActivityStoreStreamStateTests: XCTestCase {
    func testMarksPulseStreamConnectedWhenSSETransportOpens() {
        let activity = ActivityStore()
        let connection = ConnectionStore()

        connection.updateActivityStreamStatus(.connecting)

        activity.handleStreamMessage(.opened, connectionStore: connection)

        XCTAssertTrue(activity.isConnected)
        XCTAssertEqual(connection.activityStreamStatus, .connected)
    }

    func testMarksPulseStreamErrorWhenSSETransportStartsRetrying() {
        let activity = ActivityStore()
        let connection = ConnectionStore()

        connection.updateActivityStreamStatus(.connecting)

        activity.handleStreamMessage(
            .retrying(reason: "HTTP 401", attempt: 1, delaySeconds: 3),
            connectionStore: connection
        )

        XCTAssertFalse(activity.isConnected)
        XCTAssertEqual(connection.activityStreamStatus, .error)
    }
}

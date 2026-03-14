import Foundation
import XCTest
@testable import Clanky

final class ClankyClientTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        URLProtocol.registerClass(StubSSEURLProtocol.self)
    }

    override class func tearDown() {
        URLProtocol.unregisterClass(StubSSEURLProtocol.self)
        super.tearDown()
    }

    func testHttpErrorDescriptionIncludesStatusAndBody() {
        let error = ClankyClientError.http(statusCode: 404, body: #"{"error":"Not found."}"#)

        XCTAssertEqual(error.errorDescription, #"HTTP 404: {"error":"Not found."}"#)
    }

    func testHttpErrorDescriptionOmitsEmptyBody() {
        let error = ClankyClientError.http(statusCode: 401, body: "   ")

        XCTAssertEqual(error.errorDescription, "HTTP 401")
    }

    func testSSEClientInvokesOnOpenBeforeAnyEventPayloadArrives() async {
        let streamOpened = expectation(description: "SSE stream opened")
        let receivedEvent = expectation(description: "No event payload required for open")
        receivedEvent.isInverted = true

        let client = SSEClient(url: URL(string: "https://sse-open.clanky-tests/api/activity/events")!)

        let streamTask = Task {
            for await message in await client.messages() {
                switch message {
                case .opened:
                    streamOpened.fulfill()

                case .event:
                    receivedEvent.fulfill()

                case .retrying(let reason, _, _):
                    XCTFail("Unexpected retryable SSE failure: \(reason)")
                }
            }
        }

        await fulfillment(of: [streamOpened], timeout: 1.0)
        await fulfillment(of: [receivedEvent], timeout: 0.2)

        streamTask.cancel()
        await streamTask.value
    }

    func testSSEClientReportsRetryableFailureWhenStreamCannotOpen() async {
        let openAttempt = expectation(description: "SSE stream should not open")
        openAttempt.isInverted = true
        let reportedFailure = expectation(description: "Retryable SSE failure reported")

        let client = SSEClient(
            url: URL(string: "https://sse-fail.clanky-tests/api/activity/events")!,
            reconnectDelay: 0.05,
            maxReconnectDelay: 0.05
        )

        let streamTask = Task {
            for await message in await client.messages() {
                switch message {
                case .opened:
                    openAttempt.fulfill()

                case .retrying(let reason, let attempt, let delaySeconds):
                    XCTAssertEqual(reason, "HTTP 401")
                    XCTAssertEqual(attempt, 1)
                    XCTAssertEqual(delaySeconds, 0.05, accuracy: 0.001)
                    reportedFailure.fulfill()
                    return

                case .event:
                    XCTFail("No events should be emitted when the stream request fails")
                }
            }
        }

        await fulfillment(of: [reportedFailure], timeout: 1.0)
        await fulfillment(of: [openAttempt], timeout: 0.2)

        streamTask.cancel()
        await streamTask.value
    }
}

private final class StubSSEURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".clanky-tests") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let client, let url = request.url else {
            return
        }

        switch url.host {
        case "sse-open.clanky-tests":
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            )!
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: Data(": heartbeat\n\n".utf8))

        case "sse-fail.clanky-tests":
            let response = HTTPURLResponse(
                url: url,
                statusCode: 401,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/plain", "Content-Length": "0"]
            )!
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocolDidFinishLoading(self)

        default:
            let response = HTTPURLResponse(
                url: url,
                statusCode: 404,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/plain", "Content-Length": "0"]
            )!
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

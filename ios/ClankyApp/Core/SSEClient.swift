import Foundation

/// Lightweight Server-Sent Events parser with auto-reconnect.
/// Uses URLSession bytes streaming — no third-party dependencies.
actor SSEClient {
    struct Event: Sendable {
        let name: String
        let data: String
    }

    enum Message: Sendable {
        case opened
        case event(Event)
        case retrying(reason: String, attempt: Int, delaySeconds: TimeInterval)
    }

    private let url: URL
    private let headers: [String: String]
    private let reconnectDelay: TimeInterval
    private let maxReconnectDelay: TimeInterval

    private var currentAttempt: Int = 0

    init(
        url: URL,
        headers: [String: String] = [:],
        reconnectDelay: TimeInterval = 3,
        maxReconnectDelay: TimeInterval = 30
    ) {
        self.url = url
        self.headers = headers
        self.reconnectDelay = reconnectDelay
        self.maxReconnectDelay = maxReconnectDelay
    }

    /// Yields transport lifecycle updates plus parsed SSE events.
    /// Reconnects automatically and surfaces retry state to the caller.
    func messages() -> AsyncStream<Message> {
        AsyncStream { continuation in
            let streamTask = Task {
                while !Task.isCancelled {
                    do {
                        try await streamEvents(into: continuation)
                    } catch is CancellationError {
                        break
                    } catch {
                        let attempt = currentAttempt + 1
                        let delay = min(
                            reconnectDelay * pow(2, Double(currentAttempt)),
                            maxReconnectDelay
                        )
                        currentAttempt = attempt
                        continuation.yield(
                            .retrying(
                                reason: Self.describe(error),
                                attempt: attempt,
                                delaySeconds: delay
                            )
                        )
                        try? await Task.sleep(for: .seconds(delay))
                    }
                }
                continuation.finish()
            }

            continuation.onTermination = { _ in
                streamTask.cancel()
            }
        }
    }

    private func streamEvents(into continuation: AsyncStream<Message>.Continuation) async throws {
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        request.timeoutInterval = 300

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw SSEError.invalidResponse
        }

        guard (200...299).contains(http.statusCode) else {
            throw SSEError.badStatus(http.statusCode)
        }

        // Reset reconnect backoff on successful connection
        currentAttempt = 0
        continuation.yield(.opened)

        var eventName = ""
        var dataBuffer = ""

        for try await line in bytes.lines {
            if Task.isCancelled { break }

            if line.isEmpty {
                // Empty line = event boundary
                if !dataBuffer.isEmpty {
                    let name = eventName.isEmpty ? "message" : eventName
                    let data = dataBuffer.hasSuffix("\n")
                        ? String(dataBuffer.dropLast())
                        : dataBuffer
                    continuation.yield(.event(Event(name: name, data: data)))
                }
                eventName = ""
                dataBuffer = ""
                continue
            }

            if line.hasPrefix(":") {
                // Comment line (heartbeat), skip
                continue
            }

            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst(5))
                let trimmed = value.hasPrefix(" ") ? String(value.dropFirst()) : value
                dataBuffer += trimmed + "\n"
            }
        }

        if !Task.isCancelled {
            throw SSEError.streamEnded
        }
    }

    private static func describe(_ error: Error) -> String {
        if let localized = error as? LocalizedError,
           let description = localized.errorDescription,
           !description.isEmpty {
            return description
        }
        return String(describing: error)
    }

    enum SSEError: LocalizedError {
        case invalidResponse
        case badStatus(Int)
        case streamEnded

        var errorDescription: String? {
            switch self {
            case .invalidResponse:
                return "Invalid SSE response"
            case .badStatus(let statusCode):
                return "HTTP \(statusCode)"
            case .streamEnded:
                return "SSE stream ended"
            }
        }
    }
}

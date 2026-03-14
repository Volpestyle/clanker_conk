import Foundation

struct BonjourDiscoveredService: Equatable, Sendable {
    let name: String
    let tunnelUrl: String?

    var hasTunnelUrl: Bool {
        guard let tunnelUrl else { return false }
        return !tunnelUrl.isEmpty
    }
}

enum BonjourDiscoveryDecision: Equatable {
    case keepSearching(BonjourDiscoveredService)
    case found(BonjourDiscoveredService)
}

enum BonjourDiscoveryLogic {
    static func decision(for services: [BonjourDiscoveredService]) -> BonjourDiscoveryDecision? {
        guard let service = bestService(from: services) else { return nil }
        if service.hasTunnelUrl {
            return .found(service)
        }
        return .keepSearching(service)
    }

    static func normalizedTunnelURL(_ rawValue: String?) -> String? {
        let trimmed = String(rawValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard
            let url = URL(string: trimmed),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = url.host,
            !host.isEmpty
        else {
            return nil
        }

        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil

        guard let normalizedUrl = components.url else {
            return nil
        }

        let absoluteString = normalizedUrl.absoluteString
        if absoluteString.hasSuffix("/") {
            return String(absoluteString.dropLast())
        }
        return absoluteString
    }

    static func isEphemeralCloudflareTunnel(_ rawValue: String?) -> Bool {
        guard
            let normalized = normalizedTunnelURL(rawValue),
            let url = URL(string: normalized),
            let host = url.host?.lowercased()
        else {
            return false
        }
        return host.hasSuffix(".trycloudflare.com")
    }

    static func replacementTunnelURL(
        currentInput: String,
        previousAutoFilledTunnelURL: String?,
        discoveredTunnelURL: String?
    ) -> String? {
        guard let discovered = normalizedTunnelURL(discoveredTunnelURL) else {
            return nil
        }

        let trimmedCurrentInput = currentInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedCurrentInput.isEmpty {
            return discovered
        }

        let current = normalizedTunnelURL(trimmedCurrentInput)
        let previousAutoFilled = normalizedTunnelURL(previousAutoFilledTunnelURL)

        if current == discovered {
            return nil
        }

        if let previousAutoFilled, current == previousAutoFilled {
            return discovered
        }

        return nil
    }

    private static func bestService(from services: [BonjourDiscoveredService]) -> BonjourDiscoveredService? {
        services.sorted(by: compareServices).first
    }

    private static func compareServices(_ lhs: BonjourDiscoveredService, _ rhs: BonjourDiscoveredService) -> Bool {
        if lhs.hasTunnelUrl != rhs.hasTunnelUrl {
            return lhs.hasTunnelUrl && !rhs.hasTunnelUrl
        }

        let nameOrder = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
        if nameOrder != .orderedSame {
            return nameOrder == .orderedAscending
        }

        return String(lhs.tunnelUrl ?? "") < String(rhs.tunnelUrl ?? "")
    }
}

import XCTest
@testable import Clanky

final class BonjourDiscoveryLogicTests: XCTestCase {
    func testKeepsSearchingWhenServiceHasNoTunnelURL() {
        let service = BonjourDiscoveredService(name: "Clanky Dashboard", tunnelUrl: nil)

        let decision = BonjourDiscoveryLogic.decision(for: [service])

        XCTAssertEqual(decision, .keepSearching(service))
    }

    func testReturnsFoundWhenTunnelURLArrives() {
        let service = BonjourDiscoveredService(
            name: "Clanky Dashboard",
            tunnelUrl: "https://fancy-cat.trycloudflare.com"
        )

        let decision = BonjourDiscoveryLogic.decision(for: [service])

        XCTAssertEqual(decision, .found(service))
    }

    func testPrefersServiceWithTunnelURL() {
        let missingTunnel = BonjourDiscoveredService(name: "Alpha", tunnelUrl: nil)
        let readyTunnel = BonjourDiscoveredService(
            name: "Beta",
            tunnelUrl: "https://ready.trycloudflare.com"
        )

        let decision = BonjourDiscoveryLogic.decision(for: [missingTunnel, readyTunnel])

        XCTAssertEqual(decision, .found(readyTunnel))
    }

    func testNormalizesTunnelURLWhitespaceAndTrailingSlash() {
        let normalized = BonjourDiscoveryLogic.normalizedTunnelURL(
            "  https://fancy-cat.trycloudflare.com/  "
        )

        XCTAssertEqual(normalized, "https://fancy-cat.trycloudflare.com")
    }

    func testRejectsInvalidTunnelURL() {
        XCTAssertNil(BonjourDiscoveryLogic.normalizedTunnelURL("not a url"))
        XCTAssertNil(BonjourDiscoveryLogic.normalizedTunnelURL("ftp://fancy-cat.trycloudflare.com"))
    }

    func testDetectsEphemeralCloudflareTunnelHosts() {
        XCTAssertTrue(BonjourDiscoveryLogic.isEphemeralCloudflareTunnel("https://demo.trycloudflare.com"))
        XCTAssertFalse(BonjourDiscoveryLogic.isEphemeralCloudflareTunnel("https://dashboard.example.com"))
    }

    func testReplacesPreviouslyAutofilledTunnelURLWhenDiscoveryChanges() {
        let replacement = BonjourDiscoveryLogic.replacementTunnelURL(
            currentInput: "https://old.trycloudflare.com",
            previousAutoFilledTunnelURL: "https://old.trycloudflare.com",
            discoveredTunnelURL: "https://new.trycloudflare.com"
        )

        XCTAssertEqual(replacement, "https://new.trycloudflare.com")
    }

    func testPreservesManualTunnelURLWhenDiscoveryChanges() {
        let replacement = BonjourDiscoveryLogic.replacementTunnelURL(
            currentInput: "https://dashboard.example.com",
            previousAutoFilledTunnelURL: "https://old.trycloudflare.com",
            discoveredTunnelURL: "https://new.trycloudflare.com"
        )

        XCTAssertNil(replacement)
    }

    func testPreservesPartiallyEditedTunnelURLWhenDiscoveryChanges() {
        let replacement = BonjourDiscoveryLogic.replacementTunnelURL(
            currentInput: "https://dash",
            previousAutoFilledTunnelURL: "https://old.trycloudflare.com",
            discoveredTunnelURL: "https://new.trycloudflare.com"
        )

        XCTAssertNil(replacement)
    }
}

import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.clanky.app", category: "Bonjour")
private let searchTimeout: Duration = .seconds(30)

/// Discovers the Clanky dashboard on the local network via Bonjour.
/// Reads the TXT record to get the tunnel URL for remote access.
@Observable
final class BonjourBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private(set) var discovered: BonjourDiscoveredService?
    private(set) var isSearching = false

    private var browser: NetServiceBrowser?
    private var servicesByKey: [String: NetService] = [:]
    private var discoveredServicesByKey: [String: BonjourDiscoveredService] = [:]
    private var timeoutTimer: Timer?

    override init() {
        super.init()
    }

    func startSearching() {
        stopSearching()
        isSearching = true
        discovered = nil

        let browser = NetServiceBrowser()
        browser.delegate = self
        browser.includesPeerToPeer = true
        browser.searchForServices(ofType: "_clanky._tcp.", inDomain: "local.")
        self.browser = browser

        let timeoutInterval = TimeInterval(searchTimeout.components.seconds)
        timeoutTimer = Timer.scheduledTimer(
            timeInterval: timeoutInterval,
            target: self,
            selector: #selector(handleSearchTimeout),
            userInfo: nil,
            repeats: false
        )
    }

    func stopSearching() {
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        for service in servicesByKey.values {
            service.stopMonitoring()
            service.stop()
            service.delegate = nil
        }
        servicesByKey.removeAll()
        discoveredServicesByKey.removeAll()
        browser?.stop()
        browser?.delegate = nil
        browser = nil
        isSearching = false
    }

    // MARK: - NetServiceBrowserDelegate

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        self.handleDidFind(service)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        self.handleDidNotSearch(errorDict)
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        self.handleDidRemove(service)
    }

    // MARK: - NetServiceDelegate

    func netServiceDidResolveAddress(_ sender: NetService) {
        self.handleDidResolveAddress(sender)
    }

    func netService(_ sender: NetService, didUpdateTXTRecord data: Data) {
        self.handleDidUpdateTXTRecord(sender, data: data)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        self.handleDidNotResolve(sender, errorDict: errorDict)
    }

    // MARK: - Delegate Handlers

    private func handleDidFind(_ service: NetService) {
        let key = serviceKey(for: service)
        guard servicesByKey[key] == nil else { return }

        service.delegate = self
        servicesByKey[key] = service
        discoveredServicesByKey[key] = BonjourDiscoveredService(name: service.name, tunnelUrl: nil)
        applyDiscoveryDecision()

        log.info("Discovered Bonjour service \(service.name, privacy: .public), resolving TXT record")
        print("[Bonjour] discovered service \(service.name), resolving TXT record")
        service.resolve(withTimeout: 5)
    }

    private func handleDidNotSearch(_ errorDict: [String: NSNumber]) {
        let errorDescription = errorDict.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
        log.error("Bonjour browse failed: \(errorDescription, privacy: .public)")
        print("[Bonjour] browse failed: \(errorDescription)")
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        isSearching = false
    }

    private func handleDidRemove(_ service: NetService) {
        let key = serviceKey(for: service)
        servicesByKey[key]?.stopMonitoring()
        servicesByKey[key]?.delegate = nil
        servicesByKey.removeValue(forKey: key)
        discoveredServicesByKey.removeValue(forKey: key)
        applyDiscoveryDecision()
    }

    private func handleDidResolveAddress(_ sender: NetService) {
        log.info("Resolved Bonjour service \(sender.name, privacy: .public)")
        print("[Bonjour] resolved service \(sender.name)")
        updateDiscoveredService(from: sender, txtRecordData: sender.txtRecordData())
        sender.startMonitoring()
    }

    private func handleDidUpdateTXTRecord(_ sender: NetService, data: Data) {
        log.info("Updated TXT record for \(sender.name, privacy: .public)")
        print("[Bonjour] updated TXT record for \(sender.name)")
        updateDiscoveredService(from: sender, txtRecordData: data)
    }

    private func handleDidNotResolve(_ sender: NetService, errorDict: [String: NSNumber]) {
        let errorDescription = errorDict.map { "\($0.key)=\($0.value)" }.joined(separator: ", ")
        log.error("Failed to resolve \(sender.name, privacy: .public): \(errorDescription, privacy: .public)")
        print("[Bonjour] failed to resolve \(sender.name): \(errorDescription)")
    }

    // MARK: - Helpers

    private func applyDiscoveryDecision() {
        guard let decision = BonjourDiscoveryLogic.decision(for: Array(discoveredServicesByKey.values)) else {
            discovered = nil
            isSearching = browser != nil
            return
        }

        switch decision {
        case .keepSearching(let service):
            discovered = service
            isSearching = true
            log.info("Discovered \(service.name), waiting for tunnel URL")
            print("[Bonjour] discovered \(service.name), waiting for tunnel URL")

        case .found(let service):
            discovered = service
            log.info("Discovered \(service.name), tunnel: \(service.tunnelUrl ?? "nil"); keeping TXT monitoring active")
            print("[Bonjour] discovered \(service.name), tunnel: \(service.tunnelUrl ?? "nil"), keeping TXT monitoring active")
            markDiscoveryResolved()
        }
    }

    private func updateDiscoveredService(from service: NetService, txtRecordData: Data?) {
        let key = serviceKey(for: service)
        let tunnelUrl = parseTunnelURL(from: txtRecordData)
        discoveredServicesByKey[key] = BonjourDiscoveredService(name: service.name, tunnelUrl: tunnelUrl)
        applyDiscoveryDecision()
    }

    private func parseTunnelURL(from txtRecordData: Data?) -> String? {
        guard let txtRecordData else { return nil }
        let dict = NetService.dictionary(fromTXTRecord: txtRecordData)
        if !dict.isEmpty {
            log.info("TXT keys: \(Array(dict.keys).description)")
            print("[Bonjour] TXT keys: \(Array(dict.keys))")
        }

        guard let rawTunnelData = dict["tunnelUrl"] else { return nil }
        let rawTunnelURL = String(data: rawTunnelData, encoding: .utf8)
        return BonjourDiscoveryLogic.normalizedTunnelURL(rawTunnelURL)
    }

    private func serviceKey(for service: NetService) -> String {
        "\(service.domain)|\(service.type)|\(service.name)"
    }

    private func markDiscoveryResolved() {
        timeoutTimer?.invalidate()
        timeoutTimer = nil
        isSearching = false
    }

    @objc
    private func handleSearchTimeout() {
        guard isSearching else { return }
        log.info("Bonjour discovery timed out while waiting for tunnel URL")
        stopSearching()
    }
}

import Foundation
import Observation
import os

private let log = Logger(subsystem: "com.clanky.app", category: "Memory")

/// Manages memory fact browsing and search.
@Observable @MainActor
final class MemoryStore {
    private(set) var subjects: [MemorySubject] = []
    private(set) var facts: [MemoryFact] = []
    var searchResults: [MemoryFact] = []
    private(set) var isLoading = false
    private(set) var isSearching = false

    var searchQuery = ""
    var selectedSubject: String?
    var selectedGuildId: String?

    /// Facts grouped by subject for display.
    var factsBySubject: [(subject: String, facts: [MemoryFact])] {
        let grouped = Dictionary(grouping: facts) { $0.subject ?? "unknown" }
        return grouped
            .map { (subject: $0.key, facts: $0.value) }
            .sorted { ($0.facts.count, $0.subject) > ($1.facts.count, $1.subject) }
    }

    // MARK: - API

    func loadSubjects(using connectionStore: ConnectionStore) async {
        guard let client = connectionStore.client,
              let guildId = selectedGuildId, !guildId.isEmpty else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            let (data, _) = try await client.fetch("GET", path: "/api/memory/subjects?guildId=\(guildId)&limit=200")
            let response = try JSONDecoder().decode(MemorySubjectsResponse.self, from: data)
            subjects = response.subjects ?? []
        } catch {
            log.error("Failed to load memory subjects: \(String(describing: error), privacy: .public)")
        }
    }

    func loadFacts(using connectionStore: ConnectionStore) async {
        guard let client = connectionStore.client,
              let guildId = selectedGuildId, !guildId.isEmpty else { return }

        isLoading = true
        defer { isLoading = false }

        var path = "/api/memory/facts?guildId=\(guildId)&limit=120"
        if let subject = selectedSubject, !subject.isEmpty {
            path += "&subject=\(subject.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? subject)"
        }

        do {
            let (data, _) = try await client.fetch("GET", path: path)
            let response = try JSONDecoder().decode(MemoryFactsResponse.self, from: data)
            facts = response.facts ?? []
        } catch {
            log.error("Failed to load memory facts: \(String(describing: error), privacy: .public)")
        }
    }

    func search(using connectionStore: ConnectionStore) async {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty,
              let client = connectionStore.client,
              let guildId = selectedGuildId, !guildId.isEmpty else {
            searchResults = []
            return
        }

        isSearching = true
        defer { isSearching = false }

        let encodedQuery = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let path = "/api/memory/search?guildId=\(guildId)&q=\(encodedQuery)&limit=20"

        do {
            let (data, _) = try await client.fetch("GET", path: path)
            let response = try JSONDecoder().decode(MemorySearchResponse.self, from: data)
            searchResults = response.results ?? []
        } catch {
            log.error("Failed to search memory: \(String(describing: error), privacy: .public)")
        }
    }

    func deleteFact(_ factId: Int, using connectionStore: ConnectionStore) async -> Bool {
        guard let client = connectionStore.client else { return false }

        do {
            _ = try await client.fetch("DELETE", path: "/api/memory/facts/\(factId)")
            facts.removeAll { $0.id == factId }
            searchResults.removeAll { $0.id == factId }
            return true
        } catch {
            log.error("Failed to delete memory fact: \(String(describing: error), privacy: .public)")
            return false
        }
    }
}

import Foundation

/// A memory fact from /api/memory/facts or /api/memory/search.
struct MemoryFact: Codable, Sendable, Identifiable {
    let id: Int
    let createdAt: String?
    let updatedAt: String?
    let guildId: String?
    let channelId: String?
    let subject: String?
    let fact: String?
    let factType: String?
    let evidenceText: String?
    let sourceMessageId: String?
    let confidence: Double?

    // Search-only fields
    let score: Double?
    let semanticScore: Double?

    enum CodingKeys: String, CodingKey {
        case id
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case guildId = "guild_id"
        case channelId = "channel_id"
        case subject
        case fact
        case factType = "fact_type"
        case evidenceText = "evidence_text"
        case sourceMessageId = "source_message_id"
        case confidence
        case score
        case semanticScore
    }

    var confidencePercent: String {
        guard let confidence else { return "--" }
        return "\(Int(confidence * 100))%"
    }

    var factTypeLabel: String {
        factType?.replacingOccurrences(of: "_", with: " ").uppercased() ?? "OTHER"
    }

    var date: Date? {
        guard let updatedAt else { return nil }
        return ISO8601DateFormatter().date(from: updatedAt)
    }
}

/// Response from /api/memory/facts
struct MemoryFactsResponse: Codable, Sendable {
    let guildId: String?
    let limit: Int?
    let subject: String?
    let queryText: String?
    let facts: [MemoryFact]?

    enum CodingKeys: String, CodingKey {
        case guildId = "guild_id"
        case limit
        case subject
        case queryText
        case facts
    }
}

/// Response from /api/memory/search
struct MemorySearchResponse: Codable, Sendable {
    let queryText: String?
    let guildId: String?
    let results: [MemoryFact]?

    enum CodingKeys: String, CodingKey {
        case queryText
        case guildId = "guild_id"
        case results
    }
}

/// Memory subject entry from /api/memory/subjects
struct MemorySubject: Codable, Sendable, Identifiable {
    var id: String { subject ?? "" }
    let guildId: String?
    let subject: String?
    let lastSeenAt: String?
    let factCount: Int?

    enum CodingKeys: String, CodingKey {
        case guildId = "guild_id"
        case subject
        case lastSeenAt = "last_seen_at"
        case factCount = "fact_count"
    }
}

/// Response from /api/memory/subjects
struct MemorySubjectsResponse: Codable, Sendable {
    let guildId: String?
    let limit: Int?
    let subjects: [MemorySubject]?

    enum CodingKeys: String, CodingKey {
        case guildId = "guild_id"
        case limit
        case subjects
    }
}

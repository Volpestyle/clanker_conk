import SwiftUI

/// MEMORY tab — browse and search Clanky's long-term memory facts.
struct MemoryTab: View {
    @Environment(MemoryStore.self) private var memory
    @Environment(ConnectionStore.self) private var connection
    @Environment(ActivityStore.self) private var activity

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Search bar
                searchBar
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                // Subject filter chips
                if !memory.subjects.isEmpty && memory.searchQuery.isEmpty {
                    subjectChips
                        .padding(.top, 8)
                }

                // Content
                ScrollView {
                    VStack(spacing: 12) {
                        if !memory.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            searchResultsView
                        } else if memory.facts.isEmpty && !memory.isLoading {
                            emptyState
                        } else {
                            factsView
                        }
                    }
                    .padding(16)
                }
                .scrollIndicators(.hidden)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if memory.selectedGuildId == nil {
                    // Use the first guild from stats if available
                    memory.selectedGuildId = activity.stats?.runtime?.guildCount ?? 0 > 0
                        ? nil  // Will need guild list endpoint
                        : nil
                }
                await memory.loadSubjects(using: connection)
                await memory.loadFacts(using: connection)
            }
        }
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)

            TextField("Search memory...", text: Bindable(memory).searchQuery)
                .font(.system(size: 13, weight: .regular, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    Task {
                        await memory.search(using: connection)
                    }
                }

            if !memory.searchQuery.isEmpty {
                Button {
                    memory.searchQuery = ""
                    memory.searchResults = []
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
    }

    // MARK: - Subject Chips

    private var subjectChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                subjectChip("ALL", isSelected: memory.selectedSubject == nil) {
                    memory.selectedSubject = nil
                    Task { await memory.loadFacts(using: connection) }
                }

                ForEach(memory.subjects.prefix(15)) { subject in
                    subjectChip(
                        subject.subject?.uppercased() ?? "?",
                        count: subject.factCount,
                        isSelected: memory.selectedSubject == subject.subject
                    ) {
                        memory.selectedSubject = subject.subject
                        Task { await memory.loadFacts(using: connection) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func subjectChip(_ label: String, count: Int? = nil, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 10, weight: isSelected ? .bold : .medium, design: .monospaced))
                    .tracking(0.4)

                if let count {
                    Text("\(count)")
                        .font(.system(size: 9, weight: .regular, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isSelected ? Color.primary.opacity(0.1) : .clear)
            .foregroundStyle(isSelected ? .primary : .secondary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(
                        isSelected ? Color.primary.opacity(0.2) : Color.primary.opacity(0.06),
                        lineWidth: 0.5
                    )
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Facts View

    private var factsView: some View {
        ForEach(memory.factsBySubject, id: \.subject) { group in
            PanelView(label: group.subject.uppercased(), trailing: "\(group.facts.count) facts") {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(group.facts) { fact in
                        factRow(fact)
                        if fact.id != group.facts.last?.id {
                            Divider()
                                .padding(.vertical, 4)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Search Results View

    private var searchResultsView: some View {
        Group {
            if memory.isSearching {
                VStack(spacing: 8) {
                    ProgressView()
                        .scaleEffect(0.8)
                    Text("SEARCHING...")
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .tracking(1)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
            } else if memory.searchResults.isEmpty {
                Text("No results for \"\(memory.searchQuery)\"")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else {
                PanelView(label: "SEARCH RESULTS", trailing: "\(memory.searchResults.count)") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(memory.searchResults) { fact in
                            factRow(fact, showScore: true)
                            if fact.id != memory.searchResults.last?.id {
                                Divider()
                                    .padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Fact Row

    private func factRow(_ fact: MemoryFact, showScore: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header: type + confidence + score
            HStack {
                Text(fact.factTypeLabel)
                    .font(.system(size: 8, weight: .medium, design: .monospaced))
                    .tracking(0.4)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 3))

                Text(fact.confidencePercent)
                    .font(.system(size: 9, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)

                Spacer()

                if showScore, let score = fact.score {
                    Text(String(format: "%.2f", score))
                        .font(.system(size: 9, weight: .regular, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                if let date = fact.date {
                    RelativeTimestamp(date: date)
                }
            }

            // Fact content
            if let factText = fact.fact {
                Text(factText)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }

            // Evidence (if present)
            if let evidence = fact.evidenceText, !evidence.isEmpty {
                Text(evidence)
                    .font(.system(size: 10, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task {
                    _ = await memory.deleteFact(fact.id, using: connection)
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "memorychip")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.tertiary)

            Text("NO MEMORY FACTS")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .tracking(1)
                .foregroundStyle(.secondary)

            if memory.selectedGuildId == nil || memory.selectedGuildId?.isEmpty == true {
                Text("Select a guild to browse memory")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            } else {
                Text("No facts stored yet")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}

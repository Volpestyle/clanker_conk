import SwiftUI

/// Compact stats summary — data-dense grid with daily cost sparkline.
/// Inspired by Alpha Arena's structured data panels.
struct StatsBar: View {
    let stats: StatsPayload?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("24H STATS")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .tracking(1.2)
                    .foregroundStyle(.secondary)

                Spacer()

                if let stats {
                    Text("ALL TIME: \(String(format: "$%.2f", stats.totalCostAllTime))")
                        .font(.system(size: 10, weight: .regular, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            // Stats grid
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 3),
                spacing: 0
            ) {
                statCell("ACTIONS", value: stats?.actionCount24h)
                statCell("VOICE", value: stats?.voiceSessionCount24h)
                statCell("LLM", value: stats?.llmCallCount24h)
                statCell("ERRORS", value: stats?.errorCount24h, highlight: (stats?.errorCount24h ?? 0) > 0)
                statCell("TOOLS", value: stats?.toolCallCount24h)
                statCell("MEMORY", value: stats?.memoryFactCount24h)
            }

            // Latency row (if available)
            if let p50 = stats?.latencyP50Ms, let p90 = stats?.latencyP90Ms {
                Divider()

                HStack(spacing: 0) {
                    latencyCell("P50", value: p50)
                    latencyCell("P90", value: p90)
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 12)
            }

            // Daily cost sparkline (if available)
            if let stats, !stats.dailyCostRows.isEmpty {
                Divider()

                DailyCostSparkline(rows: stats.dailyCostRows)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
        }
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
    }

    private func statCell(_ label: String, value: Int?, highlight: Bool = false) -> some View {
        VStack(spacing: 2) {
            Text(value.map { "\($0)" } ?? "--")
                .font(.system(size: 16, weight: .bold, design: .monospaced))
                .foregroundStyle(highlight ? .red : .primary)
                .contentTransition(.numericText())
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: value)

            Text(label)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private func latencyCell(_ label: String, value: Double) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .tracking(0.6)
                .foregroundStyle(.tertiary)

            Text("\(Int(value))ms")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Tiny sparkline showing daily cost trend (last 14 days).
struct DailyCostSparkline: View {
    let rows: [StatsPayload.StatsInfo.DailyCostRow]

    private var values: [Double] {
        rows.compactMap(\.usd).suffix(14).map { $0 }
    }

    var body: some View {
        if values.count >= 2 {
            HStack(spacing: 0) {
                Text("DAILY COST")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(.tertiary)
                    .frame(width: 70, alignment: .leading)

                GeometryReader { geo in
                    sparklinePath(in: geo.size)
                        .stroke(Color.primary.opacity(0.35), lineWidth: 1)
                }
                .frame(height: 20)
            }
        }
    }

    private func sparklinePath(in size: CGSize) -> Path {
        let maxVal = values.max() ?? 1
        let minVal = values.min() ?? 0
        let range = max(maxVal - minVal, 0.001)

        return Path { path in
            for (index, value) in values.enumerated() {
                let x = size.width * CGFloat(index) / CGFloat(max(values.count - 1, 1))
                let y = size.height * (1 - CGFloat((value - minVal) / range))
                if index == 0 {
                    path.move(to: CGPoint(x: x, y: y))
                } else {
                    path.addLine(to: CGPoint(x: x, y: y))
                }
            }
        }
    }
}

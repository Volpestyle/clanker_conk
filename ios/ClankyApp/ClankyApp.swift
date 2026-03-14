import SwiftUI

@main
struct ClankyApp: App {
    @State private var connectionStore = ConnectionStore()
    @State private var activityStore = ActivityStore()
    @State private var voiceStore = VoiceStore()
    @State private var memoryStore = MemoryStore()

    var body: some Scene {
        WindowGroup {
            if connectionStore.isConfigured && !connectionStore.requiresSetup {
                ContentView()
                    .environment(connectionStore)
                    .environment(activityStore)
                    .environment(voiceStore)
                    .environment(memoryStore)
                    .task {
                        await activityStore.connect(using: connectionStore)
                    }
                    .task {
                        await voiceStore.connect(using: connectionStore)
                    }
            } else {
                SetupView()
                    .environment(connectionStore)
            }
        }
    }
}

struct ContentView: View {
    @Environment(ConnectionStore.self) private var connection
    @Environment(ActivityStore.self) private var activity
    @Environment(VoiceStore.self) private var voice

    var body: some View {
        TabView {
            Tab("PULSE", systemImage: "bolt.fill") {
                PulseTab()
            }

            Tab("VOICE", systemImage: "waveform") {
                VoiceTab()
            }

            Tab("BRAIN", systemImage: "brain") {
                PlaceholderTab(title: "BRAIN", subtitle: "Coming Soon")
            }

            Tab("MEMORY", systemImage: "memorychip") {
                MemoryTab()
            }

            Tab("CMD", systemImage: "terminal") {
                PlaceholderTab(title: "COMMAND", subtitle: "Coming Soon")
            }
        }
        .tabViewStyle(.tabBarOnly)
    }
}

struct PlaceholderTab: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(.title2, design: .monospaced, weight: .bold))
                .tracking(2)
            Text(subtitle)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

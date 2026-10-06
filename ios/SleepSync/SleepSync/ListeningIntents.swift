import AppIntents

/// Starts night listening. Apple only lets recording begin while the app is
/// on screen, so this opens Sleep Sync first; run from a Shortcuts
/// automation ("When charger is connected"), that is one Face ID glance.
struct StartNightListeningIntent: AudioRecordingIntent {
    static let title: LocalizedStringResource = "Start Night Listening"
    static let description = IntentDescription(
        "Listens to the bedroom tonight and reports which sounds happened when. No audio is kept.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await NightListener.shared.start()
        return .result()
    }
}

/// Stops night listening and sends what was heard. Works from the background,
/// so a "When Sleep Focus turns off" automation can run it unattended.
struct StopNightListeningIntent: AppIntent {
    static let title: LocalizedStringResource = "Stop Night Listening"
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult {
        await NightListener.shared.stop()
        return .result()
    }
}

struct SleepSyncShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartNightListeningIntent(),
            phrases: ["Start night listening in \(.applicationName)"],
            shortTitle: "Start Listening",
            systemImageName: "waveform")
        AppShortcut(
            intent: StopNightListeningIntent(),
            phrases: ["Stop night listening in \(.applicationName)"],
            shortTitle: "Stop Listening",
            systemImageName: "waveform.slash")
    }
}

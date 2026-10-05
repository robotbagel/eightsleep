import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // HealthKit relaunches the app in the background to deliver new sleep
        // data; the observer has to exist again on every such launch.
        HealthSync.shared.startObserving()
        return true
    }
}

@main
struct SleepSyncApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView(sync: HealthSync.shared)
        }
        .onChange(of: phase) { _, now in
            if now == .active { Task { await HealthSync.shared.sync(reason: "opened") } }
        }
    }
}

import ActivityKit
import Foundation

/// The lock-screen Live Activity shown while Sleep Sync listens. Apple
/// requires one for as long as an app records from the background.
struct ListeningAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var soundsHeard: Int
        var lastSound: String?
    }

    var startedAt: Date
}

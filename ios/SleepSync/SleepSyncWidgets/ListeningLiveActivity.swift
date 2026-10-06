import ActivityKit
import SwiftUI
import WidgetKit

@main
struct SleepSyncWidgets: WidgetBundle {
    var body: some Widget {
        ListeningLiveActivity()
    }
}

struct ListeningLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ListeningAttributes.self) { context in
            VStack(alignment: .leading, spacing: 4) {
                Text("Listening for night sounds")
                    .font(.headline)
                Text(summary(context.state))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Since \(context.attributes.startedAt.formatted(date: .omitted, time: .shortened)). No audio is kept.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text("Listening").font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(summary(context.state)).font(.subheadline)
                }
            } compactLeading: {
                Text("Night")
            } compactTrailing: {
                Text("\(context.state.soundsHeard)")
            } minimal: {
                Text("\(context.state.soundsHeard)")
            }
        }
    }

    private func summary(_ state: ListeningAttributes.ContentState) -> String {
        if state.soundsHeard == 0 { return "Nothing heard yet" }
        let last = state.lastSound.map { ", last: \($0)" } ?? ""
        return "\(state.soundsHeard) sound\(state.soundsHeard == 1 ? "" : "s") heard\(last)"
    }
}

import SwiftUI

/// Nothing to do here day to day: the app works in the background. This
/// screen exists for the one-time Health permission and to show it is alive.
struct ContentView: View {
    @ObservedObject var sync: HealthSync
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Sleep Sync")
                .font(.title2.weight(.semibold))
            Text("Sends each night your Apple Watch records to your sleep app, in the background. There is nothing to do each day.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 4) {
                Text("Last night sent").font(.caption).foregroundStyle(.secondary)
                Text(sync.lastNight).font(.body.weight(.semibold))
                Text(sync.status).font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 8)

            if sync.needsAccess {
                Button {
                    busy = true
                    Task { await sync.requestAccess(); busy = false }
                } label: {
                    Text(busy ? "Asking…" : "Allow Health access")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            } else {
                Button {
                    busy = true
                    Task { await sync.sync(reason: "manual"); busy = false }
                } label: {
                    Text(busy ? "Sending…" : "Send now")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
            Spacer()
        }
        .padding(24)
    }
}

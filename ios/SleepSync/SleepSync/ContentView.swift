import SwiftUI

/// Nothing to do here day to day: the app works in the background. This
/// screen exists for the one-time Health permission and to show it is alive.
struct ContentView: View {
    @ObservedObject var sync: HealthSync
    @ObservedObject var listener = NightListener.shared
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
            Divider().padding(.vertical, 8)

            VStack(alignment: .leading, spacing: 8) {
                Text("Night sounds").font(.headline)
                Text("Hears cats, thuds, doors, snoring and other noises at night, and checks them against the bed's wake-ups. Only the time and type of each sound is sent, never audio.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if listener.isListening {
                    Text("Listening · \(listener.heardTonight) heard so far")
                        .font(.body.weight(.semibold))
                }
                if let error = listener.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                Button {
                    Task {
                        if listener.isListening { await listener.stop() } else { await listener.start() }
                    }
                } label: {
                    Text(listener.isListening ? "Stop listening" : "Start listening tonight")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            Spacer()
        }
        .padding(24)
    }
}

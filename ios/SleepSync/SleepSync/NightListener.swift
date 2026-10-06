import ActivityKit
import AVFoundation
import Foundation
import os
import SoundAnalysis
import UIKit

/// Listens to the bedroom at night and reports WHAT it heard and WHEN, never
/// the audio itself. Apple's on-device classifier names the sound (a cat
/// meowing, a thud, a door, snoring...), a level meter measures how far it
/// rose above the room's quiet, and every few minutes the list goes to
/// /api/soundEvents, where it is matched against the bed's wake-ups.
///
/// iOS only lets an app START recording while it is on screen; once started
/// it keeps listening with the phone locked (background audio), and a Live
/// Activity shows on the lock screen for as long as it does.
final class NightListener: NSObject, ObservableObject, SNResultsObserving, @unchecked Sendable {
    static let shared = NightListener()

    @Published var isListening = false
    @Published var heardTonight = 0
    @Published var lastError: String?

    private let endpoint = URL(string: "https://8sleep-jade.vercel.app/api/soundEvents")!
    private let engine = AVAudioEngine()
    private var analyzer: SNAudioStreamAnalyzer?
    private let analysisQueue = DispatchQueue(label: "sleepsync.night.analysis")
    private var uploadTimer: DispatchSourceTimer?
    private var activity: Activity<ListeningAttributes>?
    private var startedAt = Date()

    /// Sounds worth reporting, as the classifier names them.
    private let interesting: Set<String> = [
        "cat_meow", "cat_purr", "cat", "thump_thud", "door", "door_slam",
        "door_sliding", "knock", "snoring", "speech", "laughter", "cough",
        "dog", "dog_bark", "baby_crying", "alarm_clock", "siren", "squeak",
    ]
    private let minimumConfidence = 0.6
    /// The same kind within this many seconds is one event, not several.
    private let mergeSeconds: TimeInterval = 10
    /// Unclassified sound this far above the room's quiet is still reported.
    private let loudAboveQuietDb = 15.0
    /// Stop on its own after this long, whatever happens.
    private let maximumNight: TimeInterval = 11 * 3600

    private struct State {
        var pending: [[String: Any]] = []
        var lastByKind: [String: Date] = [:]
        var secondLevels: [Double] = []   // one dBFS value per second, last 5 min
        var currentSecond: [Float] = []
        var currentSecondStart = Date()
        var currentDb = -90.0
        var heard = 0
        var lastLabel: String?
    }
    private let state = OSAllocatedUnfairLock(initialState: State())

    private var token: String {
        (Bundle.main.object(forInfoDictionaryKey: "SleepToken") as? String) ?? ""
    }

    // MARK: Start / stop

    @MainActor
    func start() async {
        guard !isListening else { return }
        lastError = nil
        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else {
            lastError = "Microphone access is off for Sleep Sync in Settings."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            // Measurement mode turns off automatic gain, so levels mean
            // something; mixing keeps alarms and anything playing untouched.
            try session.setCategory(.playAndRecord, mode: .measurement,
                                    options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            let analyzer = SNAudioStreamAnalyzer(format: format)
            let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
            request.overlapFactor = 0.5
            try analyzer.add(request, withObserver: self)
            self.analyzer = analyzer

            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 8192, format: format) { [weak self] buffer, when in
                guard let self else { return }
                self.analysisQueue.async {
                    analyzer.analyze(buffer, atAudioFramePosition: when.sampleTime)
                    self.meter(buffer)
                }
            }
            engine.prepare()
            try engine.start()
        } catch {
            lastError = "Could not start listening: \(error.localizedDescription)"
            return
        }

        startedAt = Date()
        state.withLock { $0 = State() }
        heardTonight = 0
        isListening = true
        startActivity()
        scheduleUploads()
        NotificationCenter.default.addObserver(
            self, selector: #selector(interrupted(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
    }

    @MainActor
    func stop() async {
        guard isListening else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        analyzer?.removeAllRequests()
        analyzer = nil
        uploadTimer?.cancel()
        uploadTimer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        isListening = false
        await upload()
        let final = ListeningAttributes.ContentState(soundsHeard: heardTonight, lastSound: nil)
        await activity?.end(.init(state: final, staleDate: nil), dismissalPolicy: .immediate)
        activity = nil
    }

    /// A phone call or Siri takes the microphone; pick up again afterwards.
    @objc private func interrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        try? engine.start()
    }

    // MARK: Hearing

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        for item in result.classifications.prefix(3)
        where interesting.contains(item.identifier) && item.confidence >= minimumConfidence {
            let above = state.withLock { s -> Double in
                let quiet = Self.quiet(s.secondLevels)
                return max(0, s.currentDb - quiet)
            }
            record(kind: item.identifier, confidence: item.confidence, aboveQuiet: above, duration: 3)
            break
        }
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        Task { @MainActor in self.lastError = "Sound analysis stopped: \(error.localizedDescription)" }
    }

    /// One dBFS value per second; a second far above the room's quiet that
    /// the classifier did not name is still reported as a loud noise.
    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let rms = sqrt(sum / Float(max(count, 1)))
        let loud: Double? = state.withLock { s in
            s.currentSecond.append(rms)
            guard Date().timeIntervalSince(s.currentSecondStart) >= 1 else { return nil }
            let mean = s.currentSecond.reduce(0, +) / Float(s.currentSecond.count)
            let db = 20 * log10(Double(max(mean, 1e-9)))
            s.currentDb = db
            s.secondLevels.append(db)
            if s.secondLevels.count > 300 { s.secondLevels.removeFirst(s.secondLevels.count - 300) }
            s.currentSecond = []
            s.currentSecondStart = Date()
            let above = db - Self.quiet(s.secondLevels)
            return s.secondLevels.count >= 30 && above >= loudAboveQuietDb ? above : nil
        }
        if let loud {
            // Give the classifier a moment to name it first; a named sound
            // within the merge window suppresses this generic one.
            analysisQueue.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                let named = self.state.withLock { s in
                    s.lastByKind.contains { $0.key != "loud" && Date().timeIntervalSince($0.value) < 5 }
                }
                if !named { self.record(kind: "loud", confidence: nil, aboveQuiet: loud, duration: 1) }
            }
        }
    }

    /// The room's quiet: the 10th-percentile level of the last five minutes.
    private static func quiet(_ levels: [Double]) -> Double {
        guard !levels.isEmpty else { return -60 }
        let sorted = levels.sorted()
        return sorted[Int(Double(sorted.count - 1) * 0.1)]
    }

    private func record(kind: String, confidence: Double?, aboveQuiet: Double, duration: Int) {
        let now = Date()
        let added = state.withLock { s -> (Int, String)? in
            if let last = s.lastByKind[kind], now.timeIntervalSince(last) < mergeSeconds {
                s.lastByKind[kind] = now
                return nil
            }
            s.lastByKind[kind] = now
            var event: [String: Any] = [
                "at": ISO8601DateFormatter().string(from: now),
                "kind": kind,
                "aboveQuietDb": (aboveQuiet * 10).rounded() / 10,
                "durationS": duration,
            ]
            if let confidence { event["confidence"] = confidence }
            s.pending.append(event)
            s.heard += 1
            s.lastLabel = kind.replacingOccurrences(of: "_", with: " ")
            return (s.heard, s.lastLabel!)
        }
        guard let (heard, label) = added else { return }
        Task { @MainActor in
            self.heardTonight = heard
            await self.activity?.update(.init(
                state: .init(soundsHeard: heard, lastSound: label), staleDate: nil))
        }
    }

    // MARK: Reporting

    private func scheduleUploads() {
        let timer = DispatchSource.makeTimerSource(queue: analysisQueue)
        timer.schedule(deadline: .now() + 300, repeating: 300)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            Task {
                await self.upload()
                if Date().timeIntervalSince(self.startedAt) > self.maximumNight || Self.pastMorning() {
                    await self.stop()
                }
            }
        }
        timer.resume()
        uploadTimer = timer
    }

    /// Listening ends on its own at 10:00 if nothing else stopped it.
    private static func pastMorning() -> Bool {
        let hour = Calendar.current.component(.hour, from: Date())
        return hour >= 10 && hour < 18
    }

    private func upload() async {
        let batch = state.withLock { s -> [[String: Any]] in
            let out = s.pending
            s.pending = []
            return out
        }
        guard !batch.isEmpty, !token.isEmpty else { return }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 25
        let device = await MainActor.run { UIDeviceName.current }
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["device": device, "events": batch])
        let ok: Bool
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            ok = (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            ok = false
        }
        // Not delivered: keep them for the next round.
        if !ok { state.withLock { $0.pending.insert(contentsOf: batch, at: 0) } }
    }

    private func startActivity() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(
            attributes: ListeningAttributes(startedAt: startedAt),
            content: .init(state: .init(soundsHeard: 0, lastSound: nil), staleDate: nil))
    }
}

/// The device's name for the report, read on the main actor.
enum UIDeviceName {
    @MainActor static var current: String { UIDevice.current.name }
}

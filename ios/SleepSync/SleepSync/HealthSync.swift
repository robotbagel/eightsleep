import Foundation
import HealthKit
import os

/// Sends each new night of Apple Watch sleep to the sleep app's
/// /api/healthImport, with no daily step from the sleeper.
///
/// HealthKit wakes this app in the background whenever new sleep samples are
/// saved (background delivery), which happens when the Watch syncs after
/// waking. Health data is readable only while the phone is unlocked, so a
/// wake-up that arrives while it is locked simply finds nothing new and the
/// next delivery (or the next launch) picks the night up.
final class HealthSync: ObservableObject {
    static let shared = HealthSync()

    private let store = HKHealthStore()
    private let sleepType = HKCategoryType(.sleepAnalysis)
    private let heartRate = HKQuantityType(.heartRate)
    private let hrv = HKQuantityType(.heartRateVariabilitySDNN)
    private let breathing = HKQuantityType(.respiratoryRate)
    private let endpoint = URL(string: "https://8sleep-jade.vercel.app/api/healthImport")!

    /// How far back the first run fills in.
    private let backfillDays = 45.0
    /// Samples further apart than this belong to different nights.
    private let nightGap: TimeInterval = 4 * 3600
    /// A cluster shorter than this is a nap or noise, never sent as a night.
    private let minimumNight: TimeInterval = 3 * 3600

    @Published var status: String = "Not synced yet"
    @Published var lastNight: String = UserDefaults.standard.string(forKey: "lastNight") ?? "—"
    @Published var needsAccess = true

    private var lastUploadedEnd: Date? {
        get { UserDefaults.standard.object(forKey: "lastUploadedEnd") as? Date }
        set { UserDefaults.standard.set(newValue, forKey: "lastUploadedEnd") }
    }

    private var token: String {
        (Bundle.main.object(forInfoDictionaryKey: "SleepToken") as? String) ?? ""
    }

    // MARK: Setup

    func requestAccess() async {
        do {
            try await store.requestAuthorization(
                toShare: [], read: [sleepType, heartRate, hrv, breathing])
            await MainActor.run { needsAccess = false }
            startObserving()
            await sync(reason: "first run")
        } catch {
            await setStatus("Health access failed: \(error.localizedDescription)")
        }
    }

    /// Must run at every launch, including background launches, so HealthKit
    /// has a live observer to deliver to.
    func startObserving() {
        let query = HKObserverQuery(sampleType: sleepType, predicate: nil) { [weak self] _, done, error in
            guard let self, error == nil else { done(); return }
            Task {
                await self.sync(reason: "background")
                done()
            }
        }
        store.execute(query)
        store.enableBackgroundDelivery(for: sleepType, frequency: .immediate) { _, _ in }
        store.getRequestStatusForAuthorization(
            toShare: [], read: [sleepType, heartRate, hrv, breathing]
        ) { [weak self] status, _ in
            Task { @MainActor in self?.needsAccess = (status == .shouldRequest) }
        }
    }

    // MARK: Sync

    /// One sync at a time: a launch and a background delivery can arrive
    /// together, and two passes would post the same night twice.
    private let running = OSAllocatedUnfairLock(initialState: false)

    func sync(reason: String) async {
        let acquired = running.withLock { busy -> Bool in
            if busy { return false }
            busy = true
            return true
        }
        guard acquired else { return }
        defer { running.withLock { $0 = false } }

        guard !token.isEmpty, token != "paste-the-token-here" else {
            await setStatus("No connection token in this build")
            return
        }
        let since = lastUploadedEnd ?? Date().addingTimeInterval(-backfillDays * 86400)
        let samples: [HKCategorySample]
        do {
            samples = try await sleepSamples(from: since.addingTimeInterval(-nightGap))
        } catch {
            // Most often: the phone is locked and Health is unreadable. The
            // next delivery or launch tries again.
            await setStatus("Waiting for an unlocked phone (\(reason))")
            return
        }
        let nights = cluster(samples).filter { night in
            guard let end = night.last?.endDate else { return false }
            return end > since
        }
        if nights.isEmpty {
            await setStatus("Up to date (\(Self.stamp(Date())))")
            return
        }
        var sent = 0
        for night in nights {
            guard let start = night.first?.startDate,
                  let end = night.map(\.endDate).max() else { continue }
            if end.timeIntervalSince(start) < minimumNight { continue }
            let body = await payload(for: night, from: start, to: end)
            if await post(body) {
                sent += 1
                lastUploadedEnd = end
                let label = Self.dayLabel(end)
                UserDefaults.standard.set(label, forKey: "lastNight")
                await MainActor.run { lastNight = label }
            } else {
                await setStatus("Server unreachable; will retry")
                return
            }
        }
        await setStatus("Sent \(sent) night\(sent == 1 ? "" : "s") (\(Self.stamp(Date())))")
    }

    private func sleepSamples(from: Date) async throws -> [HKCategorySample] {
        try await withCheckedThrowingContinuation { cont in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: Date())
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(
                sampleType: sleepType, predicate: predicate,
                limit: HKObjectQueryNoLimit, sortDescriptors: [sort]
            ) { _, results, error in
                if let error { cont.resume(throwing: error); return }
                let fromWatch = (results as? [HKCategorySample] ?? []).filter {
                    // The Watch's own staging only. Other apps (the bed's own
                    // app included) also write sleep, and the server would
                    // otherwise blend two sensors into one night.
                    $0.sourceRevision.productType?.hasPrefix("Watch") == true
                }
                cont.resume(returning: fromWatch)
            }
            store.execute(query)
        }
    }

    /// Splits samples into nights at gaps longer than `nightGap`.
    private func cluster(_ samples: [HKCategorySample]) -> [[HKCategorySample]] {
        var nights: [[HKCategorySample]] = []
        var current: [HKCategorySample] = []
        var currentEnd: Date?
        for sample in samples {
            if let end = currentEnd, sample.startDate.timeIntervalSince(end) > nightGap {
                nights.append(current)
                current = []
                currentEnd = nil
            }
            current.append(sample)
            currentEnd = max(currentEnd ?? sample.endDate, sample.endDate)
        }
        if !current.isEmpty { nights.append(current) }
        return nights
    }

    private func payload(for night: [HKCategorySample], from: Date, to: Date) async -> [String: Any] {
        let iso = ISO8601DateFormatter()
        let lines = night.compactMap { sample -> String? in
            guard let stage = Self.stageName(sample.value) else { return nil }
            return "\(stage),\(iso.string(from: sample.startDate)),\(iso.string(from: sample.endDate))"
        }
        var body: [String: Any] = ["samples": lines.joined(separator: "\n")]
        if let bpm = await average(heartRate, HKUnit.count().unitDivided(by: .minute()), from, to) {
            body["avgHeartRate"] = bpm
        }
        if let ms = await average(hrv, .secondUnit(with: .milli), from, to) { body["hrv"] = ms }
        if let rr = await average(breathing, HKUnit.count().unitDivided(by: .minute()), from, to) {
            body["respiratoryRate"] = rr
        }
        return body
    }

    private func average(_ type: HKQuantityType, _ unit: HKUnit, _ from: Date, _ to: Date) async -> Double? {
        await withCheckedContinuation { cont in
            let predicate = HKQuery.predicateForSamples(withStart: from, end: to)
            let query = HKStatisticsQuery(
                quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage
            ) { _, stats, _ in
                cont.resume(returning: stats?.averageQuantity()?.doubleValue(for: unit))
            }
            store.execute(query)
        }
    }

    private func post(_ body: [String: Any]) async -> Bool {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 25
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 400 = a night the server could not use (e.g. no staged sleep).
            // Retrying it forever would block every later night, so it counts
            // as handled.
            return (200..<300).contains(code) || code == 400
        } catch {
            return false
        }
    }

    // MARK: Helpers

    private static func stageName(_ value: Int) -> String? {
        switch HKCategoryValueSleepAnalysis(rawValue: value) {
        case .asleepDeep: return "Deep"
        case .asleepREM: return "REM"
        case .asleepCore: return "Core"
        case .asleepUnspecified: return "Asleep"
        case .awake: return "Awake"
        default: return nil // inBed wraps everything; the server ignores it
        }
    }

    private static func stamp(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    private static func dayLabel(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.wide).day().month(.wide))
    }

    @MainActor private func setStatusOnMain(_ text: String) { status = text }
    private func setStatus(_ text: String) async { await setStatusOnMain(text) }
}

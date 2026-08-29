"use client";
import React, { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import fixture from "./fixture.json";
import nightsJson from "./nights.json";
import { LogoutButton } from "~/components/logout";
import { ThemeToggle } from "~/components/themeToggle";
import { AiAdvisorCard, AiSettingsCard } from "~/components/aiPanel";
import { NightSummaryCard } from "~/components/nightSummaryCard";
import { AutopilotStrip } from "~/components/autopilotStrip";
import { ComfortPrompt } from "~/components/comfortPrompt";
import { TrendsCard } from "~/components/trendsCard";
import { TemperatureProfileForm } from "~/components/temperatureProfileForm";
import { Disclosure } from "~/components/ui/card";
import LordIcon from "~/components/ui/lordIcon";
import { useSwipe } from "~/components/useSwipe";

/**
 * Dev-only harness. It renders the REAL components, seeding the tRPC cache
 * with a synthetic account rather than rebuilding the page out of static JSX —
 * a hand-built copy drifts from the app within a day and then verifies
 * nothing. All data here is generated; this repo is public.
 */

const TODAY = "2026-01-18";
type Night = (typeof nightsJson)[number] & { thermalScore: number };

function band(v: number, lo: number, hi: number, fade: number) {
  if (v >= lo && v <= hi) return 1;
  return Math.max(0, 1 - (v < lo ? lo - v : v - hi) / fade);
}
const quality = (n: (typeof nightsJson)[number]) =>
  Math.round(
    30 * band(n.deepHours / n.asleepHours, 0.15, 0.25, 0.12) +
      25 * band(n.remHours / n.asleepHours, 0.18, 0.27, 0.14) +
      25 * band(n.tosses / n.asleepHours, 0, 2.5, 3.5) +
      20 * band(n.awakeHours / (n.asleepHours + n.awakeHours), 0, 0.1, 0.18),
  );

// The newest night is DERIVED from the same fixture the hypnogram uses, so
// the hero sentence and the stage bar cannot describe different nights — the
// exact inconsistency a hand-fed harness invents.
const su = fixture.stageSummary;
const LAST: (typeof nightsJson)[number] = {
  ...nightsJson[nightsJson.length - 1]!,
  asleepHours: Math.round((su.sleepDuration / 3600) * 100) / 100,
  deepHours: Math.round((su.deepDuration / 3600) * 100) / 100,
  remHours: Math.round((su.remDuration / 3600) * 100) / 100,
  lightHours: Math.round((su.lightDuration / 3600) * 100) / 100,
  awakeHours: Math.round((su.awakeDuration / 3600) * 100) / 100,
  tosses: fixture.tnt.length,
  wakeCount: fixture.shortAwakes.length,
};
const NIGHTS: Night[] = [...nightsJson.slice(0, -1), LAST].map((n) => ({
  ...n,
  thermalScore: quality(n),
}));
const LEVELS = { initial: 17, deep: -12, mid: -4, final: 22 };
const KEYS = ["score","thermalScore","asleepHours","deepHours","remHours","awakeHours","tosses","restingHeartRate","hrv","respiratoryRate","avgBedTempC","bedtimeMinutes"] as const;

export default function PreviewClient() {
  const utils = apiR.useUtils();
  const [seeded, setSeeded] = useState(false);
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const [selectedNight, setSelectedNight] = useState<string | null>(null);

  useEffect(() => {
    const last = NIGHTS[NIGHTS.length - 1]!;
    const before = NIGHTS[NIGHTS.length - 2]!;

    utils.user.getAiSettings.setData(undefined, {
      aiEnabled: true, autoApply: true, liveTuningEnabled: true,
      displayUnit: "celsius", sleepGoal: null, maxDailyShift: 30, aiAvailable: true,
    } as never);

    utils.user.getNightTimeline.setData(undefined, {
      night: last.night, timezone: fixture.timezone,
      availableNights: NIGHTS.map((n) => n.night), events: [], metrics: last,
      session: {
        night: last.night, sessionStart: fixture.sessionStart,
        sleepStart: fixture.sleepStart, sleepEnd: fixture.sleepEnd,
        tnt: fixture.tnt, tempBedC: fixture.tempBedC, tempRoomC: fixture.tempRoomC,
        heartRate: fixture.heartRate, hrv: fixture.hrv, respiratoryRate: [],
        shortAwakes: fixture.shortAwakes, stages: fixture.stages,
        stageHours: {
          deep: Math.round((fixture.stageSummary.deepDuration / 3600) * 10) / 10,
          rem: Math.round((fixture.stageSummary.remDuration / 3600) * 10) / 10,
          light: Math.round((fixture.stageSummary.lightDuration / 3600) * 10) / 10,
          awake: Math.round((fixture.stageSummary.awakeDuration / 3600) * 10) / 10,
        },
      },
    } as never);

    const avg = (rows: Night[], key: (typeof KEYS)[number]) => {
      const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    for (const days of [7, 14, 30] as const) {
      const window = NIGHTS.slice(-days);
      const previous = NIGHTS.slice(-days * 2, -days);
      utils.user.getSleepHistory.setData({ days }, {
        days, timezone: fixture.timezone, from: window[0]!.night, to: TODAY,
        nights: window, previousNights: previous,
        aggregates: KEYS.map((key) => {
          const values = window.map((n) => n[key]).filter((v): v is number => typeof v === "number");
          return {
            key, average: avg(window, key),
            best: values.length ? Math.max(...values) : null,
            worst: values.length ? Math.min(...values) : null,
            nights: values.length, previousAverage: avg(previous, key),
          };
        }),
        weekday: {
          score: [66, 72, 68, 80, 77, 62, 67],
          asleepHours: Array(7).fill(null) as (number | null)[],
          deepHours: Array(7).fill(null) as (number | null)[],
        },
      } as never);
    }

    utils.user.getNightOutlook.setData(undefined, {
      timezone: fixture.timezone, todayKey: TODAY,
      nightBefore: before, lastNight: last,
      tonight: {
        night: "2026-01-19", planned: true, status: "auto_applied", confidence: "high",
        forecast: { expectedScoreLow: 78, expectedScoreHigh: 88, expectedDeepHours: 1.35, expectedTosses: 13 },
        expectation: "Fewer than six tosses before 01:00 and at least 15 minutes more deep sleep.",
      },
      accuracy: { night: last.night, low: 74, high: 84, actual: last.thermalScore, hit: true },
    } as never);

    utils.user.getTemperaturePlan.setData({ days: 7 }, {
      timezone: fixture.timezone, bedTime: "23:00", wakeupTime: "07:10",
      todayKey: TODAY, tonight: LEVELS,
      lastNight: { night: "2026-01-17", initial: 17, deep: -12, mid: -4, final: 28 },
      proposed: null,
      latest: { id: 1, forDate: TODAY, status: "auto_applied", confidence: "high", updatedAt: new Date("2026-01-18T07:12:00Z") },
      assessedToday: true,
      experiments: [
        { profile: { initial: 17, deep: -12, mid: -4, final: 28 }, nights: ["2026-01-16", "2026-01-17"], meanThermal: 88, best: true, current: false },
        { profile: LEVELS, nights: ["2026-01-18"], meanThermal: 82, best: false, current: true },
      ],
      livePressure: [{ stage: "final", meanOffsetC: -1, nights: 2 }],
      history: NIGHTS.slice(-7).map((n, i) => ({
        night: n.night, initial: 17, deep: -12, mid: -4,
        final: i > 4 ? 22 : 28, aiChanged: i === 5, aiStatus: "auto_applied", liveNudges: 0,
      })),
    } as never);

    utils.user.getAiRecommendations.setData(undefined, [{
      id: 1, forDate: TODAY, status: "auto_applied", confidence: "high",
      previousInitialLevel: 17, previousDeepLevel: -12, previousMidLevel: -4, previousFinalLevel: 28,
      recommendedInitialLevel: 17, recommendedDeepLevel: -12, recommendedMidLevel: -4, recommendedFinalLevel: 22,
      reasoning: "Live tuning had to cool the REM and wake-up stage on 2 of the last 3 nights, by 1.0°C on average. A correction that repeats every night is the base setting being wrong, not a bad night, so it moves into the schedule itself.",
      rationale: {
        perStage: [
          { stage: "final", direction: "cooler", why: "Corrected by live tuning on 2 of the last 3 nights, always in the same direction." },
          { stage: "initial", direction: "unchanged", why: "Left alone so the REM change can be measured on its own." },
          { stage: "deep", direction: "unchanged", why: "Left alone so the REM change can be measured on its own." },
          { stage: "mid", direction: "unchanged", why: "Left alone so the REM change can be measured on its own." },
        ],
        evidence: ["Live tuning corrected the REM stage on 2 of the last 3 nights.", "Average correction −1.0°C, always the same direction."],
        expectation: "Live tuning should need to correct the REM stage less tonight, or not at all.",
        principle: "When a fast correction has to be made every night, the slow setting underneath it is wrong.",
        forecast: { expectedScoreLow: 78, expectedScoreHigh: 88 },
      },
      outcome: { before: 74, after: 82, delta: 8 },
    }] as never);

    utils.user.getSleepFeedback.setData(undefined, {
      night: TODAY, answered: false, askable: true, recent: [],
    } as never);
    utils.user.getLiveAdjustments.setData(undefined, [] as never);
    utils.user.getPushPublicKey.setData(undefined, { publicKey: "" } as never);
    setSeeded(true);
  }, [utils]);

  const dates = NIGHTS.map((n) => n.night);
  const position = dates.indexOf(selectedNight ?? dates[dates.length - 1]!);
  const goPrev = () => setSelectedNight(dates[Math.max(0, position - 1)]!);
  const goNext = () => setSelectedNight(dates[Math.min(dates.length - 1, position + 1)]!);
  const swipe = useSwipe({
    onPrev: goPrev, onNext: goNext,
    canPrev: position > 0, canNext: position < dates.length - 1,
  });
  const nav = {
    night: dates[position] ?? null,
    isLatest: position === dates.length - 1,
    canPrev: position > 0,
    canNext: position < dates.length - 1,
    onPrev: goPrev, onNext: goNext, onLatest: () => setSelectedNight(null),
  };

  if (!seeded) return null;

  return (
    <main className="min-h-screen pb-16">
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: "var(--border)", backgroundColor: "color-mix(in srgb, var(--bg) 82%, transparent)" }}
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <span id="pv-brand" className="flex items-center gap-2">
            <LordIcon name="moon" size={22} trigger="hover" target="#pv-brand" color="var(--accent)" colorSecondary="var(--text-muted)" />
            <span className="text-base font-semibold tracking-tight" style={{ color: "var(--text-headline)" }}>Sleep</span>
            <span className="chip" style={{ backgroundColor: "var(--warning-soft)", color: "var(--warning)" }}>preview</span>
          </span>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <LogoutButton onLogoutSuccess={() => undefined} />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 pt-5">
        <div className="space-y-4">
          <div className="min-w-0" style={{ touchAction: "pan-y" }} {...swipe.bind}>
            <div
              className="min-w-0"
              style={{
                transform: swipe.dx !== 0 ? `translateX(${swipe.dx}px)` : undefined,
                transition: swipe.dragging ? "none" : "transform var(--motion-base) cubic-bezier(0.2, 0.9, 0.3, 1)",
              }}
            >
              <NightSummaryCard night={selectedNight} nav={nav} index={0} />
            </div>
          </div>

          <ComfortPrompt index={1} />

          <AutopilotStrip displayUnit="celsius" expanded={autopilotOpen} onOpen={() => setAutopilotOpen((o) => !o)} />

          <div
            className="grid transition-[grid-template-rows] duration-base ease-snap"
            style={{ gridTemplateRows: autopilotOpen ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              {autopilotOpen && <AiAdvisorCard displayUnit="celsius" index={0} />}
            </div>
          </div>

          <TrendsCard displayUnit="celsius" night={selectedNight} index={2} />

          <Disclosure icon="bed" title="Tonight's schedule" summary="Bed time, wake-up, and the four stage temperatures." index={3}>
            <TemperatureProfileForm />
          </Disclosure>

          <AiSettingsCard index={4} />
        </div>
      </div>
    </main>
  );
}

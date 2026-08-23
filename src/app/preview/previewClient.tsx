"use client";
import React, { useState } from "react";
import fixture from "./fixture.json";
import { Card, CardHeader, Disclosure, Tile, Skeleton } from "~/components/ui/card";
import { ConfirmDialog } from "~/components/ui/confirmDialog";
import LordIcon from "~/components/ui/lordIcon";
import { ThemeToggle } from "~/components/themeToggle";
import { ScoreRing } from "~/components/charts/scoreRing";
import { StageBar } from "~/components/charts/stageBar";
import { Sparkline } from "~/components/charts/sparkline";
import { NightChart, type NightEvent } from "~/components/charts/nightChart";
import { TrendChart } from "~/components/charts/trendChart";
import { StageChangeChart } from "~/components/charts/stageChangeChart";
import { TemperatureCurve } from "~/components/temperatureCurve";
import { clockIn, formatHours, type Point } from "~/components/charts/chartUtils";

const ms = (value: string) => new Date(value).getTime();
const series = (rows: [string, number][]): Point[] =>
  rows.map(([t, v]) => [ms(t), v]);

// Sample week — generated, like the fixture, so no real health data lives in
// this repo.
const NIGHTS = [
  { date: "2026-01-12", score: 76, sleepDurationHours: 7.1, restingHeartRate: 50, hrv: 58 },
  { date: "2026-01-13", score: 82, sleepDurationHours: 7.8, restingHeartRate: 48, hrv: 66 },
  { date: "2026-01-14", score: 71, sleepDurationHours: 6.7, restingHeartRate: 52, hrv: 54 },
  { date: "2026-01-15", score: 64, sleepDurationHours: 6.1, restingHeartRate: 54, hrv: 47 },
  { date: "2026-01-16", score: 79, sleepDurationHours: 7.5, restingHeartRate: 49, hrv: 62 },
  { date: "2026-01-17", score: 74, sleepDurationHours: 7.0, restingHeartRate: 50, hrv: 59 },
  { date: "2026-01-18", score: 68, sleepDurationHours: 6.0, restingHeartRate: 51, hrv: 55 },
];

const EVENTS: NightEvent[] = [
  { at: ms("2026-01-17T21:05:00.000Z"), label: "Pre-heating → 30.0°C", detail: "Scheduled stage change", source: "schedule" },
  { at: ms("2026-01-17T22:05:00.000Z"), label: "Initial → 29.0°C", detail: "Scheduled stage change", source: "schedule" },
  { at: ms("2026-01-17T23:05:00.000Z"), label: "Deep → 26.5°C", detail: "Scheduled stage change", source: "schedule" },
  { at: ms("2026-01-18T01:12:00.000Z"), label: "Deep → 26.0°C", detail: "Tossing cluster with a raised heart rate", source: "live" },
  { at: ms("2026-01-18T01:05:00.000Z"), label: "Mid → 27.0°C", detail: "Scheduled stage change", source: "schedule" },
  { at: ms("2026-01-18T03:05:00.000Z"), label: "Final → 29.0°C", detail: "Scheduled stage change", source: "schedule" },
  { at: ms("2026-01-18T05:45:00.000Z"), label: "Wake-up → off", detail: "Scheduled off", source: "off" },
];

export default function PreviewClient() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const summary = fixture.stageSummary;
  const stageHours = {
    deep: Math.round((summary.deepDuration / 3600) * 10) / 10,
    rem: Math.round((summary.remDuration / 3600) * 10) / 10,
    light: Math.round((summary.lightDuration / 3600) * 10) / 10,
    awake: Math.round((summary.awakeDuration / 3600) * 10) / 10,
  };
  const asleep = summary.sleepDuration / 3600;
  const bed = series(fixture.tempBedC as [string, number][]);
  const room = series(fixture.tempRoomC as [string, number][]);
  const hrv = series(fixture.hrv as [string, number][]);
  const tosses = (fixture.tnt as [string, number][]).map(([t]) => ms(t));

  const toEpoch = (date: string) => new Date(`${date}T12:00:00Z`).getTime();

  return (
    <main className="min-h-screen pb-16">
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "color-mix(in srgb, var(--bg) 82%, transparent)",
        }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <span id="pv-brand" className="flex items-center gap-2">
            <LordIcon
              name="moon"
              size={22}
              trigger="hover"
              target="#pv-brand"
              color="var(--accent)"
              colorSecondary="var(--text-muted)"
            />
            <span
              className="text-base font-semibold tracking-tight"
              style={{ color: "var(--text-headline)" }}
            >
              Sleep
            </span>
            <span className="chip" style={{ backgroundColor: "var(--warning-soft)", color: "var(--warning)" }}>
              preview
            </span>
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pt-5">
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {/* ---- Last night ------------------------------------------- */}
          <div className="space-y-4 lg:col-span-2">
            <Card index={0}>
              <CardHeader
                icon="sleep"
                title="Last night"
                subtitle="Sunday, 18 January"
                right={
                  <span className="chip" style={{ backgroundColor: "var(--warning-soft)", color: "var(--warning)" }}>
                    Decent night
                  </span>
                }
              />
              <div className="flex flex-col items-center gap-5 sm:flex-row">
                <ScoreRing score={68} />
                <div className="w-full flex-1">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="tabular text-4xl font-semibold leading-none"
                      style={{ color: "var(--text-headline)" }}
                    >
                      {formatHours(asleep)}
                    </span>
                    <span className="text-sm" style={{ color: "var(--text-muted)" }}>
                      asleep
                    </span>
                  </div>
                  <div className="mt-4">
                    <StageBar stageHours={stageHours} />
                  </div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile icon="heart" label="Resting HR" color="var(--danger)" value={<>51<span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>bpm</span></>}>
                  <Sparkline
                    series={NIGHTS.map((n) => [toEpoch(n.date), n.restingHeartRate] as Point)}
                    color="var(--danger)"
                  />
                </Tile>
                <Tile icon="chart" label="HRV" color="var(--accent)" value={<>55<span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>ms</span></>}>
                  <Sparkline
                    series={NIGHTS.map((n) => [toEpoch(n.date), n.hrv] as Point)}
                    color="var(--accent)"
                  />
                </Tile>
                <Tile icon="lungs" label="Breathing" color="var(--cool)" value={<>15.5<span className="ml-1 text-xs font-normal" style={{ color: "var(--text-faint)" }}>/min</span></>}>
                  <Sparkline series={hrv.slice(0, 30)} color="var(--cool)" />
                </Tile>
                <Tile icon="bed" label="Tosses" color="var(--stage-awake)" value={tosses.length} sub="8 / 7 / 6 by third" />
              </div>
            </Card>

            {/* ---- The night itself ---------------------------------- */}
            <Card index={1}>
              <CardHeader icon="clock" title="Your night, hour by hour" subtitle="Sunday, 18 January" />
              <div className="mb-4 grid grid-cols-3 gap-2">
                <Tile
                  label="In bed"
                  value={formatHours((ms(fixture.sleepEnd) - ms(fixture.sleepStart)) / 3_600_000)}
                  sub={`${clockIn(ms(fixture.sleepStart), fixture.timezone)} → ${clockIn(ms(fixture.sleepEnd), fixture.timezone)}`}
                />
                <Tile
                  label="Bed temp"
                  icon="thermometer"
                  color="var(--warm)"
                  value={`${Math.min(...bed.map(([, v]) => v)).toFixed(0)}–${Math.max(...bed.map(([, v]) => v)).toFixed(0)}°C`}
                  sub="range across the night"
                />
                <Tile label="AI nudges" icon="ai" value={1} sub="mid-night changes" />
              </div>
              <NightChart
                timezone={fixture.timezone}
                sessionStart={ms(fixture.sessionStart)}
                sleepStart={ms(fixture.sleepStart)}
                sleepEnd={ms(fixture.sleepEnd)}
                stages={fixture.stages}
                bed={bed}
                room={room}
                tosses={tosses}
                events={EVENTS}
              />
            </Card>
          </div>

          {/* ---- Trend ------------------------------------------------ */}
          <Card index={2}>
            <CardHeader icon="chart" title="Recent nights" subtitle="Best so far: 82 on 13 Jan" />
            <TrendChart nights={NIGHTS} />
          </Card>

          {/* ---- Advisor ---------------------------------------------- */}
          <Card index={3}>
            <CardHeader
              icon="ai"
              title="AI autopilot"
              subtitle="Tonight&apos;s plan, decided 18 Jan"
              right={
                <div className="flex flex-wrap justify-end gap-1.5">
                  <span className="chip" style={{ backgroundColor: "var(--success-soft)", color: "var(--success)" }}>
                    high confidence
                  </span>
                  <span className="chip" style={{ backgroundColor: "var(--success-soft)", color: "var(--success)" }}>
                    Auto-applied
                  </span>
                </div>
              }
            />
            <StageChangeChart
              unit="celsius"
              changes={[
                { label: "Falling asleep", previous: 17, recommended: 11 },
                { label: "Deep sleep", previous: -8, recommended: -17 },
                { label: "Middle of the night", previous: 0, recommended: 0 },
                { label: "REM and wake-up", previous: 11, recommended: 17 },
              ]}
            />
            <p
              className="mt-4 rounded-xl p-3 text-sm leading-relaxed"
              style={{ backgroundColor: "var(--surface-sunken)", color: "var(--text)" }}
            >
              You tossed nine times in the first third and your heart rate stayed
              above your weekly resting line until 01:00, both signs the bed was
              too warm going in. Deep sleep drops a full degree tonight and the
              wake-up stage warms to protect the REM block that ended your night.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn btn-primary flex-1">
                Apply tonight
              </button>
              <button type="button" className="btn btn-secondary">
                Keep as is
              </button>
            </div>
            <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
              <div className="card-title mb-2">Live nudges</div>
              <ul className="space-y-1">
                <li className="flex items-start gap-3 rounded-lg px-2 py-1.5">
                  <span className="tabular w-11 shrink-0 pt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
                    03:12
                  </span>
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: "var(--warm)" }} />
                  <span className="flex-1">
                    <span className="block text-sm font-medium" style={{ color: "var(--text-headline)" }}>
                      deep stage
                    </span>
                    <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
                      Four tosses in twenty minutes with heart rate 6 bpm above
                      the night average — cooled by 0.5°C.
                    </span>
                  </span>
                </li>
              </ul>
            </div>
          </Card>

          {/* ---- Disclosures & primitives ------------------------------ */}
          <div className="space-y-4 lg:col-span-2">
            <Disclosure
              icon="bed"
              title="Tonight's schedule"
              summary="Bed time, wake-up, and the four stage temperatures."
              defaultOpen
              index={4}
            >
              <div className="space-y-4">
                <TemperatureCurve
                  bedTime="23:00"
                  wakeupTime="07:10"
                  temps={{ initial: 29, deep: 26, mid: 27, final: 29.5 }}
                  displayUnit="celsius"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium" style={{ color: "var(--text-headline)" }} htmlFor="pv-time">
                      Bed time
                    </label>
                    <input id="pv-time" type="time" defaultValue="23:00" className="field tabular" />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium" style={{ color: "var(--text-headline)" }} htmlFor="pv-slider">
                      Deep sleep
                    </label>
                    <input id="pv-slider" type="range" min="13" max="44" step="0.5" defaultValue="26" className="slider" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-primary flex-1">Save schedule</button>
                  <button type="button" className="btn btn-danger" onClick={() => setConfirmOpen(true)}>
                    Delete schedule
                  </button>
                </div>
              </div>
            </Disclosure>

            <Disclosure icon="sliders" title="Autopilot settings" summary="Autopilot on · auto-applies · live tuning on" index={5}>
              <div className="space-y-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-10 w-2/3" />
                <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                  (Settings controls need a live session; the skeletons above are
                  the loading state they replace.)
                </p>
              </div>
            </Disclosure>
          </div>
        </div>

        <ConfirmDialog
          open={confirmOpen}
          title="Delete your temperature schedule?"
          body="The pod stops changing temperature on its own tonight, and the AI has no stages left to tune. You can create a new schedule at any time."
          confirmLabel="Delete schedule"
          cancelLabel="Keep my schedule"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
        />
      </div>
    </main>
  );
}

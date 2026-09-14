"use client";

// What a guest gets: set up their whole night before they get into it, and
// read what the bed measured about them afterwards.
//
// The first version was two buttons, warmer and cooler, against a bed that is
// off all afternoon — useless to someone who arrives at four and wants to be
// comfortable at midnight. So the four stages come first and the live nudge
// is secondary, and the morning reading is the same one the owner gets,
// because finding out what the bed knows about you is the best reason to
// want one.
//
// Everything here is scoped server-side: this page cannot request the
// owner's nights, whatever it asks for.

import React, { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import { buildVerdict } from "~/lib/verdict";

/** One press moves a stage by this much — the loop's own step. */
const STEP_C = 0.5;

const STAGES = [
  ["initial", "Falling asleep", "The first hour. Mild warmth helps you drop off; too warm and you lie there."],
  ["deep", "Deep sleep", "One to three hours in. The coolest stretch — this is when deep sleep consolidates."],
  ["mid", "Middle of the night", "Your body is at its natural low. Too warm here is what fragments a night."],
  ["final", "REM and waking", "The last two hours. Gentle warmth protects REM and makes waking easier."],
] as const;

type StageKey = (typeof STAGES)[number][0];

export const GuestClient: React.FC<{ token: string }> = ({ token }) => {
  const utils = apiR.useUtils();
  const view = apiR.share.view.useQuery({ token }, { retry: false });
  const nights = apiR.share.nights.useQuery({ token }, { retry: false });

  const [stages, setStages] = useState<Record<StageKey, number> | null>(null);
  const [bedTime, setBedTime] = useState("");
  const [wakeupTime, setWakeupTime] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  // Start from whatever the link already controls, so nothing has to be
  // guessed or corrected.
  useEffect(() => {
    if (view.isSuccess && !dirty && view.data) {
      setStages({ ...view.data.stages });
      setBedTime(view.data.bedTime);
      setWakeupTime(view.data.wakeupTime);
    }
  }, [view.isSuccess, view.data, dirty]);

  const save = apiR.share.setStages.useMutation({
    onSuccess: async () => {
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await utils.share.view.invalidate();
    },
  });
  const nudge = apiR.share.setTemperature.useMutation({
    onSettled: async () => {
      await utils.share.view.invalidate();
    },
  });
  const comfort = apiR.share.comfort.useMutation({
    onSuccess: (r) => setSaid(r.message),
  });

  if (view.isLoading) {
    return (
      <Shell>
        <p style={{ color: "var(--text-muted)" }}>Opening…</p>
      </Shell>
    );
  }
  if (view.isError) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-headline)" }}>
          This link is not working
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
          {view.error.message}
        </p>
      </Shell>
    );
  }

  const data = view.data;
  if (!data || !stages) {
    return (
      <Shell>
        <p style={{ color: "var(--text-muted)" }}>Opening…</p>
      </Shell>
    );
  }

  // What the top control reads and writes.
  //
  // While the bed is RUNNING that is the pod itself, live. While it is OFF —
  // which is how a guest arriving in the afternoon finds it — a "current
  // temperature" read back from the pod is meaningless (the hardware reports
  // its neutral level and it looks like a real setting), so the control
  // reads what the night will START at and a press shifts THE WHOLE NIGHT by
  // half a degree, keeping its shape. That matches how the system already
  // treats an unscoped "too warm": a person who has not named a stage means
  // all of them.
  const clamp = (v: number) =>
    Math.min(data.maxC, Math.max(data.minC, Math.round(v * 2) / 2));
  const liveValue = data.isHeating ? (data.currentC ?? stages.initial) : stages.initial;
  const busy = nudge.isPending || save.isPending;

  const shift = (delta: number) => {
    if (data.isHeating) {
      const next = Math.min(
        data.maxC,
        Math.max(data.minC, Math.round((liveValue + delta) * 2) / 2),
      );
      nudge.mutate({ token, celsius: next });
      return;
    }
    const shifted = {
      initial: clamp(stages.initial + delta),
      deep: clamp(stages.deep + delta),
      mid: clamp(stages.mid + delta),
      final: clamp(stages.final + delta),
    };
    setStages(shifted);
    save.mutate({ token, bedTime, wakeupTime, ...shifted });
  };

  const move = (key: StageKey, delta: number) => {
    setStages((prev) =>
      prev == null
        ? prev
        : {
            ...prev,
            [key]: Math.min(
              data.maxC,
              Math.max(data.minC, Math.round((prev[key] + delta) * 2) / 2),
            ),
          },
    );
    setDirty(true);
  };

  const canSetStages = data.capabilities.setStayProfile || data.capabilities.editOwnerSchedule;

  return (
    <Shell>
      <header>
        <h1 className="text-2xl font-semibold tracking-[-0.02em]" style={{ color: "var(--text-headline)" }}>
          {data.label ? `Hello, ${data.label}` : "Your side of the bed"}
        </h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
          Set your night up however you like. It is your own setting — it does
          not change anybody else&apos;s.
        </p>
      </header>

      {/* FIRST, always. Someone opening this link is either lying in the bed
          wanting it changed now, or standing in the room wanting to know what
          it will do tonight. Either way it is the first question, so it goes
          above the setup rather than below it. */}
      <section
        className="mt-5 rounded-2xl p-5"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--border)" }}
      >
        <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          {data.isHeating ? "Too warm? Too cold?" : "Tonight starts at"}
        </p>
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
          {data.isHeating
            ? "Half a degree either way, right now."
            : `The bed is off. It warms up before your ${bedTime} bedtime — press to change how warm.`}
        </p>

        <div className="mt-4 flex items-center justify-center gap-4">
          <StepButton
            direction="cooler"
            disabled={busy}
            onPress={() => shift(-STEP_C)}
          />
          <div className="min-w-[6.5rem] text-center">
            <span
              key={liveValue}
              className="tabular block text-4xl font-semibold"
              style={{
                color: "var(--text-headline)",
                animation: "rise var(--motion-fast) var(--ease-out-snap) both",
              }}
            >
              {liveValue.toFixed(1)}°
            </span>
            <span className="text-xs" style={{ color: "var(--text-faint)" }}>
              {data.isHeating ? "running now" : "when it starts"}
            </span>
          </div>
          <StepButton
            direction="warmer"
            disabled={busy}
            onPress={() => shift(STEP_C)}
          />
        </div>

        {data.capabilities.giveComfortFeedback && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {(
              [
                ["too_hot", "Too hot"],
                ["just_right", "Just right"],
                ["too_cold", "Too cold"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={comfort.isPending}
                onClick={() => comfort.mutate({ token, felt: value, whenFelt: "not_sure" })}
                className="btn btn-secondary"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {said && (
          <p className="mt-2 text-center text-xs" style={{ color: "var(--success)" }}>
            {said}
          </p>
        )}
        {(nudge.isError || save.isError) && (
          <p className="mt-2 text-center text-xs" style={{ color: "var(--danger)" }}>
            {(nudge.error ?? save.error)?.message}
          </p>
        )}
      </section>

      {canSetStages && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            Your night
          </h2>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            The bed changes temperature through the night. You can set each part.
          </p>

          <div className="mt-3 flex gap-3">
            <TimeField id="bed" label="Bedtime" value={bedTime} onChange={(v) => { setBedTime(v); setDirty(true); }} />
            <TimeField id="wake" label="Alarm" value={wakeupTime} onChange={(v) => { setWakeupTime(v); setDirty(true); }} />
          </div>

          <ul className="mt-4 space-y-2">
            {STAGES.map(([key, label, why]) => (
              <li
                key={key}
                className="rounded-xl p-3"
                style={{ background: "var(--surface-raised)", border: "1px solid var(--border)" }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
                      {label}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
                      {why}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label={`Cooler: ${label}`}
                      onClick={() => move(key, -STEP_C)}
                      className="btn btn-secondary"
                    >
                      −
                    </button>
                    <span
                      className="tabular w-16 text-center text-base font-semibold"
                      style={{ color: "var(--text-headline)" }}
                    >
                      {stages[key].toFixed(1)}°
                    </span>
                    <button
                      type="button"
                      aria-label={`Warmer: ${label}`}
                      onClick={() => move(key, STEP_C)}
                      className="btn btn-secondary"
                    >
                      +
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({
                  token,
                  bedTime,
                  wakeupTime,
                  initial: stages.initial,
                  deep: stages.deep,
                  mid: stages.mid,
                  final: stages.final,
                })
              }
              className="btn btn-primary"
            >
              {save.isPending ? "Saving…" : "Save my night"}
            </button>
            {saved && (
              <span className="text-sm" style={{ color: "var(--success)" }}>
                Saved
              </span>
            )}
            {save.isError && (
              <span className="text-sm" style={{ color: "var(--danger)" }}>
                {save.error.message}
              </span>
            )}
          </div>
        </section>
      )}

      <NightsRead nights={nights.data?.nights ?? []} loading={nights.isLoading} />

      <footer className="mt-8 text-xs" style={{ color: "var(--text-faint)" }}>
        {data.expiresAt
          ? `This link stops working on ${new Date(data.expiresAt).toLocaleDateString()}.`
          : "This link does not expire."}
      </footer>
    </Shell>
  );
};

/**
 * The morning reading — the same numbers and the same plain-language verdict
 * the owner sees about their own night. A guest's night is worth showing
 * back to them in full: it is the whole reason somebody would want one of
 * these beds after a weekend in a spare room.
 */
const NightsRead: React.FC<{
  nights: {
    night: string;
    score: number | null;
    quality: number | null;
    asleepHours: number | null;
    deepHours: number | null;
    remHours: number | null;
    lightHours: number | null;
    awakeHours: number | null;
    latencyMinutes: number | null;
    tosses: number | null;
    wakeCount: number | null;
    restingHeartRate: number | null;
    hrv: number | null;
    respiratoryRate: number | null;
    avgBedTempC: number | null;
    avgRoomTempC: number | null;
    bedtimeMinutes: number | null;
    wakeMinutes: number | null;
  }[];
  loading: boolean;
}> = ({ nights, loading }) => {
  if (loading) return null;

  if (nights.length === 0) {
    return (
      <section className="mt-6">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
          Your sleep
        </h2>
        <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          After your first night here, this is where you will see how you
          slept: how long, how much deep sleep and REM, how often you stirred,
          your heart rate and breathing through the night.
        </p>
      </section>
    );
  }

  const latest = nights[0]!;
  const rest = nights.slice(1);
  const average = (key: "asleepHours" | "deepHours" | "tosses") => {
    const values = rest
      .map((n) => n[key])
      .filter((v): v is number => typeof v === "number");
    return values.length === 0
      ? null
      : values.reduce((a, b) => a + b, 0) / values.length;
  };
  const verdict = buildVerdict({
    asleepHours: latest.asleepHours,
    deepHours: latest.deepHours,
    remHours: latest.remHours,
    tosses: latest.tosses,
    wakeCount: latest.wakeCount,
    thermalScore: latest.quality,
    average: {
      asleepHours: average("asleepHours"),
      deepHours: average("deepHours"),
      tosses: average("tosses"),
    },
  });

  const TONE: Record<string, string> = {
    good: "var(--success)",
    warn: "var(--warning)",
    bad: "var(--danger)",
    none: "var(--text-faint)",
  };

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
        Your sleep
      </h2>

      <div
        className="mt-2 rounded-xl p-4"
        style={{ background: "var(--surface-raised)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-baseline gap-3">
          <span className="tabular text-4xl font-semibold" style={{ color: "var(--text-headline)" }}>
            {latest.score ?? "—"}
          </span>
          <span className="text-xs" style={{ color: "var(--text-faint)" }}>
            out of 100
          </span>
        </div>
        <p className="mt-2 text-base font-semibold" style={{ color: TONE[verdict.tone] }}>
          {verdict.headline}
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--text)" }}>
          {verdict.detail}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <Fact label="Asleep" value={hours(latest.asleepHours)} />
          <Fact label="Deep sleep" value={hours(latest.deepHours)} />
          <Fact label="REM" value={hours(latest.remHours)} />
          <Fact label="Light" value={hours(latest.lightHours)} />
          <Fact label="Awake in bed" value={hours(latest.awakeHours)} />
          <Fact
            label="Time to fall asleep"
            value={latest.latencyMinutes == null ? "—" : `${latest.latencyMinutes}m`}
          />
          <Fact label="Turned over" value={latest.tosses == null ? "—" : `${latest.tosses}×`} />
          <Fact
            label="Brief wake-ups"
            value={latest.wakeCount == null ? "—" : `${latest.wakeCount}`}
          />
          <Fact
            label="Resting heart rate"
            value={latest.restingHeartRate == null ? "—" : `${Math.round(latest.restingHeartRate)} bpm`}
          />
          <Fact label="HRV" value={latest.hrv == null ? "—" : `${Math.round(latest.hrv)} ms`} />
          <Fact
            label="Breathing"
            value={latest.respiratoryRate == null ? "—" : `${latest.respiratoryRate.toFixed(1)}/min`}
          />
          <Fact
            label="Bed temperature"
            value={latest.avgBedTempC == null ? "—" : `${latest.avgBedTempC.toFixed(1)}°`}
          />
        </dl>
      </div>

      {rest.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rest.map((n) => (
            <li
              key={n.night}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
              style={{ background: "var(--surface)" }}
            >
              <span style={{ color: "var(--text-muted)" }}>
                {new Date(`${n.night}T12:00:00Z`).toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </span>
              <span className="tabular" style={{ color: "var(--text)" }}>
                {n.score ?? "—"} · {hours(n.asleepHours)} · {hours(n.deepHours)} deep
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>
        Measured by the bed itself: it senses movement, heart rate and
        breathing through the mattress, with nothing worn.
      </p>
    </section>
  );
};

function hours(value: number | null): string {
  if (value == null) return "—";
  const total = Math.round(value * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt className="text-xs" style={{ color: "var(--text-faint)" }}>
      {label}
    </dt>
    <dd className="tabular text-sm font-medium" style={{ color: "var(--text)" }}>
      {value}
    </dd>
  </div>
);

const TimeField: React.FC<{
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ id, label, value, onChange }) => (
  <div className="flex-1">
    <label htmlFor={id} className="block text-xs" style={{ color: "var(--text-muted)" }}>
      {label}
    </label>
    <input
      id={id}
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="field mt-1 w-full"
    />
  </div>
);

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <main className="mx-auto min-h-screen w-full max-w-md px-5 py-10">{children}</main>
);

/**
 * Large on purpose: pressed in the dark, one-handed, by someone who is a
 * visitor in an unfamiliar room. 56px clears the 44px minimum with room for
 * a missed tap. All five interaction states come from `.btn`.
 */
const StepButton: React.FC<{
  direction: "cooler" | "warmer";
  disabled: boolean;
  onPress: () => void;
}> = ({ direction, disabled, onPress }) => (
  <button
    type="button"
    onClick={onPress}
    disabled={disabled}
    aria-label={direction === "cooler" ? "Half a degree cooler" : "Half a degree warmer"}
    className="btn btn-secondary h-14 w-14 shrink-0 text-2xl"
    style={{
      color: direction === "cooler" ? "var(--cool)" : "var(--warm)",
      borderColor: direction === "cooler" ? "var(--cool)" : "var(--warm)",
    }}
  >
    {direction === "cooler" ? "−" : "+"}
  </button>
);

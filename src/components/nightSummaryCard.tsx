"use client";
import React from "react";
import { apiR, type RouterOutputs } from "~/trpc/react";
import { Card, Skeleton } from "./ui/card";
import { NightNav } from "./nightNav";
import { ScoreRing } from "./charts/scoreRing";
import { StageBar } from "./charts/stageBar";
import { formatHours, scoreTone, TONE_VAR } from "./charts/chartUtils";
import LordIcon from "./ui/lordIcon";
import { useNightInsight } from "./useNightInsight";
import { type Contributor } from "~/lib/insights";
import { soundCountsText, soundLabel } from "~/lib/soundLabels";

function clockOf(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const NightSummaryCard: React.FC<{
  night: string | null;
  nav: React.ComponentProps<typeof NightNav>;
  index?: number;
}> = ({ night, nav, index = 0 }) => {
  const { timeline: query, metrics, insight } = useNightInsight(night);
  const stageHours = query.data?.session?.stageHours ?? {};

  if (query.isLoading) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <div className="mt-5 space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="mt-5 flex items-center justify-between gap-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-[112px] w-[112px] rounded-full" />
        </div>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <p className="mt-4 text-sm" style={{ color: "var(--text-muted)" }}>
          Eight Sleep did not return this night just now.
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="btn btn-secondary mt-3"
        >
          Try again
        </button>
      </Card>
    );
  }

  if (!metrics || !insight) {
    return (
      <Card index={index}>
        <NightNav {...nav} />
        <div className="relative overflow-hidden rounded-xl px-4 py-8 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-6 bottom-4 space-y-2 opacity-[0.12]"
          >
            {[70, 90, 55].map((width, i) => (
              <div
                key={i}
                className="h-2.5 rounded-full"
                style={{ width: `${width}%`, backgroundColor: "var(--accent)" }}
              />
            ))}
          </div>
          <p className="relative text-sm" style={{ color: "var(--text-muted)" }}>
            The pod recorded no sleep for this night.
          </p>
          {nav.canNext && (
            <button
              type="button"
              onClick={nav.onLatest}
              className="btn btn-primary relative mx-auto mt-4"
            >
              Jump to the latest night
            </button>
          )}
        </div>
      </Card>
    );
  }

  const score = metrics.thermalScore ?? metrics.score ?? null;
  const helped = insight.contributors.filter((c) => c.effect === "helped");
  const heldBack = insight.contributors.filter((c) => c.effect === "held-back");
  const typical = insight.contributors.filter((c) => c.effect === "typical");

  return (
    <div id="night-card" className="scroll-mt-20">
    <Card index={index}>
      <NightNav {...nav} />

      {/* The verdict, then what changed against your usual and why it
          matters. Tone lives in the ring and the rating word, so a headline
          naming a problem is never painted green. */}
      <h3
        id="night-headline"
        className="mt-5 text-2xl font-semibold leading-[1.15] tracking-[-0.02em]"
        style={{ color: "var(--text-headline)" }}
      >
        {insight.headline}
      </h3>
      <p
        className="mt-2 text-[15px] leading-relaxed"
        style={{ color: "var(--text-muted)" }}
      >
        {insight.summary}
      </p>

      <div className="mt-5 flex items-center justify-between gap-4">
        <dl className="min-w-0 space-y-3">
          <div>
            <dt className="text-xs" style={{ color: "var(--text-muted)" }}>
              Sleep quality
            </dt>
            <dd
              className="text-lg font-semibold"
              style={{ color: TONE_VAR[scoreTone(score)] }}
            >
              {insight.rating ?? "Not scored"}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: "var(--text-muted)" }}>
              Asleep
            </dt>
            <dd
              className="tabular text-lg font-semibold"
              style={{ color: "var(--text-headline)" }}
            >
              {metrics.asleepHours != null ? formatHours(metrics.asleepHours) : "—"}
              <span
                className="ml-2 text-xs font-normal"
                style={{ color: "var(--text-faint)" }}
              >
                {clockOf(metrics.bedtimeMinutes)} → {clockOf(metrics.wakeMinutes)}
              </span>
            </dd>
          </div>
          {metrics.screenInBedHours != null && (
            <div>
              <dt className="text-xs" style={{ color: "var(--text-muted)" }}>
                TV in bed first
              </dt>
              <dd
                className="tabular text-sm font-semibold"
                style={{ color: "var(--text-headline)" }}
                title="The bedroom projector was on. Time to fall asleep is counted from when it went off, not from getting into bed."
              >
                {Math.round(metrics.screenInBedHours * 60)} min
              </dd>
            </div>
          )}
        </dl>
        <ScoreRing score={score} size={112} label="quality" />
      </div>

      {Object.keys(stageHours).length > 0 && (
        <div className="mt-5">
          <StageBar stageHours={stageHours} compact />
        </div>
      )}

      {metrics.notMe && !metrics.identityConfirmed && (
        <WhoseNightRow
          night={metrics.night}
          reason={metrics.identityReason ?? null}
        />
      )}
      {metrics.notMe && metrics.identityConfirmed && (
        <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>
          Someone else slept here. This night is kept, but it does not steer
          your temperatures.
        </p>
      )}
      {metrics.secondOpinion && <SecondOpinionRow opinion={metrics.secondOpinion} />}

      {metrics.signalGapHours != null && metrics.signalGapHours > 0 && (
        <p className="mt-3 text-xs leading-snug" style={{ color: "var(--text-muted)" }}>
          The bed could not read you for the first{" "}
          {formatHours(metrics.signalGapHours)} after you got in, usually from
          sitting up or lying outside your side&apos;s sensor. That time is not
          counted as trying to fall asleep.
        </p>
      )}

      {metrics.sound && <SoundRow sound={metrics.sound} />}

      {(helped.length > 0 || heldBack.length > 0) && (
        <div
          className="mt-5 space-y-4 border-t pt-4"
          style={{ borderColor: "var(--border)" }}
        >
          {heldBack.length > 0 && (
            <DriverGroup title="What held it back" items={heldBack} />
          )}
          {helped.length > 0 && <DriverGroup title="What helped" items={helped} />}
          {typical.length > 0 && (
            <p className="text-xs" style={{ color: "var(--text-faint)" }}>
              Close to your usual: {typical.map((c) => c.label.toLowerCase()).join(", ")}.
            </p>
          )}
        </div>
      )}

      {insight.tip && (
        <div
          id="night-tip"
          className="mt-4 flex gap-3 rounded-xl p-3"
          style={{ background: "var(--accent-soft)" }}
        >
          <LordIcon
            name="bulb"
            size={22}
            trigger="hover"
            target="#night-tip"
            color="var(--accent)"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
              Something to try
            </p>
            <p className="mt-0.5 text-sm leading-snug" style={{ color: "var(--text)" }}>
              {insight.tip}
            </p>
          </div>
        </div>
      )}
    </Card>
    </div>
  );
};

/**
 * What the bedroom phone heard, and whether it lines up with the wake-ups.
 * Sounds are only named as a cause when wake-ups followed them far more
 * often than chance (sound.ts), so a snoring partner is not blamed for every
 * waking.
 */
const SoundRow: React.FC<{
  sound: NonNullable<
    NonNullable<RouterOutputs["user"]["getNightTimeline"]["metrics"]>["sound"]
  >;
}> = ({ sound }) => {
  const total = Object.values(sound.counts).reduce((a, b) => a + b, 0);
  const kinds = [...new Set(sound.wakeUpsAfterSound.map((w) => soundLabel(w.kind)))];
  return (
    <div
      id="night-sound"
      className="mt-4 flex gap-3 rounded-xl p-3"
      style={{ background: sound.likelyCause ? "var(--warning-soft)" : "var(--surface-sunken)" }}
    >
      <LordIcon
        name="microphone"
        size={22}
        trigger="hover"
        target="#night-sound"
        color={sound.likelyCause ? "var(--warning)" : "var(--text-muted)"}
      />
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
          {total} sound{total === 1 ? "" : "s"} in the night
        </p>
        <p className="mt-0.5 text-sm leading-snug" style={{ color: "var(--text)" }}>
          {soundCountsText(sound.counts)}.{" "}
          {sound.wakeUps === 0
            ? "You did not wake up."
            : sound.wakeUpsAfterSound.length === 0
              ? `None of your ${sound.wakeUps} wake-ups followed a sound.`
              : `${sound.wakeUpsAfterSound.length} of ${sound.wakeUps} wake-ups came within two minutes of a sound (${kinds.join(", ")})${
                  sound.likelyCause
                    ? ", far more often than chance, so the noise is likely what woke you."
                    : ", about what chance alone would give."
                }`}
        </p>
      </div>
    </div>
  );
};

/**
 * One side of "why the night went the way it did": each driver with a badge
 * (icon AND word, never colour alone), its value, and the comparison against
 * the sleeper's usual in words.
 */
const DriverGroup: React.FC<{ title: string; items: Contributor[] }> = ({
  title,
  items,
}) => {
  const good = items[0]?.effect === "helped";
  return (
    <div>
      <p className="text-sm font-semibold" style={{ color: "var(--text-headline)" }}>
        {title}
      </p>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li
            key={item.key}
            id={`driver-${item.key}`}
            className="flex items-center gap-3"
          >
            <LordIcon
              name={good ? "check" : "alert"}
              size={20}
              trigger="hover"
              target={`#driver-${item.key}`}
              color={good ? "var(--success)" : "var(--warning)"}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm" style={{ color: "var(--text)" }}>
                {item.label}
              </span>
              <span className="block text-xs" style={{ color: "var(--text-muted)" }}>
                {item.comparison}
              </span>
            </span>
            <span
              className="tabular shrink-0 text-sm font-semibold"
              style={{ color: "var(--text-headline)" }}
            >
              {item.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * The vitals say this night was probably somebody else. It is a question,
 * never an assertion: the sleeper's own answer is the only thing that
 * settles it, and until they answer the night simply stays out of the
 * temperature loop's evidence.
 */
const WhoseNightRow: React.FC<{ night: string; reason: string | null }> = ({
  night,
  reason,
}) => {
  const utils = apiR.useUtils();
  const confirm = apiR.user.confirmNightIdentity.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.user.getNightTimeline.invalidate(),
        utils.user.getSleepHistory.invalidate(),
        utils.user.getAiRecommendations.invalidate(),
      ]);
    },
  });
  return (
    <div
      className="mt-3 rounded-lg p-3"
      style={{
        background: "var(--warning-soft)",
        border: "1px solid var(--warning)",
      }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--text)" }}>
        Was this you?
      </p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {reason ??
          "This night's breathing and heart data do not look like your usual."}{" "}
        Until you say, it will not be used to tune your bed.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate({ night, wasMe: true })}
          className="btn btn-secondary"
        >
          That was me
        </button>
        <button
          type="button"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate({ night, wasMe: false })}
          className="btn btn-secondary"
        >
          Someone else
        </button>
      </div>
      {confirm.isError && (
        <p className="mt-2 text-xs" style={{ color: "var(--danger)" }}>
          {confirm.error.message}
        </p>
      )}
    </div>
  );
};

/**
 * The Apple Watch's reading of the same night. Two sensors on one night:
 * where they agree the pod is confirmed, where they differ the gap is shown
 * rather than silently resolved in the pod's favour.
 */
const SecondOpinionRow: React.FC<{
  opinion: NonNullable<
    NonNullable<RouterOutputs["user"]["getNightTimeline"]["metrics"]>["secondOpinion"]
  >;
}> = ({ opinion }) => {
  const parts: string[] = [];
  if (opinion.score != null) parts.push(`${opinion.score}/100`);
  if (opinion.asleepHours != null) parts.push(`${formatHours(opinion.asleepHours)} asleep`);
  if (opinion.awakeHours != null) parts.push(`${Math.round(opinion.awakeHours * 60)}m awake`);
  const disagrees = opinion.disagreements.length > 0;
  return (
    <div className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
      <span className="tabular">Apple Watch: {parts.join(" · ")}</span>
      {disagrees ? (
        <span
          className="chip ml-2"
          style={{ color: "var(--warning)", borderColor: "var(--warning)", background: "var(--warning-soft)" }}
          title={opinion.disagreements.join(" ")}
        >
          sensors disagree
        </span>
      ) : (
        <span className="chip ml-2" style={{ color: "var(--success)", borderColor: "var(--success)", background: "var(--success-soft)" }}>
          agrees
        </span>
      )}
      {disagrees && (
        <ul className="mt-1 space-y-0.5" style={{ color: "var(--text-muted)" }}>
          {opinion.disagreements.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

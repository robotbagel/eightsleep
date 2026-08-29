"use client";
import React, { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import { type DisplayUnit } from "~/lib/temperature";
import { buildSleepShortcutPlist } from "~/lib/sleepShortcut";
import { Card, Disclosure, Skeleton } from "./ui/card";
import LordIcon from "./ui/lordIcon";
import { StageChangeChart, type StageChange } from "./charts/stageChangeChart";
import { PlanCurve } from "./charts/planCurve";
import { SettingsHistory } from "./settingsHistory";
import { StageComparison } from "./stageComparison";
import { ExperimentLedger } from "./experimentLedger";

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const Chip: React.FC<{
  label: string;
  color: string;
  background: string;
}> = ({ label, color, background }) => (
  <span className="chip" style={{ color, backgroundColor: background }}>
    {label}
  </span>
);

const ConfidenceChip: React.FC<{ confidence: string }> = ({ confidence }) => {
  const map: Record<string, [string, string]> = {
    high: ["var(--success)", "var(--success-soft)"],
    medium: ["var(--warning)", "var(--warning-soft)"],
    low: ["var(--text-muted)", "var(--surface-sunken)"],
  };
  const [color, background] = map[confidence] ?? map.low!;
  return (
    <Chip label={`${confidence} confidence`} color={color} background={background} />
  );
};

const StatusChip: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, [string, string, string]> = {
    pending: ["Waiting for you", "var(--warning)", "var(--warning-soft)"],
    applied: ["Applied", "var(--success)", "var(--success-soft)"],
    auto_applied: ["Auto-applied", "var(--success)", "var(--success-soft)"],
    dismissed: ["Dismissed", "var(--text-muted)", "var(--surface-sunken)"],
  };
  const [label, color, background] = map[status] ?? map.dismissed!;
  return <Chip label={label} color={color} background={background} />;
};

const Toggle: React.FC<{
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}> = ({ id, label, hint, checked, disabled, onChange }) => (
  <label
    htmlFor={id}
    className="flex cursor-pointer items-start justify-between gap-4 rounded-xl px-2 py-2 transition-colors duration-fast ease-snap hover:bg-[var(--surface-hover)]"
  >
    <span className="flex-1">
      <span
        className="block text-sm font-medium"
        style={{ color: "var(--text-headline)" }}
      >
        {label}
      </span>
      {hint && (
        <span
          className="mt-0.5 block text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          {hint}
        </span>
      )}
    </span>
    <span className="relative mt-0.5 shrink-0">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="block h-6 w-11 rounded-full transition-colors duration-fast ease-snap peer-disabled:opacity-50"
        style={{
          backgroundColor: checked ? "var(--accent)" : "var(--surface-sunken)",
          border: `1px solid ${checked ? "var(--accent)" : "var(--border-strong)"}`,
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full transition-transform duration-fast ease-snap"
        style={{
          backgroundColor: checked ? "var(--accent-ink)" : "var(--text-muted)",
          transform: checked ? "translateX(20px)" : undefined,
        }}
      />
    </span>
  </label>
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

const NotificationsToggle: React.FC = () => {
  const pushKeyQuery = apiR.user.getPushPublicKey.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const subscribeMutation = apiR.user.subscribePush.useMutation();
  const unsubscribeMutation = apiR.user.unsubscribePush.useMutation();
  const [browserSubscribed, setBrowserSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const isIos =
    typeof navigator !== "undefined" &&
    /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true);

  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setBrowserSubscribed(!!subscription))
      .catch(() => setBrowserSubscribed(false));
  }, [supported]);

  if (!supported || (isIos && !isStandalone)) {
    return (
      <div
        className="rounded-xl p-3 text-xs"
        style={{
          backgroundColor: "var(--cool-soft)",
          color: "var(--text)",
        }}
      >
        <span className="font-semibold">Morning report notifications: </span>
        {isIos
          ? "add this app to your Home Screen first (Share, then Add to Home Screen), open it from there, and this becomes a toggle."
          : "this browser does not support web push."}
      </div>
    );
  }

  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Notification permission was not granted.");
      }
      const publicKey = pushKeyQuery.data?.publicKey;
      if (!publicKey) throw new Error("Push key not loaded yet — try again.");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = subscription.toJSON();
      await subscribeMutation.mutateAsync({
        endpoint: subscription.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
      });
      setBrowserSubscribed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeMutation.mutateAsync({
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe();
      }
      setBrowserSubscribed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Toggle
        id="notifications"
        label="Morning report notification"
        hint="A push after each night: score, stats, and what the AI changed."
        checked={browserSubscribed}
        disabled={busy}
        onChange={(next) => (next ? void enable() : void disable())}
      />
      {error && (
        <p className="mt-1 px-2 text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Apple Health import
// ---------------------------------------------------------------------------

const HealthImportSection: React.FC = () => {
  const [open, setOpen] = useState(false);
  const infoQuery = apiR.user.getHealthImportInfo.useQuery(undefined, {
    refetchOnWindowFocus: false,
    enabled: open,
  });
  const endpoint =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/healthImport`
      : "/api/healthImport";

  return (
    <div
      className="rounded-xl border"
      style={{ borderColor: "var(--border)", backgroundColor: "var(--surface-sunken)" }}
    >
      <button
        id="health-import"
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 p-3 text-left"
      >
        <span className="flex items-center gap-2">
          <LordIcon
            name="download"
            size={18}
            trigger="hover"
            target="#health-import"
            color="var(--accent)"
          />
          <span
            className="text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            Apple Watch import
          </span>
          {infoQuery.data?.lastImportNight && (
            <Chip
              label={`last ${infoQuery.data.lastImportNight} · ${infoQuery.data.lastImportScore}`}
              color="var(--success)"
              background="var(--success-soft)"
            />
          )}
        </span>
        <span
          className="transition-transform duration-fast ease-snap"
          style={{
            color: "var(--text-muted)",
            transform: open ? "rotate(180deg)" : undefined,
          }}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 4.5 6 8l3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <div
        className="grid transition-[grid-template-rows] duration-base ease-snap"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div
            className="space-y-3 border-t p-3 text-xs"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            <p>
              Feeds the AI your Apple Watch sleep stages on nights the pod
              recorded nothing. It runs each morning and triggers that
              day&apos;s assessment and push report straight away.
            </p>

            {infoQuery.data && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    const token = infoQuery.data?.token;
                    if (!token) return;
                    const plist = buildSleepShortcutPlist(endpoint, token);
                    const blob = new Blob([plist], {
                      type: "application/octet-stream",
                    });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = "8sleep-sleep-import.shortcut";
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                    URL.revokeObjectURL(url);
                  }}
                  className="btn btn-primary w-full"
                >
                  Download the Shortcut
                </button>
                <p style={{ color: "var(--text-faint)" }}>
                  Opens in Shortcuts to import (turn on Settings → Shortcuts →
                  Allow Untrusted Shortcuts if asked), then add it as a daily
                  Automation around 08:00. If the import fails, build it by hand
                  with the steps below.
                </p>
              </div>
            )}

            <details
              className="rounded-lg p-2"
              style={{ backgroundColor: "var(--surface)" }}
            >
              <summary
                className="cursor-pointer font-medium"
                style={{ color: "var(--text)" }}
              >
                Build it by hand instead
              </summary>
              <ol className="mt-2 list-decimal space-y-1 pl-4">
                <li>Shortcuts → new Shortcut.</li>
                <li>
                  <span className="font-medium">Find Health Samples</span>:
                  Sleep, Start Date is in the last 1 day.
                </li>
                <li>
                  <span className="font-medium">Repeat with Each</span>; inside
                  add <span className="font-medium">Text</span>: Repeat
                  Item&apos;s Sleep value, comma, Start Date, comma, End Date.
                </li>
                <li>
                  After the repeat,{" "}
                  <span className="font-medium">Combine Text</span> (Repeat
                  Results, New Lines).
                </li>
                <li>
                  <span className="font-medium">Get Contents of URL</span> →
                  POST, Request Body = Combined Text (as File), URL below. No
                  header.
                </li>
                <li>Add it as a daily Automation (~08:00, Run Immediately).</li>
              </ol>
              {infoQuery.data && (
                <p
                  className="mt-2 break-all rounded-md p-2 font-mono text-[10px]"
                  style={{ backgroundColor: "var(--surface-sunken)" }}
                >
                  {endpoint}?token={infoQuery.data.token}
                </p>
              )}
            </details>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The advisor card — what is loaded for tonight, and why
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<string, string> = {
  initial: "Falling asleep",
  deep: "Deep sleep",
  mid: "Middle of the night",
  final: "REM and wake-up",
};

const DIRECTION_META: Record<
  string,
  { label: string; color: string; background: string }
> = {
  cooler: { label: "Cooler", color: "var(--cool)", background: "var(--cool-soft)" },
  warmer: { label: "Warmer", color: "var(--warm)", background: "var(--warm-soft)" },
  unchanged: {
    label: "Unchanged",
    color: "var(--text-muted)",
    background: "var(--surface-sunken)",
  },
};

export const AiAdvisorCard: React.FC<{
  displayUnit: DisplayUnit;
  index?: number;
}> = ({ displayUnit, index = 0 }) => {
  const utils = apiR.useUtils();
  const settingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const planQuery = apiR.user.getTemperaturePlan.useQuery(
    { days: 7 },
    { refetchOnWindowFocus: false },
  );
  const recommendationsQuery = apiR.user.getAiRecommendations.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  const liveAdjustmentsQuery = apiR.user.getLiveAdjustments.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const invalidatePlan = async () => {
    await Promise.all([
      utils.user.getAiRecommendations.invalidate(),
      utils.user.getTemperaturePlan.invalidate(),
      utils.user.getUserTemperatureProfile.invalidate(),
    ]);
  };

  const generateMutation = apiR.user.generateAiRecommendation.useMutation({
    onSuccess: invalidatePlan,
  });
  const applyMutation = apiR.user.applyAiRecommendation.useMutation({
    onSuccess: invalidatePlan,
  });
  const dismissMutation = apiR.user.dismissAiRecommendation.useMutation({
    onSuccess: invalidatePlan,
  });

  if (settingsQuery.isLoading || recommendationsQuery.isLoading) {
    return (
      <Card index={index}>
        <Skeleton className="h-56" />
      </Card>
    );
  }

  const aiAvailable = settingsQuery.data?.aiAvailable ?? false;
  const latest = recommendationsQuery.data?.[0];
  const plan = planQuery.data;
  const nudges = liveAdjustmentsQuery.data ?? [];

  const changes: StageChange[] =
    plan?.tonight != null
      ? (["initial", "deep", "mid", "final"] as const).map((stage) => ({
          label: STAGE_LABEL[stage]!,
          lastNight: plan.lastNight?.[stage] ?? null,
          tonight: plan.tonight[stage],
          proposed: plan.proposed?.[stage] ?? null,
        }))
      : [];

  const anyChanged = changes.some(
    (c) => c.lastNight != null && c.lastNight !== c.tonight,
  );
  const hasProposal = changes.some(
    (c) => c.proposed != null && c.proposed !== c.tonight,
  );

  return (
    <Card index={index}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {latest
            ? `Last assessed ${new Date(`${latest.forDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`
            : "Tunes the four temperature stages from last night's data."}
        </span>
        {latest && (
          <div className="flex flex-wrap justify-end gap-1.5">
            <ConfidenceChip confidence={latest.confidence} />
            <StatusChip status={latest.status} />
          </div>
        )}
      </div>

      {!aiAvailable && (
        <div
          className="mb-4 rounded-xl p-3 text-sm"
          style={{ backgroundColor: "var(--warning-soft)", color: "var(--text)" }}
        >
          The advisor has no API key. Add{" "}
          <span className="font-mono font-semibold">GEMINI_API_KEY</span> to the
          Vercel project and redeploy.
        </div>
      )}

      {plan?.tonight && (
        <>
          {(!plan.assessedToday || hasProposal) && (
            <PlanBanner
              status={latest?.status ?? null}
              updatedAt={latest?.updatedAt ?? null}
              anyChanged={anyChanged}
              hasProposal={hasProposal}
              hasLastNight={plan.lastNight != null}
              assessedToday={plan.assessedToday}
              aiEnabled={settingsQuery.data?.aiEnabled ?? false}
              busy={generateMutation.isPending}
              onAssess={() => generateMutation.mutate()}
            />
          )}

          <div className="mt-5">
            <StageComparison
              twoNightsAgo={pickNight(plan.history, plan.todayKey, -2)}
              lastNight={pickNight(plan.history, plan.todayKey, -1)}
              tonight={pickNight(plan.history, plan.todayKey, 0)}
              proposed={plan.proposed}
              unit={displayUnit}
            />
          </div>

          <div className="mt-5">
            <ExperimentLedger
              experiments={plan.experiments}
              pressure={plan.livePressure}
              unit={displayUnit}
            />
          </div>

          <details className="mt-4 group">
            <summary
              className="cursor-pointer list-none text-xs font-semibold"
              style={{ color: "var(--text-muted)" }}
            >
              <span className="group-open:hidden">Show the last 7 nights</span>
              <span className="hidden group-open:inline">
                Hide the last 7 nights
              </span>
            </summary>
            <div className="mt-3">
              <SettingsHistory
                history={plan.history}
                todayKey={plan.todayKey}
                unit={displayUnit}
              />
            </div>
          </details>

          <div className="mt-5">
            <PlanCurve
              bedTime={plan.bedTime}
              wakeupTime={plan.wakeupTime}
              series={[
                ...(plan.lastNight
                  ? [
                      {
                        key: "lastNight" as const,
                        label: `Last night${plan.lastNight.night ? ` (${nightLabel(plan.lastNight.night)})` : ""}`,
                        levels: plan.lastNight,
                        color: "var(--text-faint)",
                        dashed: true,
                      },
                    ]
                  : []),
                {
                  key: "tonight" as const,
                  label: `Tonight${plan.todayKey ? ` (${nightLabel(plan.todayKey)})` : ""} — loaded`,
                  levels: plan.tonight,
                  color: "var(--accent)",
                  emphasis: true,
                },
                ...(plan.proposed
                  ? [
                      {
                        key: "proposed" as const,
                        label: "Proposed (not applied)",
                        levels: plan.proposed,
                        color: "var(--warm)",
                        dashed: true,
                      },
                    ]
                  : []),
              ]}
            />
          </div>

          <div className="mt-5">
            <StageChangeChart changes={changes} unit={displayUnit} />
          </div>

          <p
            className="mt-3 text-xs"
            style={{ color: "var(--text-faint)" }}
          >
            {plan.assessedToday
              ? `Tonight's plan is settled. The next one is decided tomorrow morning, about half an hour after you wake, once the pod has finished uploading the night.`
              : `Tonight's plan has not been assessed yet today. It runs automatically about half an hour after you wake.`}
          </p>
        </>
      )}

      {latest ? (
        <>
          <p
            className="mt-4 rounded-xl p-3 text-sm leading-relaxed"
            style={{
              backgroundColor: "var(--surface-sunken)",
              color: "var(--text)",
            }}
          >
            {latest.reasoning}
          </p>

          <Reasoning
            rationale={latest.rationale}
            outcome={latest.outcome}
            displayUnit={displayUnit}
          />

          {latest.status === "pending" && (
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => applyMutation.mutate({ id: latest.id })}
                disabled={applyMutation.isPending}
                className="btn btn-primary flex-1"
              >
                {applyMutation.isPending ? "Applying…" : "Apply tonight"}
              </button>
              <button
                type="button"
                onClick={() => dismissMutation.mutate({ id: latest.id })}
                disabled={dismissMutation.isPending}
                className="btn btn-secondary"
              >
                Keep as is
              </button>
            </div>
          )}
          {applyMutation.isError && (
            <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
              {applyMutation.error.message}
            </p>
          )}
        </>
      ) : (
        <EmptyAdvisor
          aiAvailable={aiAvailable}
          pending={generateMutation.isPending}
          onRun={() => generateMutation.mutate()}
        />
      )}

      {latest && (
        <div className="mt-4 flex justify-end">
          <button
            id="optimize-now"
            type="button"
            onClick={() => generateMutation.mutate()}
            disabled={!aiAvailable || generateMutation.isPending}
            className="btn btn-secondary"
          >
            <LordIcon
              name="refresh"
              size={16}
              trigger="hover"
              target="#optimize-now"
              color="var(--text-muted)"
            />
            {generateMutation.isPending ? "Thinking…" : "Reassess now"}
          </button>
        </div>
      )}
      {generateMutation.isError && (
        <p className="mt-2 text-sm" style={{ color: "var(--danger)" }}>
          {generateMutation.error.message}
        </p>
      )}

      {nudges.length > 0 && (
        <div
          className="mt-5 border-t pt-4"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="card-title mb-2">Live nudges</div>
          <ul className="space-y-1">
            {nudges.map((adjustment, i) => (
              <li
                key={adjustment.id}
                className="enter flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors duration-fast ease-snap hover:bg-[var(--surface-hover)]"
                style={{ "--i": i } as React.CSSProperties}
              >
                <span
                  className="tabular w-11 shrink-0 pt-0.5 text-xs"
                  style={{ color: "var(--text-faint)" }}
                >
                  {new Date(adjustment.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: "var(--warm)" }}
                />
                <span className="flex-1">
                  <span
                    className="block text-sm font-medium"
                    style={{ color: "var(--text-headline)" }}
                  >
                    {STAGE_LABEL[adjustment.stage] ?? adjustment.stage}
                  </span>
                  <span
                    className="block text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {adjustment.reason}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
};

/** Picks the row `offset` nights from today out of the settings history,
 *  by date rather than by position — history has gaps on nights the pod (or
 *  the cron) recorded nothing, and counting backwards would silently show the
 *  wrong night. */
function pickNight(
  history: { night: string }[],
  todayKey: string | null,
  offset: number,
) {
  if (!todayKey) return null;
  const target = new Date(`${todayKey}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + offset);
  const key = target.toISOString().slice(0, 10);
  return (
    (history.find((row) => row.night === key) as
      | Parameters<typeof StageComparison>[0]["tonight"]
      | undefined) ?? null
  );
}

function nightLabel(night: string): string {
  return new Date(`${night}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** One line that settles "did it change, and is it live?". */
export const PlanBanner: React.FC<{
  status: string | null;
  updatedAt: Date | string | null;
  anyChanged: boolean;
  hasProposal: boolean;
  hasLastNight: boolean;
  assessedToday?: boolean;
  aiEnabled?: boolean;
  busy?: boolean;
  onAssess?: () => void;
}> = ({
  status,
  updatedAt,
  anyChanged,
  hasProposal,
  hasLastNight,
  assessedToday = true,
  aiEnabled = true,
  busy = false,
  onAssess,
}) => {
  const stamp = updatedAt
    ? new Date(updatedAt).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  let text: string;
  let color = "var(--text)";
  let background = "var(--surface-sunken)";

  // A missing assessment used to be invisible: the card simply kept showing
  // yesterday's plan as if it were today's.
  if (aiEnabled && !assessedToday) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl p-3 text-sm"
        style={{
          backgroundColor: "var(--warning-soft)",
          color: "var(--warning)",
        }}
      >
        <span>
          No assessment has run today, so tonight is still last night&apos;s
          profile.
        </span>
        {onAssess && (
          <button
            type="button"
            onClick={onAssess}
            disabled={busy}
            className="btn btn-secondary shrink-0"
          >
            {busy ? "Assessing…" : "Assess now"}
          </button>
        )}
      </div>
    );
  }

  if (hasProposal) {
    text = `A change is waiting for you — tonight still runs the profile below until you apply it.`;
    color = "var(--warning)";
    background = "var(--warning-soft)";
  } else if (status === "auto_applied" && anyChanged) {
    text = `The AI changed tonight's temperatures${stamp ? ` at ${stamp}` : ""}. They are live on the pod.`;
    color = "var(--success)";
    background = "var(--success-soft)";
  } else if ((status === "applied" || status === "auto_applied") && !anyChanged) {
    text = hasLastNight
      ? `Assessed${stamp ? ` at ${stamp}` : ""} and left unchanged — tonight runs exactly what last night ran.`
      : `Assessed${stamp ? ` at ${stamp}` : ""} and left unchanged.`;
  } else if (status === "dismissed") {
    text = `You kept your own profile; the last suggestion was dismissed.`;
  } else {
    text = hasLastNight
      ? anyChanged
        ? `Tonight differs from last night — the values below are what the pod will run.`
        : `Tonight runs exactly what last night ran.`
      : `The values below are what the pod will run tonight.`;
  }

  return (
    <p
      className="rounded-xl p-3 text-sm"
      style={{ backgroundColor: background, color }}
    >
      {text}
    </p>
  );
};

/** The learning surface: per-stage logic, the numbers behind it, the
 *  prediction to check tomorrow, and the principle worth remembering. */
export const Reasoning: React.FC<{
  rationale: {
    perStage: { stage: string; direction: string; why: string }[];
    evidence: string[];
    expectation: string;
    principle: string;
  } | null;
  outcome: { before: number; after: number; delta: number } | null;
  displayUnit: DisplayUnit;
}> = ({ rationale, outcome }) => {
  const [open, setOpen] = useState(false);
  const hasRationale =
    rationale != null &&
    ((rationale.perStage?.length ?? 0) > 0 ||
      (rationale.evidence?.length ?? 0) > 0 ||
      !!rationale.expectation ||
      !!rationale.principle);

  if (!hasRationale && !outcome) return null;

  return (
    <div className="mt-3">
      {outcome && (
        <div
          className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-sm"
          style={{
            backgroundColor:
              outcome.delta > 0 ? "var(--success-soft)" : "var(--surface-sunken)",
            color: outcome.delta > 0 ? "var(--success)" : "var(--text-muted)",
          }}
        >
          <span className="font-semibold">
            {outcome.delta > 0 ? "It helped" : outcome.delta < 0 ? "It did not help" : "No change"}
          </span>
          <span className="tabular">
            {outcome.before} → {outcome.after}
            <span className="ml-1" style={{ color: "var(--text-faint)" }}>
              the night after this change
            </span>
          </span>
        </div>
      )}

      {hasRationale && (
        <>
          <button
            id="why-toggle"
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="btn btn-ghost w-full justify-between px-2 text-sm"
          >
            <span className="flex items-center gap-2">
              <LordIcon
                name="ai"
                size={16}
                trigger="hover"
                target="#why-toggle"
                color="var(--accent)"
              />
              Why these numbers
            </span>
            <span
              className="transition-transform duration-fast ease-snap"
              style={{ transform: open ? "rotate(180deg)" : undefined }}
              aria-hidden="true"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2.5 4.5 6 8l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>

          <div
            className="grid transition-[grid-template-rows] duration-base ease-snap"
            style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
          >
            <div className="overflow-hidden">
              <div className="space-y-4 px-2 pt-2">
                {(rationale?.perStage?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    {rationale.perStage.map((entry, i) => {
                      const meta =
                        DIRECTION_META[entry.direction] ??
                        DIRECTION_META.unchanged!;
                      return (
                        <div
                          key={`${entry.stage}-${i}`}
                          className="enter flex gap-2.5"
                          style={{ "--i": i } as React.CSSProperties}
                        >
                          <span
                            className="chip mt-0.5 h-fit shrink-0 justify-center"
                            style={{
                              color: meta.color,
                              backgroundColor: meta.background,
                              minWidth: "5.5rem",
                            }}
                          >
                            {meta.label}
                          </span>
                          <span className="flex-1">
                            <span
                              className="block text-xs font-semibold"
                              style={{ color: "var(--text-headline)" }}
                            >
                              {STAGE_LABEL[entry.stage] ?? entry.stage}
                            </span>
                            <span
                              className="block text-xs leading-relaxed"
                              style={{ color: "var(--text-muted)" }}
                            >
                              {entry.why}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(rationale?.evidence?.length ?? 0) > 0 && (
                  <div>
                    <div className="card-title mb-1.5">What it read</div>
                    <ul className="space-y-1">
                      {rationale.evidence.map((line, i) => (
                        <li
                          key={i}
                          className="flex gap-2 text-xs"
                          style={{ color: "var(--text-muted)" }}
                        >
                          <span
                            className="mt-1.5 h-1 w-1 shrink-0 rounded-full"
                            style={{ backgroundColor: "var(--accent)" }}
                          />
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {rationale?.expectation && (
                  <div>
                    <div className="card-title mb-1.5">What to watch tomorrow</div>
                    <p
                      className="rounded-lg p-2.5 text-xs leading-relaxed"
                      style={{
                        backgroundColor: "var(--cool-soft)",
                        color: "var(--text)",
                      }}
                    >
                      {rationale.expectation}
                    </p>
                  </div>
                )}

                {rationale?.principle && (
                  <div>
                    <div className="card-title mb-1.5">The rule behind it</div>
                    <p
                      className="border-l-2 pl-3 text-xs italic leading-relaxed"
                      style={{
                        borderColor: "var(--accent)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {rationale.principle}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/** Canon §10: an empty state is a prompt — one line of context, one action. */
const EmptyAdvisor: React.FC<{
  aiAvailable: boolean;
  pending: boolean;
  onRun: () => void;
}> = ({ aiAvailable, pending, onRun }) => (
  <div className="relative overflow-hidden rounded-xl px-4 py-8 text-center">
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-4 bottom-3 space-y-2 opacity-[0.14]"
    >
      {[62, 84, 48].map((width, i) => (
        <div
          key={i}
          className="h-2.5 rounded-full"
          style={{ width: `${width}%`, backgroundColor: "var(--accent)" }}
        />
      ))}
    </div>
    <div className="relative">
      <div id="empty-advisor" className="mb-3 flex justify-center">
        <LordIcon
          name="ai"
          size={40}
          trigger="hover"
          target="#empty-advisor"
          color="var(--accent)"
          colorSecondary="var(--text-muted)"
        />
      </div>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        No plan yet. One night of pod data is enough to make the first one.
      </p>
      <button
        type="button"
        onClick={onRun}
        disabled={!aiAvailable || pending}
        className="btn btn-primary mx-auto mt-4"
      >
        {pending ? "Thinking…" : "Make tonight's plan"}
      </button>
    </div>
  </div>
);


// ---------------------------------------------------------------------------
// Settings, folded away under a disclosure
// ---------------------------------------------------------------------------

export const AiSettingsCard: React.FC<{ index?: number }> = ({ index = 0 }) => {
  const utils = apiR.useUtils();
  const settingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const [aiEnabled, setAiEnabled] = useState(false);
  const [autoApply, setAutoApply] = useState(false);
  const [liveTuningEnabled, setLiveTuningEnabled] = useState(false);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("celsius");
  const [sleepGoal, setSleepGoal] = useState("");
  const [maxDailyShift, setMaxDailyShift] = useState(20);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (settingsQuery.isSuccess && !dirty) {
      const settings = settingsQuery.data;
      setAiEnabled(settings.aiEnabled);
      setAutoApply(settings.autoApply);
      setLiveTuningEnabled(settings.liveTuningEnabled);
      setDisplayUnit(settings.displayUnit);
      setSleepGoal(settings.sleepGoal ?? "");
      setMaxDailyShift(settings.maxDailyShift);
    }
  }, [settingsQuery.isSuccess, settingsQuery.data, dirty]);

  const updateSettingsMutation = apiR.user.updateAiSettings.useMutation({
    onSuccess: async () => {
      setDirty(false);
      setSavedAt(Date.now());
      await utils.user.getAiSettings.invalidate();
    },
  });

  useEffect(() => {
    if (savedAt == null) return;
    const timer = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(timer);
  }, [savedAt]);

  if (settingsQuery.isLoading) return null;

  const mark = () => setDirty(true);
  const summary = [
    aiEnabled ? "Autopilot on" : "Autopilot off",
    autoApply ? "auto-applies" : "asks first",
    liveTuningEnabled ? "live tuning on" : "live tuning off",
  ].join(" · ");

  return (
    <Disclosure icon="sliders" title="Autopilot settings" summary={summary} index={index}>
      <div className="space-y-1">
        <Toggle
          id="ai-enabled"
          label="Daily AI recommendations"
          hint="Reads last night after you wake and plans tonight's four stages."
          checked={aiEnabled}
          onChange={(next) => {
            setAiEnabled(next);
            mark();
          }}
        />
        <Toggle
          id="auto-apply"
          label="Apply without asking"
          hint="Off means each plan waits for your tap."
          checked={autoApply}
          onChange={(next) => {
            setAutoApply(next);
            mark();
          }}
        />
        <Toggle
          id="live-tuning"
          label="Live night-time tuning"
          hint="Nudges the bed in 0.5°C steps mid-night when tossing, heart rate or bed temperature call for it."
          checked={liveTuningEnabled}
          onChange={(next) => {
            setLiveTuningEnabled(next);
            mark();
          }}
        />

        <div className="pt-1">
          <NotificationsToggle />
        </div>

        <div className="pt-2">
          <HealthImportSection />
        </div>

        <div className="flex items-center justify-between px-2 pt-3">
          <span
            className="text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            Temperature display
          </span>
          <div
            className="flex overflow-hidden rounded-lg border p-0.5"
            style={{ borderColor: "var(--border-strong)" }}
            role="group"
            aria-label="Temperature display unit"
          >
            {(
              [
                ["celsius", "°C"],
                ["level", "−10…+10"],
              ] as [DisplayUnit, string][]
            ).map(([unit, label]) => (
              <button
                key={unit}
                type="button"
                aria-pressed={displayUnit === unit}
                onClick={() => {
                  setDisplayUnit(unit);
                  mark();
                }}
                className="rounded-md px-3 py-1 text-sm font-medium transition-colors duration-fast ease-snap"
                style={{
                  backgroundColor:
                    displayUnit === unit ? "var(--accent)" : "transparent",
                  color:
                    displayUnit === unit
                      ? "var(--accent-ink)"
                      : "var(--text-muted)",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-2 pt-3">
          <label
            htmlFor="sleepGoal"
            className="mb-1.5 block text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            What you want from your sleep
          </label>
          <textarea
            id="sleepGoal"
            value={sleepGoal}
            onChange={(e) => {
              setSleepGoal(e.target.value);
              mark();
            }}
            maxLength={500}
            rows={2}
            placeholder="e.g. I sleep hot and wake around 3am sweating. Prioritise deep sleep."
            className="field resize-none"
          />
        </div>

        <div className="px-2 pt-3">
          <label
            htmlFor="maxDailyShift"
            className="mb-1.5 flex items-baseline justify-between text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            Most it may change in one day
            <span className="tabular text-sm" style={{ color: "var(--accent)" }}>
              {maxDailyShift / 10}°C
            </span>
          </label>
          <input
            id="maxDailyShift"
            type="range"
            min="5"
            max="40"
            step="5"
            value={maxDailyShift}
            onChange={(e) => {
              setMaxDailyShift(Number(e.target.value));
              mark();
            }}
            className="slider"
          />
        </div>

        <div className="flex items-center gap-3 px-2 pt-4">
          <button
            type="button"
            onClick={() =>
              updateSettingsMutation.mutate({
                aiEnabled,
                autoApply,
                liveTuningEnabled,
                displayUnit,
                sleepGoal: sleepGoal.trim() === "" ? null : sleepGoal.trim(),
                maxDailyShift,
              })
            }
            disabled={!dirty || updateSettingsMutation.isPending}
            className="btn btn-primary"
          >
            {updateSettingsMutation.isPending ? "Saving…" : "Save settings"}
          </button>
          {savedAt != null && (
            <span
              className="text-sm"
              style={{ color: "var(--success)", animation: "fadeIn 180ms" }}
            >
              Saved
            </span>
          )}
          {updateSettingsMutation.isError && (
            <span className="text-sm" style={{ color: "var(--danger)" }}>
              {updateSettingsMutation.error.message}
            </span>
          )}
        </div>
      </div>
    </Disclosure>
  );
};

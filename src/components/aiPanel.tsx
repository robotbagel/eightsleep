"use client";
import React, { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import { type DisplayUnit } from "~/lib/temperature";
import { buildSleepShortcutPlist } from "~/lib/sleepShortcut";
import { Card, CardHeader, Disclosure, Skeleton } from "./ui/card";
import LordIcon from "./ui/lordIcon";
import { StageChangeChart, type StageChange } from "./charts/stageChangeChart";

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
// The advisor card — what the AI decided, and why
// ---------------------------------------------------------------------------

export const AiAdvisorCard: React.FC<{
  displayUnit: DisplayUnit;
  index?: number;
}> = ({ displayUnit, index = 0 }) => {
  const utils = apiR.useUtils();
  const settingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const recommendationsQuery = apiR.user.getAiRecommendations.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  const liveAdjustmentsQuery = apiR.user.getLiveAdjustments.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const generateMutation = apiR.user.generateAiRecommendation.useMutation({
    onSuccess: async () => {
      await utils.user.getAiRecommendations.invalidate();
    },
  });
  const applyMutation = apiR.user.applyAiRecommendation.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.user.getAiRecommendations.invalidate(),
        utils.user.getUserTemperatureProfile.invalidate(),
      ]);
    },
  });
  const dismissMutation = apiR.user.dismissAiRecommendation.useMutation({
    onSuccess: async () => {
      await utils.user.getAiRecommendations.invalidate();
    },
  });

  if (settingsQuery.isLoading || recommendationsQuery.isLoading) {
    return (
      <Card index={index}>
        <CardHeader icon="ai" title="AI autopilot" />
        <Skeleton className="h-40" />
      </Card>
    );
  }

  const aiAvailable = settingsQuery.data?.aiAvailable ?? false;
  const latest = recommendationsQuery.data?.[0];
  const nudges = liveAdjustmentsQuery.data ?? [];

  const changes: StageChange[] = latest
    ? [
        {
          label: "Falling asleep",
          previous: latest.previousInitialLevel,
          recommended: latest.recommendedInitialLevel,
        },
        ...(latest.previousDeepLevel != null &&
        latest.recommendedDeepLevel != null
          ? [
              {
                label: "Deep sleep",
                previous: latest.previousDeepLevel,
                recommended: latest.recommendedDeepLevel,
              },
            ]
          : []),
        {
          label: "Middle of the night",
          previous: latest.previousMidLevel,
          recommended: latest.recommendedMidLevel,
        },
        {
          label: "REM and wake-up",
          previous: latest.previousFinalLevel,
          recommended: latest.recommendedFinalLevel,
        },
      ]
    : [];

  return (
    <Card index={index}>
      <CardHeader
        icon="ai"
        title="AI autopilot"
        subtitle={
          latest
            ? `Tonight's plan, decided ${new Date(`${latest.forDate}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
            : "Tunes the four temperature stages from last night's data."
        }
        right={
          latest ? (
            <div className="flex flex-wrap justify-end gap-1.5">
              <ConfidenceChip confidence={latest.confidence} />
              <StatusChip status={latest.status} />
            </div>
          ) : undefined
        }
      />

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

      {latest ? (
        <>
          <StageChangeChart changes={changes} unit={displayUnit} />

          <p
            className="mt-4 rounded-xl p-3 text-sm leading-relaxed"
            style={{
              backgroundColor: "var(--surface-sunken)",
              color: "var(--text)",
            }}
          >
            {latest.reasoning}
          </p>

          {latest.status === "pending" && (
            <div className="mt-3 flex gap-2">
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
                    {adjustment.stage} stage
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

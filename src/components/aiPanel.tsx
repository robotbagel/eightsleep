"use client";
import React, { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import { Button } from "./ui/button";
import { formatRawByUnit, type DisplayUnit } from "~/lib/temperature";
import { buildSleepShortcutPlist } from "~/lib/sleepShortcut";

const STAGE_LABELS: Record<string, string> = {
  deep: "Deep",
  rem: "REM",
  light: "Light",
  awake: "Awake",
};

const STAGE_COLORS: Record<string, string> = {
  deep: "bg-indigo-600",
  rem: "bg-purple-500",
  light: "bg-blue-400",
  awake: "bg-amber-400",
};

function LevelChange({
  label,
  previous,
  recommended,
  unit,
}: {
  label: string;
  previous: number;
  recommended: number;
  unit: DisplayUnit;
}) {
  const changed = previous !== recommended;
  return (
    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
      <span className="text-sm text-gray-700">{label}</span>
      <span className="text-sm font-medium text-gray-800">
        {formatRawByUnit(previous, unit)}
        {changed && (
          <>
            <span className="mx-1 text-gray-400" aria-hidden="true">
              &rarr;
            </span>
            <span
              className={
                recommended < previous ? "text-blue-600" : "text-orange-600"
              }
            >
              {formatRawByUnit(recommended, unit)}
            </span>
          </>
        )}
        {!changed && <span className="ml-2 text-xs text-gray-400">(keep)</span>}
      </span>
    </div>
  );
}

function ConfidenceChip({ confidence }: { confidence: string }) {
  const styles: Record<string, string> = {
    high: "bg-green-100 text-green-800",
    medium: "bg-yellow-100 text-yellow-800",
    low: "bg-gray-200 text-gray-700",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[confidence] ?? styles.low}`}
    >
      {confidence} confidence
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-blue-100 text-blue-800",
    applied: "bg-green-100 text-green-800",
    auto_applied: "bg-green-100 text-green-800",
    dismissed: "bg-gray-200 text-gray-600",
  };
  const labels: Record<string, string> = {
    pending: "Pending",
    applied: "Applied",
    auto_applied: "Auto-applied",
    dismissed: "Dismissed",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles.dismissed}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function SleepSummaryCard() {
  const sleepSummaryQuery = apiR.user.getSleepSummary.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: false,
  });

  if (sleepSummaryQuery.isLoading) {
    return (
      <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-2 text-center text-2xl font-bold text-gray-800">
          Sleep Data
        </h2>
        <p className="text-center text-sm text-gray-500">
          Loading sleep data from Eight Sleep&hellip;
        </p>
      </div>
    );
  }

  if (sleepSummaryQuery.isError || !sleepSummaryQuery.data) {
    return (
      <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-2 text-center text-2xl font-bold text-gray-800">
          Sleep Data
        </h2>
        <p className="text-center text-sm text-gray-500">
          Could not load sleep data from Eight Sleep right now.
        </p>
      </div>
    );
  }

  const { nights, recentSessions } = sleepSummaryQuery.data;
  const lastSession = recentSessions[0];
  const totalStageHours = lastSession
    ? Object.values(lastSession.stageHours).reduce((sum, h) => sum + h, 0)
    : 0;

  return (
    <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
      <h2 className="mb-4 text-center text-2xl font-bold text-gray-800">
        Sleep Data
      </h2>

      {lastSession ? (
        <div className="mb-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-medium text-gray-700">
              Last night ({lastSession.date})
            </span>
            {lastSession.score != null && (
              <span className="text-lg font-bold text-indigo-600">
                {lastSession.score}
                <span className="text-xs font-normal text-gray-500"> /100</span>
              </span>
            )}
          </div>

          {totalStageHours > 0 && (
            <>
              <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
                {(["deep", "rem", "light", "awake"] as const).map((stage) => {
                  const hours = lastSession.stageHours[stage] ?? 0;
                  if (hours <= 0) return null;
                  return (
                    <div
                      key={stage}
                      className={STAGE_COLORS[stage]}
                      style={{ width: `${(hours / totalStageHours) * 100}%` }}
                      title={`${STAGE_LABELS[stage]}: ${hours}h`}
                    />
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {(["deep", "rem", "light", "awake"] as const).map((stage) => {
                  const hours = lastSession.stageHours[stage] ?? 0;
                  if (hours <= 0) return null;
                  return (
                    <span
                      key={stage}
                      className="flex items-center text-xs text-gray-600"
                    >
                      <span
                        className={`mr-1 inline-block h-2 w-2 rounded-full ${STAGE_COLORS[stage]}`}
                      />
                      {STAGE_LABELS[stage]} {hours}h
                    </span>
                  );
                })}
              </div>
            </>
          )}

          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-gray-50 p-2">
              <div className="text-xs text-gray-500">Tosses and turns</div>
              <div className="text-sm font-semibold text-gray-800">
                {[
                  lastSession.tossesAndTurns.firstThird,
                  lastSession.tossesAndTurns.middleThird,
                  lastSession.tossesAndTurns.finalThird,
                ]
                  .map((count) => count ?? 0)
                  .join(" / ")}
              </div>
              <div className="text-[10px] text-gray-400">by third of night</div>
            </div>
            <div className="rounded-md bg-gray-50 p-2">
              <div className="text-xs text-gray-500">Bed temp</div>
              <div className="text-sm font-semibold text-gray-800">
                {lastSession.avgBedTempC.middleThird != null
                  ? `${lastSession.avgBedTempC.middleThird}°C`
                  : "—"}
              </div>
              <div className="text-[10px] text-gray-400">mid-night avg</div>
            </div>
            <div className="rounded-md bg-gray-50 p-2">
              <div className="text-xs text-gray-500">Heart rate</div>
              <div className="text-sm font-semibold text-gray-800">
                {lastSession.avgHeartRate != null
                  ? `${lastSession.avgHeartRate} bpm`
                  : "—"}
              </div>
              <div className="text-[10px] text-gray-400">night avg</div>
            </div>
          </div>
        </div>
      ) : (
        <p className="mb-4 text-center text-sm text-gray-500">
          No completed sleep session found yet.
        </p>
      )}

      {nights.length > 0 && (
        <div>
          <div className="mb-1 text-sm font-medium text-gray-700">
            Last {nights.length} nights
          </div>
          <div className="flex items-end gap-1">
            {nights.map((night) => (
              <div key={night.date} className="flex-1 text-center">
                <div className="flex h-16 items-end justify-center">
                  <div
                    className={`w-full rounded-t ${(night.score ?? 0) >= 80 ? "bg-green-400" : (night.score ?? 0) >= 60 ? "bg-yellow-400" : "bg-red-300"}`}
                    style={{ height: `${Math.max(night.score ?? 0, 4)}%` }}
                    title={`${night.date}: score ${night.score ?? "n/a"}, ${night.sleepDurationHours ?? "?"}h sleep`}
                  />
                </div>
                <div className="mt-1 text-[10px] text-gray-500">
                  {night.date.slice(5)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HealthImportSection() {
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
    <div className="rounded-md bg-gray-50 p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between text-sm font-medium text-gray-700"
      >
        <span>
          Apple Watch import
          {infoQuery.data?.lastImportNight && (
            <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
              last: {infoQuery.data.lastImportNight} (score{" "}
              {infoQuery.data.lastImportScore})
            </span>
          )}
        </span>
        <span className="text-gray-400">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-3 text-xs text-gray-600">
          <p>
            Feeds the AI with your Apple Watch sleep stages when the pod
            provides no data. Runs each morning and instantly triggers that
            day&apos;s AI assessment and push report.
          </p>

          {infoQuery.data && (
            <div className="space-y-2">
              <p className="font-medium text-gray-700">Easiest: one-tap import</p>
              <button
                type="button"
                onClick={() => {
                  const plist = buildSleepShortcutPlist(
                    endpoint,
                    infoQuery.data!.token,
                  );
                  const blob = new Blob([plist], {
                    type: "application/octet-stream",
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "8sleep-sleep-import.shortcut";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                }}
                className="w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Download Shortcut (URL &amp; token pre-filled)
              </button>
              <p className="text-[11px]">
                Opens in the Shortcuts app to import (enable Settings →
                Shortcuts → Allow Untrusted Shortcuts if prompted). Then add it
                as a daily Automation at ~08:00. If import or run fails,
                screenshot the error and use the manual steps below — Apple&apos;s
                Health action varies by iOS build.
              </p>
            </div>
          )}

          <details className="rounded bg-white p-2">
            <summary className="cursor-pointer font-medium text-gray-700">
              Manual setup (fallback, no header needed)
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>Shortcuts → new Shortcut.</li>
              <li><span className="font-medium">Find Health Samples</span>: Sleep, Start Date is in the last 1 day.</li>
              <li><span className="font-medium">Repeat with Each</span>; inside add <span className="font-medium">Text</span>: Repeat Item&apos;s Sleep value, comma, Start Date, comma, End Date.</li>
              <li>After the repeat, <span className="font-medium">Combine Text</span> (Repeat Results, New Lines).</li>
              <li><span className="font-medium">Get Contents of URL</span> → Method POST, Request Body = Combined Text (as File), URL below. No header.</li>
              <li>Add it as a daily Automation (~08:00, Run Immediately).</li>
            </ol>
            {infoQuery.data && (
              <p className="mt-2 break-all rounded bg-gray-50 p-2 font-mono text-[10px]">
                {endpoint}?token={infoQuery.data.token}
              </p>
            )}
          </details>
        </div>
      )}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

function NotificationsToggle() {
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
      <div className="rounded-md bg-blue-50 p-3 text-xs text-blue-900">
        <span className="font-medium">Morning report notifications:</span>{" "}
        {isIos
          ? "add this app to your Home Screen first (Share button, then 'Add to Home Screen'), then open it from there and this becomes a toggle."
          : "not supported in this browser."}
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
      <label className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">
          Morning report notification
          <span className="block text-xs font-normal text-gray-500">
            A push after each night: score, stats, and what the AI changed.
          </span>
        </span>
        <input
          type="checkbox"
          checked={browserSubscribed}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) void enable();
            else void disable();
          }}
          className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
        />
      </label>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

export const AiPanel: React.FC = () => {
  const utils = apiR.useUtils();
  const settingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const recommendationsQuery = apiR.user.getAiRecommendations.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );
  const liveAdjustmentsQuery = apiR.user.getLiveAdjustments.useQuery(
    undefined,
    { refetchOnWindowFocus: false },
  );

  const [aiEnabled, setAiEnabled] = useState(false);
  const [autoApply, setAutoApply] = useState(false);
  const [liveTuningEnabled, setLiveTuningEnabled] = useState(false);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>("celsius");
  const [sleepGoal, setSleepGoal] = useState("");
  const [maxDailyShift, setMaxDailyShift] = useState(20);
  const [settingsDirty, setSettingsDirty] = useState(false);

  useEffect(() => {
    if (settingsQuery.isSuccess && !settingsDirty) {
      const settings = settingsQuery.data;
      setAiEnabled(settings.aiEnabled);
      setAutoApply(settings.autoApply);
      setLiveTuningEnabled(settings.liveTuningEnabled);
      setDisplayUnit(settings.displayUnit);
      setSleepGoal(settings.sleepGoal ?? "");
      setMaxDailyShift(settings.maxDailyShift);
    }
  }, [settingsQuery.isSuccess, settingsQuery.data, settingsDirty]);

  const updateSettingsMutation = apiR.user.updateAiSettings.useMutation({
    onSuccess: async () => {
      setSettingsDirty(false);
      await utils.user.getAiSettings.invalidate();
    },
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

  if (settingsQuery.isLoading) {
    return null;
  }

  const aiAvailable = settingsQuery.data?.aiAvailable ?? false;
  const latest = recommendationsQuery.data?.[0];

  const markDirty = () => setSettingsDirty(true);

  const saveSettings = () => {
    updateSettingsMutation.mutate({
      aiEnabled,
      autoApply,
      liveTuningEnabled,
      displayUnit,
      sleepGoal: sleepGoal.trim() === "" ? null : sleepGoal.trim(),
      maxDailyShift,
    });
  };

  return (
    <>
      <SleepSummaryCard />

      <div className="mx-auto mt-4 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-center text-2xl font-bold text-gray-800">
          AI Autopilot
        </h2>
        <p className="mb-4 text-center text-sm text-gray-500">
          Tunes your four temperature stages every morning from last
          night&apos;s sleep data.
        </p>

        {!aiAvailable && (
          <div className="mb-4 rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
            The AI advisor is not configured yet. Add a{" "}
            <span className="font-mono font-medium">GEMINI_API_KEY</span>{" "}
            environment variable to the Vercel project (free key from Google AI
            Studio), then redeploy.
          </div>
        )}

        <div className="space-y-3 text-gray-800">
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              Enable daily AI recommendations
            </span>
            <input
              type="checkbox"
              checked={aiEnabled}
              onChange={(e) => {
                setAiEnabled(e.target.checked);
                markDirty();
              }}
              className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
          </label>

          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              Auto-apply without asking
            </span>
            <input
              type="checkbox"
              checked={autoApply}
              onChange={(e) => {
                setAutoApply(e.target.checked);
                markDirty();
              }}
              className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
          </label>

          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              Live night-time tuning
              <span className="block text-xs font-normal text-gray-500">
                Nudges the bed in 0.5°C steps during the night when tossing,
                heart rate, or bed temperature call for it.
              </span>
            </span>
            <input
              type="checkbox"
              checked={liveTuningEnabled}
              onChange={(e) => {
                setLiveTuningEnabled(e.target.checked);
                markDirty();
              }}
              className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
          </label>

          <NotificationsToggle />

          <HealthImportSection />

          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              Temperature display
            </span>
            <div className="flex overflow-hidden rounded-md border border-gray-300">
              <button
                type="button"
                onClick={() => {
                  setDisplayUnit("celsius");
                  markDirty();
                }}
                className={`px-3 py-1 text-sm ${displayUnit === "celsius" ? "bg-indigo-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}
              >
                °C
              </button>
              <button
                type="button"
                onClick={() => {
                  setDisplayUnit("level");
                  markDirty();
                }}
                className={`px-3 py-1 text-sm ${displayUnit === "level" ? "bg-indigo-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}
              >
                &minus;10&hellip;+10
              </button>
            </div>
          </div>

          <div>
            <label
              htmlFor="sleepGoal"
              className="block text-sm font-medium text-gray-700"
            >
              Your sleep preference (optional)
            </label>
            <textarea
              id="sleepGoal"
              value={sleepGoal}
              onChange={(e) => {
                setSleepGoal(e.target.value);
                markDirty();
              }}
              maxLength={500}
              rows={2}
              placeholder="e.g. I sleep hot and wake up around 3am sweating. Prioritize deep sleep."
              className="mt-1 block w-full rounded-md border border-gray-300 p-2 text-sm shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="maxDailyShift"
              className="block text-sm font-medium text-gray-700"
            >
              Max change per day: {maxDailyShift / 10}°C
              {displayUnit === "level" && (
                <span className="text-xs font-normal text-gray-500">
                  {" "}
                  (safety cap, roughly {maxDailyShift / 10} slider steps)
                </span>
              )}
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
                markDirty();
              }}
              className="h-3 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:shadow"
            />
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={saveSettings}
              disabled={!settingsDirty || updateSettingsMutation.isPending}
              className="flex-grow rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {updateSettingsMutation.isPending
                ? "Saving…"
                : "Save AI Settings"}
            </Button>
            <Button
              type="button"
              onClick={() => generateMutation.mutate()}
              disabled={!aiAvailable || generateMutation.isPending}
              className="flex-grow rounded-md border border-indigo-600 bg-white px-4 py-2 text-sm font-medium text-indigo-600 shadow-sm hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50"
            >
              {generateMutation.isPending ? "Thinking…" : "Optimize Now"}
            </Button>
          </div>

          {updateSettingsMutation.isError && (
            <p className="text-sm text-red-600">
              Failed to save settings: {updateSettingsMutation.error.message}
            </p>
          )}
          {generateMutation.isError && (
            <p className="text-sm text-red-600">
              {generateMutation.error.message}
            </p>
          )}
        </div>

        {latest && (
          <div className="mt-5 border-t border-gray-200 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">
                Latest recommendation ({latest.forDate})
              </span>
              <div className="flex items-center gap-2">
                <ConfidenceChip confidence={latest.confidence} />
                <StatusChip status={latest.status} />
              </div>
            </div>

            <div className="space-y-1">
              <LevelChange
                label="Initial stage"
                previous={latest.previousInitialLevel}
                recommended={latest.recommendedInitialLevel}
                unit={displayUnit}
              />
              {latest.previousDeepLevel != null &&
                latest.recommendedDeepLevel != null && (
                  <LevelChange
                    label="Deep stage"
                    previous={latest.previousDeepLevel}
                    recommended={latest.recommendedDeepLevel}
                    unit={displayUnit}
                  />
                )}
              <LevelChange
                label="Mid stage"
                previous={latest.previousMidLevel}
                recommended={latest.recommendedMidLevel}
                unit={displayUnit}
              />
              <LevelChange
                label="Final stage"
                previous={latest.previousFinalLevel}
                recommended={latest.recommendedFinalLevel}
                unit={displayUnit}
              />
            </div>

            <p className="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-900">
              {latest.reasoning}
            </p>

            {latest.status === "pending" && (
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  onClick={() => applyMutation.mutate({ id: latest.id })}
                  disabled={applyMutation.isPending}
                  className="flex-grow rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                >
                  {applyMutation.isPending ? "Applying…" : "Apply Tonight"}
                </Button>
                <Button
                  type="button"
                  onClick={() => dismissMutation.mutate({ id: latest.id })}
                  disabled={dismissMutation.isPending}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
                >
                  Dismiss
                </Button>
              </div>
            )}
            {applyMutation.isError && (
              <p className="mt-2 text-sm text-red-600">
                {applyMutation.error.message}
              </p>
            )}
          </div>
        )}

        {(liveAdjustmentsQuery.data?.length ?? 0) > 0 && (
          <div className="mt-5 border-t border-gray-200 pt-4">
            <div className="mb-2 text-sm font-medium text-gray-700">
              Recent live adjustments
            </div>
            <ul className="space-y-2">
              {liveAdjustmentsQuery.data!.map((adjustment) => (
                <li
                  key={adjustment.id}
                  className="rounded-md bg-gray-50 p-2 text-xs text-gray-700"
                >
                  <span className="font-medium">
                    {adjustment.night} ·{" "}
                    {new Date(adjustment.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {adjustment.stage} stage ·{" "}
                    {formatRawByUnit(adjustment.appliedLevel, displayUnit)}
                  </span>
                  <span className="block text-gray-500">
                    {adjustment.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
};

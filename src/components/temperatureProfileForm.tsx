"use client";
import React, { useState, useEffect } from "react";
import { useForm, Controller, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiR } from "~/trpc/react";
import TimezoneSelect, { allTimezones } from "react-timezone-select";
import { TemperatureCurve } from "./temperatureCurve";
import { Skeleton } from "./ui/card";
import { ConfirmDialog } from "./ui/confirmDialog";
import {
  celsiusToRaw,
  formatLevelScale,
  levelToRaw,
  MAX_BED_TEMP_C,
  MIN_BED_TEMP_C,
  rawToCelsius,
  rawToLevel,
  type DisplayUnit,
} from "~/lib/temperature";

const temperatureProfileSchema = z.object({
  bedTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  wakeupTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  initialSleepLevel: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
  deepSleepLevel: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
  midStageSleepLevel: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
  finalSleepLevel: z.number().min(MIN_BED_TEMP_C).max(MAX_BED_TEMP_C),
  timezone: z.object({
    value: z.string(),
    altName: z.string().optional(),
    abbrev: z.string().optional(),
  }),
});

type TemperatureProfileForm = z.infer<typeof temperatureProfileSchema>;

type LevelField =
  | "initialSleepLevel"
  | "deepSleepLevel"
  | "midStageSleepLevel"
  | "finalSleepLevel";

// Hoisted so typing in one slider never remounts the others.
const SliderInput: React.FC<{
  name: LevelField;
  label: string;
  control: Control<TemperatureProfileForm>;
  info?: string;
  displayUnit: DisplayUnit;
  error?: string;
}> = ({ name, label, control, info, displayUnit, error }) => (
  <div>
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <label
        htmlFor={name}
        className="text-sm font-medium"
        style={{ color: "var(--text-headline)" }}
      >
        {label}
      </label>
      {info && (
        <span className="text-xs" style={{ color: "var(--text-faint)" }}>
          {info}
        </span>
      )}
    </div>
    <Controller
      name={name}
      control={control}
      render={({ field: { onChange, value } }) => {
        // Form state is always °C; the slider renders in the user's preferred
        // unit and converts on the way in and out.
        const isLevel = displayUnit === "level";
        const shown = isLevel ? rawToLevel(celsiusToRaw(value)) : value;
        const min = isLevel ? -10 : MIN_BED_TEMP_C;
        const max = isLevel ? 10 : MAX_BED_TEMP_C;
        const setShown = (next: number) => {
          const clamped = Math.min(Math.max(next, min), max);
          onChange(isLevel ? rawToCelsius(levelToRaw(clamped)) : clamped);
        };
        return (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`Cooler: ${label}`}
              onClick={() => setShown(shown - 0.5)}
              className="btn btn-secondary h-9 w-9 shrink-0 px-0 text-lg"
            >
              &minus;
            </button>
            <input
              id={name}
              type="range"
              min={min}
              max={max}
              step="0.5"
              value={shown}
              onChange={(e) => setShown(Number(e.target.value))}
              className="slider"
            />
            <button
              type="button"
              aria-label={`Warmer: ${label}`}
              onClick={() => setShown(shown + 0.5)}
              className="btn btn-secondary h-9 w-9 shrink-0 px-0 text-lg"
            >
              +
            </button>
            <span
              className="tabular w-14 shrink-0 text-right text-sm font-semibold"
              style={{ color: "var(--accent)" }}
            >
              {isLevel ? formatLevelScale(shown) : `${shown}°C`}
            </span>
          </div>
        );
      }}
    />
    {error && (
      <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
        {error}
      </p>
    )}
  </div>
);

export const TemperatureProfileForm: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isExistingProfile, setIsExistingProfile] = useState(false);
  const [sleepDurationError, setSleepDurationError] = useState<string | null>(
    null,
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<TemperatureProfileForm>({
    resolver: zodResolver(temperatureProfileSchema),
    defaultValues: {
      bedTime: "22:00",
      wakeupTime: "06:00",
      initialSleepLevel: 27,
      deepSleepLevel: 27,
      midStageSleepLevel: 27,
      finalSleepLevel: 27,
      timezone: { value: "Europe/Brussels" },
    },
  });

  const bedTime = watch("bedTime");
  const wakeupTime = watch("wakeupTime");
  const curveTemps = {
    initial: watch("initialSleepLevel"),
    deep: watch("deepSleepLevel"),
    mid: watch("midStageSleepLevel"),
    final: watch("finalSleepLevel"),
  };

  const [sleepInfo, setSleepInfo] = useState({
    duration: "",
    deepStartTime: "",
    midStartTime: "",
    finalStageTime: "",
  });

  const getUserTemperatureProfileQuery =
    apiR.user.getUserTemperatureProfile.useQuery();
  // Same query the AI panel uses (deduped by react-query); only displayUnit is
  // read here. Falls back to °C until settings load.
  const aiSettingsQuery = apiR.user.getAiSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const displayUnit: DisplayUnit =
    aiSettingsQuery.data?.displayUnit === "level" ? "level" : "celsius";

  useEffect(() => {
    if (getUserTemperatureProfileQuery.isSuccess) {
      const profile = getUserTemperatureProfileQuery.data;
      setValue("bedTime", profile.bedTime.slice(0, 5));
      setValue("wakeupTime", profile.wakeupTime.slice(0, 5));
      setValue("initialSleepLevel", rawToCelsius(profile.initialSleepLevel));
      setValue(
        "deepSleepLevel",
        rawToCelsius(profile.deepSleepLevel ?? profile.midStageSleepLevel),
      );
      setValue("midStageSleepLevel", rawToCelsius(profile.midStageSleepLevel));
      setValue("finalSleepLevel", rawToCelsius(profile.finalSleepLevel));
      setValue("timezone", { value: profile.timezoneTZ });
      setIsExistingProfile(true);
      setIsLoading(false);
    } else if (getUserTemperatureProfileQuery.isError) {
      setIsExistingProfile(false);
      setIsLoading(false);
    }
  }, [
    getUserTemperatureProfileQuery.isSuccess,
    getUserTemperatureProfileQuery.isError,
    getUserTemperatureProfileQuery.data,
    setValue,
  ]);

  useEffect(() => {
    if (!bedTime || !wakeupTime) return;
    const bedDate = new Date(`2000-01-01T${bedTime}:00`);
    const wakeDate = new Date(`2000-01-01T${wakeupTime}:00`);
    if (wakeDate <= bedDate) wakeDate.setDate(wakeDate.getDate() + 1);

    const durationMs = wakeDate.getTime() - bedDate.getTime();
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.round((durationMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours < 4) {
      setSleepDurationError(
        "Make the window at least 4 hours — the four stages need room to run.",
      );
      setSleepInfo({
        duration: "",
        deepStartTime: "",
        midStartTime: "",
        finalStageTime: "",
      });
      return;
    }

    setSleepDurationError(null);
    const deepStartDate = new Date(bedDate.getTime() + 60 * 60 * 1000);
    const finalStageDate = new Date(wakeDate.getTime() - 2 * 60 * 60 * 1000);
    // Deep stage ends 3h after bedtime, clamped to the final-stage start.
    const midStartDate = new Date(
      Math.min(bedDate.getTime() + 3 * 60 * 60 * 1000, finalStageDate.getTime()),
    );

    setSleepInfo({
      duration: `${hours}h ${String(minutes).padStart(2, "0")}m`,
      deepStartTime: deepStartDate.toTimeString().slice(0, 5),
      midStartTime: midStartDate.toTimeString().slice(0, 5),
      finalStageTime: finalStageDate.toTimeString().slice(0, 5),
    });
  }, [bedTime, wakeupTime]);

  const updateProfileMutation =
    apiR.user.updateUserTemperatureProfile.useMutation({
      onSuccess: () => {
        setIsExistingProfile(true);
        setSavedAt(Date.now());
      },
    });

  const deleteProfileMutation =
    apiR.user.deleteUserTemperatureProfile.useMutation({
      onSuccess: () => {
        setIsExistingProfile(false);
        reset();
      },
    });

  useEffect(() => {
    if (savedAt == null) return;
    const timer = setTimeout(() => setSavedAt(null), 2500);
    return () => clearTimeout(timer);
  }, [savedAt]);

  const onSubmit = (data: TemperatureProfileForm) => {
    if (sleepDurationError) return;
    const formatTimeForAPI = (time: string) => `${time}:00.000000`;
    updateProfileMutation.mutate({
      bedTime: formatTimeForAPI(data.bedTime),
      wakeupTime: formatTimeForAPI(data.wakeupTime),
      initialSleepLevel: celsiusToRaw(data.initialSleepLevel),
      deepSleepLevel: celsiusToRaw(data.deepSleepLevel),
      midStageSleepLevel: celsiusToRaw(data.midStageSleepLevel),
      finalSleepLevel: celsiusToRaw(data.finalSleepLevel),
      timezoneTZ: data.timezone.value,
    });
  };



  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-24" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  return (
    <>
    <ConfirmDialog
      open={confirmDelete}
      title="Delete your temperature schedule?"
      body="The pod stops changing temperature on its own tonight, and the AI has no stages left to tune. You can create a new schedule at any time."
      confirmLabel="Delete schedule"
      cancelLabel="Keep my schedule"
      onCancel={() => setConfirmDelete(false)}
      onConfirm={() => {
        setConfirmDelete(false);
        deleteProfileMutation.mutate();
      }}
    />
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="bedTime"
            className="mb-1.5 block text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            Bed time
          </label>
          <input
            {...register("bedTime")}
            type="time"
            id="bedTime"
            className="field tabular"
            aria-invalid={!!errors.bedTime}
          />
          {errors.bedTime && (
            <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
              {errors.bedTime.message}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="wakeupTime"
            className="mb-1.5 block text-sm font-medium"
            style={{ color: "var(--text-headline)" }}
          >
            Wake-up time
          </label>
          <input
            {...register("wakeupTime")}
            type="time"
            id="wakeupTime"
            className="field tabular"
            aria-invalid={!!errors.wakeupTime}
          />
          {errors.wakeupTime && (
            <p className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
              {errors.wakeupTime.message}
            </p>
          )}
        </div>
      </div>

      {sleepDurationError ? (
        <p
          className="rounded-xl p-3 text-sm"
          style={{ backgroundColor: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {sleepDurationError}
        </p>
      ) : (
        <p
          className="rounded-xl p-3 text-sm"
          style={{ backgroundColor: "var(--surface-sunken)", color: "var(--text-muted)" }}
        >
          <span className="font-semibold" style={{ color: "var(--text-headline)" }}>
            {sleepInfo.duration}
          </span>{" "}
          in bed. The pod starts warming or cooling an hour before bed time.
        </p>
      )}

      {!sleepDurationError && (
        <TemperatureCurve
          bedTime={bedTime}
          wakeupTime={wakeupTime}
          temps={curveTemps}
          displayUnit={displayUnit}
        />
      )}

      <div className="space-y-4 pt-1">
        <SliderInput
          name="initialSleepLevel"
          label="Falling asleep"
          control={control}
          displayUnit={displayUnit}
          info={`from ${bedTime}`}
          error={errors.initialSleepLevel?.message}
        />
        <SliderInput
          name="deepSleepLevel"
          label="Deep sleep"
          control={control}
          displayUnit={displayUnit}
          info={`from ${sleepInfo.deepStartTime}`}
          error={errors.deepSleepLevel?.message}
        />
        <SliderInput
          name="midStageSleepLevel"
          label="Middle of the night"
          control={control}
          displayUnit={displayUnit}
          info={`from ${sleepInfo.midStartTime}`}
          error={errors.midStageSleepLevel?.message}
        />
        <SliderInput
          name="finalSleepLevel"
          label="REM and wake-up"
          control={control}
          displayUnit={displayUnit}
          info={`from ${sleepInfo.finalStageTime}`}
          error={errors.finalSleepLevel?.message}
        />
      </div>

      <div>
        <label
          htmlFor="timezone"
          className="mb-1.5 block text-sm font-medium"
          style={{ color: "var(--text-headline)" }}
        >
          Timezone
        </label>
        <Controller
          name="timezone"
          control={control}
          render={({ field }) => (
            <TimezoneSelect
              value={field.value}
              onChange={field.onChange}
              timezones={{
                ...allTimezones,
                "America/New_York": "America/New York",
                "America/Los_Angeles": "America/Los Angeles",
              }}
              // react-select paints its own surfaces, so it needs the tokens
              // handed to it explicitly or it stays white in dark mode.
              styles={{
                control: (base, state) => ({
                  ...base,
                  backgroundColor: "var(--surface-sunken)",
                  borderColor: state.isFocused
                    ? "var(--accent)"
                    : "var(--border)",
                  boxShadow: state.isFocused
                    ? "0 0 0 3px var(--accent-soft)"
                    : "none",
                  borderRadius: "0.625rem",
                  minHeight: "38px",
                  ":hover": { borderColor: "var(--border-strong)" },
                }),
                singleValue: (base) => ({ ...base, color: "var(--text)" }),
                input: (base) => ({ ...base, color: "var(--text)" }),
                placeholder: (base) => ({
                  ...base,
                  color: "var(--text-faint)",
                }),
                menu: (base) => ({
                  ...base,
                  backgroundColor: "var(--surface-raised)",
                  border: "1px solid var(--border-strong)",
                  boxShadow: "var(--shadow-pop)",
                  zIndex: 30,
                }),
                option: (base, state) => ({
                  ...base,
                  backgroundColor: state.isSelected
                    ? "var(--accent)"
                    : state.isFocused
                      ? "var(--surface-hover)"
                      : "transparent",
                  color: state.isSelected ? "var(--accent-ink)" : "var(--text)",
                  cursor: "pointer",
                }),
                dropdownIndicator: (base) => ({
                  ...base,
                  color: "var(--text-muted)",
                }),
                indicatorSeparator: (base) => ({
                  ...base,
                  backgroundColor: "var(--border)",
                }),
              }}
            />
          )}
        />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          className="btn btn-primary flex-1"
          disabled={updateProfileMutation.isPending || !!sleepDurationError}
        >
          {updateProfileMutation.isPending
            ? "Saving…"
            : isExistingProfile
              ? "Save schedule"
              : "Create schedule"}
        </button>
        {isExistingProfile && (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="btn btn-danger"
            disabled={deleteProfileMutation.isPending}
          >
            {deleteProfileMutation.isPending ? "Deleting…" : "Delete schedule"}
          </button>
        )}
      </div>

      {savedAt != null && (
        <p
          className="text-sm"
          style={{ color: "var(--success)", animation: "fadeIn 180ms" }}
        >
          Schedule saved.
        </p>
      )}
      {updateProfileMutation.isError && (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          Could not save: {updateProfileMutation.error.message}
        </p>
      )}
      {deleteProfileMutation.isError && (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          Could not delete: {deleteProfileMutation.error.message}
        </p>
      )}
    </form>
    </>
  );
};

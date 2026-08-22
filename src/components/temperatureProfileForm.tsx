"use client";
import React, { useState, useEffect } from "react";
import { useForm, Controller, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { apiR } from "~/trpc/react";
import TimezoneSelect, { allTimezones } from "react-timezone-select";
import { Button } from "./ui/button";
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
  bedTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
  wakeupTime: z.string().regex(/^\d{2}:\d{2}$/, "Must be in HH:MM format"),
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

export const TemperatureProfileForm: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [isExistingProfile, setIsExistingProfile] = useState(false);
  const [sleepDurationError, setSleepDurationError] = useState<string | null>(null);

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
      timezone: { value: "America/New_York"},
    },
  });

  const bedTime = watch("bedTime");
  const wakeupTime = watch("wakeupTime");

  const [sleepInfo, setSleepInfo] = useState({
    duration: "",
    deepStartTime: "",
    midStartTime: "",
    finalStageTime: "",
  });

  const getUserTemperatureProfileQuery = apiR.user.getUserTemperatureProfile.useQuery();
  // Same query the AI panel uses (deduped by react-query); only displayUnit
  // is read here. Falls back to °C until settings load.
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
      console.error("Failed to fetch temperature profile. Using default values.", getUserTemperatureProfileQuery.error);
      setIsExistingProfile(false);
      setIsLoading(false);
    }
  }, [getUserTemperatureProfileQuery.isSuccess, getUserTemperatureProfileQuery.isError, getUserTemperatureProfileQuery.data, setValue, getUserTemperatureProfileQuery.error]);

  useEffect(() => {
    if (bedTime && wakeupTime) {
      const bedDate = new Date(`2000-01-01T${bedTime}:00`);
      const wakeDate = new Date(`2000-01-01T${wakeupTime}:00`);

      if (wakeDate <= bedDate) {
        wakeDate.setDate(wakeDate.getDate() + 1);
      }

      const durationMs = wakeDate.getTime() - bedDate.getTime();
      const hours = Math.floor(durationMs / (1000 * 60 * 60));
      const minutes = Math.round((durationMs % (1000 * 60 * 60)) / (1000 * 60));

      // Check if sleep duration is less than 4 hours
      if (hours < 4 ) {
        setSleepDurationError("Sleep duration must be at least 4 hours.");
        setSleepInfo({ duration: "", deepStartTime: "", midStartTime: "", finalStageTime: "" });
      } else {
        setSleepDurationError(null);
        const deepStartDate = new Date(bedDate.getTime() + 60 * 60 * 1000); // 1 hour after bedtime
        const finalStageDate = new Date(wakeDate.getTime() - 2 * 60 * 60 * 1000); // 2 hours before wakeup
        // Deep stage ends 3h after bedtime, clamped to the final-stage start.
        const midStartDate = new Date(
          Math.min(bedDate.getTime() + 3 * 60 * 60 * 1000, finalStageDate.getTime()),
        );

        setSleepInfo({
          duration: `${hours} hours ${minutes} minutes`,
          deepStartTime: deepStartDate.toTimeString().slice(0, 5),
          midStartTime: midStartDate.toTimeString().slice(0, 5),
          finalStageTime: finalStageDate.toTimeString().slice(0, 5),
        });
      }
    }
  }, [bedTime, wakeupTime]);

  const updateProfileMutation =
    apiR.user.updateUserTemperatureProfile.useMutation({
      onSuccess: () => {
        console.log("Temperature profile updated successfully");
        setIsExistingProfile(true); // Update the state after successful creation/update
      },
      onError: (error) => {
        console.error("Failed to update temperature profile:", error.message);
      },
    });

  const deleteProfileMutation =
    apiR.user.deleteUserTemperatureProfile.useMutation({
      onSuccess: () => {
        console.log("Temperature profile deleted successfully");
        setIsExistingProfile(false);
        reset(); // Reset form to default values
      },
      onError: (error) => {
        console.error("Failed to delete temperature profile:", error.message);
      },
    });

  const onSubmit = (data: TemperatureProfileForm) => {
    if (sleepDurationError) {
      return; // Prevent submission if there's a sleep duration error
    }

    const formatTimeForAPI = (time: string) => `${time}:00.000000`;

    const mutationData = {
      bedTime: formatTimeForAPI(data.bedTime),
      wakeupTime: formatTimeForAPI(data.wakeupTime),
      initialSleepLevel: celsiusToRaw(data.initialSleepLevel),
      deepSleepLevel: celsiusToRaw(data.deepSleepLevel),
      midStageSleepLevel: celsiusToRaw(data.midStageSleepLevel),
      finalSleepLevel: celsiusToRaw(data.finalSleepLevel),
      timezoneTZ: data.timezone.value,
    };

    console.log('Data being sent to server:', mutationData);

    updateProfileMutation.mutate(mutationData);
  };

  const onDelete = () => {
    if (window.confirm("Are you sure you want to delete your temperature profile?")) {
      deleteProfileMutation.mutate();
    }
  };

  const SliderInput: React.FC<{
    name:
      | "initialSleepLevel"
      | "deepSleepLevel"
      | "midStageSleepLevel"
      | "finalSleepLevel";
    label: string;
    control: Control<TemperatureProfileForm>;
    info?: string;
  }> = ({ name, label, control, info }) => (
    <div className="mb-4">
      <label htmlFor={name} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <Controller
        name={name}
        control={control}
        render={({ field: { onChange, value } }) => {
          // Form state is always °C; the slider renders in the user's
          // preferred unit and converts on the way in and out.
          const isLevel = displayUnit === "level";
          const shown = isLevel ? rawToLevel(celsiusToRaw(value)) : value;
          const min = isLevel ? -10 : MIN_BED_TEMP_C;
          const max = isLevel ? 10 : MAX_BED_TEMP_C;
          const setShown = (next: number) => {
            const clamped = Math.min(Math.max(next, min), max);
            onChange(isLevel ? rawToCelsius(levelToRaw(clamped)) : clamped);
          };
          const stepButton =
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-gray-300 bg-white text-lg font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100";
          return (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={`Decrease ${label}`}
                onClick={() => setShown(shown - 0.5)}
                className={stepButton}
              >
                &minus;
              </button>
              <input
                type="range"
                min={min}
                max={max}
                step="0.5"
                value={shown}
                onChange={(e) => setShown(Number(e.target.value))}
                className="h-3 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 accent-indigo-600 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:shadow"
              />
              <button
                type="button"
                aria-label={`Increase ${label}`}
                onClick={() => setShown(shown + 0.5)}
                className={stepButton}
              >
                +
              </button>
              <span className="w-14 shrink-0 text-right text-sm text-gray-600">
                {isLevel ? formatLevelScale(shown) : `${shown}°C`}
              </span>
            </div>
          );
        }}
      />
      {info && <p className="mt-1 text-sm text-blue-600">{info}</p>}
      {errors[name] && (
        <p className="mt-1 text-sm text-red-600">{errors[name]?.message}</p>
      )}
    </div>
  );

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="mx-auto mt-8 max-w-md rounded-lg bg-white p-6 shadow-xl">
      <h2 className="mb-4 text-center text-2xl font-bold text-gray-800">
        {isExistingProfile ? "Update" : "Create"} Temperature Profile
      </h2>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-4 text-gray-800"
      >
        <div>
          <label
            htmlFor="timezone"
            className="block text-sm font-medium text-gray-700"
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
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
              />
            )}
          />
          {errors.timezone && (
            <p className="mt-1 text-sm text-red-600">
              {errors.timezone.message}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="bedTime"
            className="block text-sm font-medium text-gray-700"
          >
            Bed Time
          </label>
          <input
            {...register("bedTime")}
            type="time"
            id="bedTime"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
          />
          {errors.bedTime && (
            <p className="mt-1 text-sm text-red-600">
              {errors.bedTime.message}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="wakeupTime"
            className="block text-sm font-medium text-gray-700"
          >
            Wake-up Time
          </label>
          <input
            {...register("wakeupTime")}
            type="time"
            id="wakeupTime"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50"
          />
          {errors.wakeupTime && (
            <p className="mt-1 text-sm text-red-600">
              {errors.wakeupTime.message}
            </p>
          )}
        </div>

        <div className="rounded-md bg-blue-50 p-4">
          {sleepDurationError ? (
            <p className="text-sm text-red-600">{sleepDurationError}</p>
          ) : (
            <p className="text-sm text-blue-800">
              Sleep Duration: {sleepInfo.duration}
              <br />
              Bed will prepare for sleep one hour before the bed time.
            </p>
          )}
        </div>

        <SliderInput
          name="initialSleepLevel"
          label="Initial Sleep Temperature"
          control={control}
          info={`Sleep onset — starts at ${bedTime}`}
        />
        <SliderInput
          name="deepSleepLevel"
          label="Deep Sleep Temperature"
          control={control}
          info={`Slow-wave sleep window, usually the coolest — starts at ${sleepInfo.deepStartTime}`}
        />
        <SliderInput
          name="midStageSleepLevel"
          label="Mid-Stage Sleep Temperature"
          control={control}
          info={`Starts at ${sleepInfo.midStartTime}`}
        />
        <SliderInput
          name="finalSleepLevel"
          label="Final Sleep Temperature"
          control={control}
          info={`REM and wake-up — starts at ${sleepInfo.finalStageTime}`}
        />

        <div className="flex justify-between">
          <Button
            type="submit"
            className="flex-grow rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            disabled={updateProfileMutation.isPending || !!sleepDurationError}
          >
            {updateProfileMutation.isPending ? "Updating..." : (isExistingProfile ? "Update" : "Create") + " Profile"}
          </Button>
          {isExistingProfile && (
            <Button
              type="button"
              onClick={onDelete}
              className="ml-4 rounded-md border border-transparent bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              disabled={deleteProfileMutation.isPending}
            >
              {deleteProfileMutation.isPending ? "Deleting..." : "Delete Schedule"}
            </Button>
          )}
        </div>
        {updateProfileMutation.isError && (
          <p className="mt-4 text-center text-sm text-red-600">
            Error updating profile. Please try again.
            {updateProfileMutation.error.message}
          </p>
        )}
        {deleteProfileMutation.isError && (
          <p className="mt-4 text-center text-sm text-red-600">
            Error deleting profile. Please try again.
            {deleteProfileMutation.error.message}
          </p>
        )}
      </form>
    </div>
  );
};
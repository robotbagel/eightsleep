// temperature.ts
// Conversion between Eight Sleep's raw heating levels (-100..100) and bed
// water temperature in °C (13..44). Safe to import from client and server.
// The mapping is the community-documented calibration table; values between
// calibration points are linearly interpolated in both directions.

const RAW_TO_CELSIUS: [number, number][] = [
  [-100, 13],
  [-97, 14],
  [-94, 15],
  [-91, 16],
  [-83, 17],
  [-75, 18],
  [-67, 19],
  [-58, 20],
  [-50, 21],
  [-42, 22],
  [-33, 23],
  [-25, 24],
  [-17, 25],
  [-8, 26],
  [0, 27],
  [6, 28],
  [11, 29],
  [17, 30],
  [22, 31],
  [28, 32],
  [33, 33],
  [39, 34],
  [44, 35],
  [50, 36],
  [56, 37],
  [61, 38],
  [67, 39],
  [72, 40],
  [78, 41],
  [83, 42],
  [89, 43],
  [100, 44],
];

export const MIN_BED_TEMP_C = 13;
export const MAX_BED_TEMP_C = 44;

export function rawToCelsius(raw: number): number {
  const clamped = Math.min(Math.max(raw, -100), 100);
  for (let i = 1; i < RAW_TO_CELSIUS.length; i++) {
    const [rawHigh, celsiusHigh] = RAW_TO_CELSIUS[i]!;
    if (clamped <= rawHigh) {
      const [rawLow, celsiusLow] = RAW_TO_CELSIUS[i - 1]!;
      if (clamped <= rawLow) return celsiusLow;
      const ratio = (clamped - rawLow) / (rawHigh - rawLow);
      return (
        Math.round((celsiusLow + ratio * (celsiusHigh - celsiusLow)) * 10) / 10
      );
    }
  }
  return MAX_BED_TEMP_C;
}

export function celsiusToRaw(celsius: number): number {
  const clamped = Math.min(Math.max(celsius, MIN_BED_TEMP_C), MAX_BED_TEMP_C);
  for (let i = 1; i < RAW_TO_CELSIUS.length; i++) {
    const [rawHigh, celsiusHigh] = RAW_TO_CELSIUS[i]!;
    if (clamped <= celsiusHigh) {
      const [rawLow, celsiusLow] = RAW_TO_CELSIUS[i - 1]!;
      if (clamped <= celsiusLow) return rawLow;
      const ratio = (clamped - celsiusLow) / (celsiusHigh - celsiusLow);
      return Math.round(rawLow + ratio * (rawHigh - rawLow));
    }
  }
  return 100;
}

export function formatCelsius(celsius: number): string {
  return `${celsius.toFixed(1).replace(/\.0$/, "")}°C`;
}

// The Eight Sleep app's slider scale: -10 (coldest) .. +10 (warmest), which
// is exactly the raw level divided by 10.
export type DisplayUnit = "celsius" | "level";

export function rawToLevel(raw: number): number {
  return Math.round(raw) / 10;
}

export function levelToRaw(level: number): number {
  return Math.round(level * 10);
}

export function formatLevelScale(level: number): string {
  const text = level.toFixed(1).replace(/\.0$/, "");
  return level > 0 ? `+${text}` : text;
}

export function formatRawByUnit(raw: number, unit: DisplayUnit): string {
  return unit === "level"
    ? formatLevelScale(rawToLevel(raw))
    : formatCelsius(rawToCelsius(raw));
}

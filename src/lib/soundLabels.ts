// Plain names for the on-device classifier's sound labels (sound.ts).
const LABELS: Record<string, string> = {
  cat_meow: "cat meowing",
  cat_purr: "cat purring",
  cat: "cat",
  cat_moving: "cat moving (camera)",
  thump_thud: "thud",
  door: "door",
  door_slam: "door slam",
  door_sliding: "sliding door",
  knock: "knock",
  snoring: "snoring",
  speech: "talking",
  laughter: "laughter",
  cough: "cough",
  dog: "dog",
  dog_bark: "dog barking",
  baby_crying: "baby crying",
  alarm_clock: "alarm",
  siren: "siren",
  squeak: "squeak",
  music: "music",
  loud: "loud noise",
};

export function soundLabel(kind: string): string {
  return LABELS[kind] ?? kind.replace(/_/g, " ");
}

/** "2 cat meowing, 1 thud" sorted by count. */
export function soundCountsText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n}× ${soundLabel(kind)}`)
    .join(", ");
}

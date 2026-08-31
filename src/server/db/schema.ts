import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTableCreator,
  serial,
  text,
  time,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `8slp_${name}`); // also in drizzle.config.ts

export const users = createTable("users", {
  email: varchar("email", { length: 255 }).notNull().primaryKey(),
  eightUserId: varchar("eightUserId", { length: 255 }).notNull(),
  eightAccessToken: text("access_token").notNull(),
  eightRefreshToken: text("refresh_token").notNull(),
  eightTokenExpiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userTemperatureProfile = createTable("userTemperatureProfiles", {
  email: varchar('email', { length: 255 }).references(() => users.email).primaryKey(),
  bedTime: time("bedTime").notNull(),
  wakeupTime: time("wakeupTime").notNull(),
  initialSleepLevel: integer("initialSleepLevel").notNull(),
  // Deep-sleep stage (bedtime+1h to bedtime+3h): the coolest point of the
  // night curve. Nullable for rows created before the stage existed — code
  // falls back to midStageSleepLevel when null.
  deepSleepLevel: integer("deepSleepLevel"),
  midStageSleepLevel: integer("midStageSleepLevel").notNull(),
  finalSleepLevel: integer("finalSleepLevel").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  timezoneTZ: varchar("timezone", { length: 50 }).notNull(),
});

export const userAiSettings = createTable(
  "userAiSettings",
  {
    email: varchar("email", { length: 255 }).references(() => users.email).primaryKey(),
    aiEnabled: boolean("aiEnabled").notNull().default(false),
    autoApply: boolean("autoApply").notNull().default(false),
    liveTuningEnabled: boolean("liveTuningEnabled").notNull().default(false),
    displayUnit: varchar("displayUnit", { length: 10 }).notNull().default("celsius"),
    // Bearer token for the Apple Health import endpoint (per user, generated
    // on demand). Plain index, not unique: a unique constraint on a new
    // column makes drizzle push prompt interactively, which would hang the
    // Vercel build. UUID collisions are not a practical concern.
    healthImportToken: varchar("healthImportToken", { length: 64 }),
    sleepGoal: text("sleepGoal"),
    maxDailyShift: integer("maxDailyShift").notNull().default(20),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    healthTokenIdx: index("userAiSettings_healthImportToken_idx").on(
      table.healthImportToken,
    ),
  }),
);

export const aiLiveAdjustments = createTable(
  "aiLiveAdjustments",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    night: varchar("night", { length: 10 }).notNull(),
    // 16, not 10: "pre-heating" is 11 characters, and at length 10 the
    // insert failed SILENTLY inside detectManualOverride — the event row
    // saved, the offset didn't, and the next boundary write reverted the
    // sleeper's pre-bed adjustment (observed live 2026-08-30 23:10).
    stage: varchar("stage", { length: 16 }).notNull(),
    offsetDelta: integer("offsetDelta").notNull(),
    newOffset: integer("newOffset").notNull(),
    appliedLevel: integer("appliedLevel").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    emailNightIdx: index("aiLiveAdjustments_email_night_idx").on(
      table.email,
      table.night,
    ),
  }),
);

export const aiRecommendations = createTable(
  "aiRecommendations",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    forDate: varchar("forDate", { length: 10 }).notNull(),
    previousInitialLevel: integer("previousInitialLevel").notNull(),
    previousDeepLevel: integer("previousDeepLevel"),
    previousMidLevel: integer("previousMidLevel").notNull(),
    previousFinalLevel: integer("previousFinalLevel").notNull(),
    recommendedInitialLevel: integer("recommendedInitialLevel").notNull(),
    recommendedDeepLevel: integer("recommendedDeepLevel"),
    recommendedMidLevel: integer("recommendedMidLevel").notNull(),
    recommendedFinalLevel: integer("recommendedFinalLevel").notNull(),
    reasoning: text("reasoning").notNull(),
    confidence: varchar("confidence", { length: 10 }).notNull(),
    sleepContextJson: text("sleepContextJson"),
    // Structured "why": per-stage rationale, the evidence the model used,
    // what it expects to improve, and the principle behind it. JSON so the
    // shape can grow without a migration; see RecommendationRationale.
    rationaleJson: text("rationaleJson"),
    status: varchar("status", { length: 20 }).notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    model: varchar("model", { length: 50 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    emailDateIdx: index("aiRecommendations_email_forDate_idx").on(
      table.email,
      table.forDate,
    ),
  }),
);

// How the night actually FELT, asked once each morning. Every other input the
// loop has is inferred — tossing is a proxy for discomfort, a raised heart
// rate is a proxy for being too warm. This is the only direct measurement of
// the thing the bed exists to get right, so it outranks the proxies.
export const sleepFeedback = createTable(
  "sleepFeedback",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    /** Wake date, the app's night key everywhere. */
    night: varchar("night", { length: 10 }).notNull(),
    /** too_hot | too_cold | just_right */
    felt: varchar("felt", { length: 16 }).notNull(),
    /** falling_asleep | middle | morning | all_night — which stage to move. */
    whenFelt: varchar("whenFelt", { length: 16 }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    emailNightIdx: index("sleepFeedback_email_night_idx").on(
      table.email,
      table.night,
    ),
  }),
);

// One row per attempt of the daily AI pass, per user per day. Without this a
// failed pass is invisible: the app simply keeps showing yesterday's plan and
// nothing says why. The monitor reads it to tell "the cron never ran" apart
// from "the cron ran and Gemini refused".
export const aiRunLog = createTable(
  "aiRunLog",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    forDate: varchar("forDate", { length: 10 }).notNull(),
    at: timestamp("at").defaultNow().notNull(),
    phase: varchar("phase", { length: 24 }).notNull(),
    ok: boolean("ok").notNull(),
    detail: text("detail"),
  },
  (table) => ({
    emailDateIdx: index("aiRunLog_email_forDate_idx").on(
      table.email,
      table.forDate,
    ),
  }),
);

// One row per night per account: the metrics we extract from the pod's own
// session record, cached so the 7/14/30-day comparison does not re-page the
// Eight Sleep API on every view (and so history outlives what the API keeps).
// Fractional values are stored in tenths as integers, matching the rest of
// the schema. Keyed by the WAKE date, like every other night key in the app.
export const nightMetrics = createTable(
  "nightMetrics",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    night: varchar("night", { length: 10 }).notNull(),
    score: integer("score"),
    /** Only what bed temperature can move — the control loop's objective. */
    thermalScore: integer("thermalScore"),
    asleepTenthHours: integer("asleepTenthHours"),
    inBedTenthHours: integer("inBedTenthHours"),
    deepTenthHours: integer("deepTenthHours"),
    remTenthHours: integer("remTenthHours"),
    lightTenthHours: integer("lightTenthHours"),
    awakeTenthHours: integer("awakeTenthHours"),
    tosses: integer("tosses"),
    wakeCount: integer("wakeCount"),
    restingHeartRate: integer("restingHeartRate"),
    avgHeartRate: integer("avgHeartRate"),
    hrv: integer("hrv"),
    respiratoryTenth: integer("respiratoryTenth"),
    avgBedTempTenthC: integer("avgBedTempTenthC"),
    avgRoomTempTenthC: integer("avgRoomTempTenthC"),
    bedtimeMinutes: integer("bedtimeMinutes"),
    wakeMinutes: integer("wakeMinutes"),
    source: varchar("source", { length: 16 }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    // Plain index, not unique: `pnpm db:push` prompts interactively when it
    // adds a UNIQUE constraint and that hangs the Vercel build. Writes go
    // through deleteThenInsert per night instead.
    emailNightIdx: index("nightMetrics_email_night_idx").on(
      table.email,
      table.night,
    ),
  }),
);

// One row per imported night from Apple Health (per account). Hours are
// stored as tenths of an hour (integers) to keep the schema int-only.
export const healthNights = createTable(
  "healthNights",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    night: varchar("night", { length: 10 }).notNull(),
    asleepTenthHours: integer("asleepTenthHours").notNull(),
    deepTenthHours: integer("deepTenthHours"),
    remTenthHours: integer("remTenthHours"),
    coreTenthHours: integer("coreTenthHours"),
    awakeTenthHours: integer("awakeTenthHours"),
    wakeCount: integer("wakeCount"),
    avgHeartRate: integer("avgHeartRate"),
    hrv: integer("hrv"),
    respiratoryRateTenths: integer("respiratoryRateTenths"),
    score: integer("score").notNull(),
    sleepStart: timestamp("sleepStart"),
    sleepEnd: timestamp("sleepEnd"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    emailNightIdx: uniqueIndex("healthNights_email_night_idx").on(
      table.email,
      table.night,
    ),
  }),
);

// Every temperature change this app actually sends to the pod, so the app can
// show a truthful timeline of the night (scheduled stage changes, AI live
// nudges, and turn on/off events).
export const temperatureEvents = createTable(
  "temperatureEvents",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    night: varchar("night", { length: 10 }).notNull(),
    at: timestamp("at").defaultNow().notNull(),
    stage: varchar("stage", { length: 16 }).notNull(),
    level: integer("level"),
    source: varchar("source", { length: 16 }).notNull(),
    note: text("note"),
  },
  (table) => ({
    emailNightIdx: index("temperatureEvents_email_night_idx").on(
      table.email,
      table.night,
    ),
  }),
);

export const pushSubscriptions = createTable("pushSubscriptions", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Small key/value store for server-generated configuration (e.g. the VAPID
// keypair for web push, created once on first use so no manual env setup is
// needed).
export const appConfig = createTable("appConfig", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one }) => ({
  temperatureProfile: one(userTemperatureProfile, {
    fields: [users.email],
    references: [userTemperatureProfile.email],
  }),
}));

export const userTemperatureProfileRelations = relations(userTemperatureProfile, ({ one }) => ({
  user: one(users, {
    fields: [userTemperatureProfile.email],
    references: [users.email],
  }),
}));
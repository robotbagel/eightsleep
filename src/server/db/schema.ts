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

export const userAiSettings = createTable("userAiSettings", {
  email: varchar("email", { length: 255 }).references(() => users.email).primaryKey(),
  aiEnabled: boolean("aiEnabled").notNull().default(false),
  autoApply: boolean("autoApply").notNull().default(false),
  liveTuningEnabled: boolean("liveTuningEnabled").notNull().default(false),
  displayUnit: varchar("displayUnit", { length: 10 }).notNull().default("celsius"),
  sleepGoal: text("sleepGoal"),
  maxDailyShift: integer("maxDailyShift").notNull().default(20),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const aiLiveAdjustments = createTable(
  "aiLiveAdjustments",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).references(() => users.email).notNull(),
    night: varchar("night", { length: 10 }).notNull(),
    stage: varchar("stage", { length: 10 }).notNull(),
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
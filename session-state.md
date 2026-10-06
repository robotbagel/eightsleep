# Session State

Project: **8sleep nosub app** (Eight Sleep without a subscription + AI temperature autopilot)
Last verified: **2026-10-05**. Everything below was checked live against production on that date, not recalled.

## Read these first
- **Deep history and every gotcha already paid for:** `~/.claude/projects/-Users-nathan/memory/project_eightsleep_nosub_ai.md`. It is long and it is the real reference. Do not re-derive anything in it.
- **Interface contract (required before editing any UI):** `ia-contract.json` in this repo. A PreToolUse hook blocks UI edits until it exists.
- This file is the short version: where things stand and what is open.

## What it is
Fork of `aerotow/eightsleep-nosub-app` at **github.com/robotbagel/eightsleep**, deployed on Vercel at **8sleep-jade.vercel.app** (Neon Postgres, Frankfurt). Local clone `~/Apps/eightsleep`.

Two live accounts, one per side of the bed: `getnathan@outlook.com` and `getlaurence@outlook.com`.

A systemd user timer on **supernova** hits `/api/temperatureCron` every 10 minutes (primary); the Mac runs a `*/30` fallback. Both were 9 minutes stale and healthy on 2026-10-05.

## Deploying and checking
```bash
git push origin main          # Vercel auto-builds; takes 15-20 min lately
# A commit's status API lies about readiness. Poll the capability itself:
S=$(cat ~/.config/8sleep/cron-secret)
curl -s -H "Authorization: Bearer $S" "https://8sleep-jade.vercel.app/api/aiStatus?days=14"
# After ANY schema change, and add the new column to its statement list first:
curl -s -X POST -H "Authorization: Bearer $S" ".../api/aiDebug?action=migrate"
npm test        # 62 assertions: control, score, identity, presence, hold, shareLinks
```
Local builds need Node 22 (`/usr/local/bin/node`). `SKIP_ENV_VALIDATION=1 npx next build` to build without prod env.

## Built on 2026-09-14 (all deployed and verified)
1. **Scoring rebuilt to match Apple.** Interruptions now use awake-after-onset only; the pod's `awakeDuration` also counts time in bed before sleep and after waking, which cost 10-16 points a night. Rubric fitted against five Apple screenshots.
2. **Sleep-onset latency** is stored, scored, explained, and drives a signal when the 3-night mean is 30 min or more.
3. **Apple Watch second opinion** on nights where both sensors recorded.
4. **Away and empty-bed handling.** An `awayUntil` date the bed obeys, plus an inferred shutoff an hour past bedtime when nobody is in it, which re-arms on presence.
5. **Hold counts measured nights, not calendar days.** Two empty nights used to expire the hold and let the loop re-judge a night it had already used.
6. **Guest detection** from nocturnal vitals. Breathing rate is the anchor; it separates the two real sleepers by 4.7 MADs while the widest own-night is 1.3.
7. **Share links**, guest and household. Opaque secret, SHA-256 stored, revocable. A guest sets all four stages as an overlay that never writes the owner's row, and reads back their own nights only.
8. **Live plus/minus** on both the owner's app and the guest page. The press is the comfort report: direction plus current stage, no words asked.

## 2026-10-05 session: holiday audit + iOS 27-style overview
Replayed 15 Sep - 4 Oct from production (event trail, raw pod sessions, monitor.log). Findings and fixes (commit db9c069):
- Nathan's 2-week silence was **away mode he set** ("AWAY until 2026-10-04" in monitor.log), not a pod outage. The previous handoff's open item 2 was wrong.
- Empty-bed shutoff **flapped**: every stage boundary switched the empty side back on. Fixed (`stay-off`); re-arm now heats immediately; after 2 empty nights the bed waits for someone instead of pre-heating.
- **Stale evidence moved both profiles 7 times while nobody was home**: hold window was the newest 4 recs (a daily no-change row each morning), so the last real change scrolled out and its spent comfort reports voted again every 5th day. Fixed + `evidenceGate` (away / change not slept on / nothing new = hold) + reports >7 days or about guest nights never vote.
- Away date now means **home again on** (that night runs).
- Identity used the fetched batch as the baseline, which was guests and cats: Laurence's mother-in-law entered the ledger as 3 of Laurence's nights. Now judged against stored own nights. Sessions <3 h asleep or breathing >=20/min are not nights (all cat sessions measured 20.4-25.3/min; humans 13.1-17.1). One row per wake date.
- Guest links have `startsOn`; every night of the stay is the guest's. Live tuner used the owner's stage temps and "you reported running hot" on the guest: fixed. Guest hand adjustments no longer filed as owner feedback.
- Failed 10-min ticks go to `aiRunLog` phase `schedule`, reported as `aiStatus.scheduleFailures` and flagged by the monitor.

UI (commit c214a16): summary chips, verdict headline + reading against your own usual (`src/lib/insights.ts`, tested), helped/held-back rows, one tip, vitals on personal ranges (`vitalsCard.tsx`). Score bands now Apple's 81/61.

**Deploys:** the Vercel dashboard build command ran `drizzle-kit push`, which hangs on an interactive prompt (no TTY) whenever the schema changes; two deploys died at the 45-min timeout. `vercel.json` now sets `"buildCommand": "next build"` (commit 95f36db), builds take ~2 min instead of 15-20. **Schema changes are applied ONLY by `POST /api/aiDebug?action=migrate`** after deploy; add every new column to its list. (4-model ChatHub review recommended moving to committed `drizzle-kit generate` migrations; that needs Neon credentials, which this Mac does not have.)

**Post-deploy, done 2026-10-05 ~09:40 UTC:** migrate (applied 13), identity corrections (Nathan 09-15 = him; 09-16..18 = guest on both sides), rescore both (cat/nap rows purged: 3 Nathan, 9 Laurence). Stored history now: guest nights flagged, no cat nights. Identity now flags breathing >= 6 MADs on its own (commit c748813). Traced cron tick clean, monitor clean.

## Bedroom TV (2026-10-05, commit c9e1f64)
They watch ~45 min on the bedroom projector before sleeping; the pod counted it as time to fall asleep. The projector's smart part is a **Chromecast with Google TV, friendly name "Bedroom TV", 192.168.50.213**; its Cast status `is_stand_by` follows the projector over HDMI-CEC.
- Watcher: Docker container `screen-watch` on Supernova, `/volume2/docker/stacks/screen-watch` (source in `deploy/screen-watch/`, copy over with `cat | ssh`, then `docker compose up -d --build`). Posts settled changes (20 s) to `/api/screenEvent`; unreachable for 90 s = off; heartbeat every 5 min.
- `screen.ts` + `attachScreenTime` in `fetchPodSessions`: latency counts from lights out everywhere. nightMetrics keeps `podLatencyTenthHours` and `screenTenthHours`.
- `aiStatus.screenWatcher`, monitor flags >30 min silent and prints last night's TV minutes.
- **Not yet observed with the projector ON.** First real night is 5->6 Oct; check `aiStatus.screenWatcher.recent` and the monitor line. If CEC does not report the projector going off, the "on" will last until the dongle's own sleep timer and nights will read "fell asleep watching".

## Apple Watch sync (2026-10-05)
Manual Shortcut imports were abandoned after one use (Nathan won't add a daily step). **`ios/SleepSync`**: SwiftUI companion app, bundle `now.geshido.sleepsync`, team WCV67Q95XA, HealthKit background delivery on sleepAnalysis. It posts each new Watch night (Watch-sourced samples only, nights >= 3 h, plus HR/HRV/breathing averages) to `/api/healthImport`; the first run backfills 45 days. The token is in gitignored `ios/SleepSync/Secrets.xcconfig` (`aiDebug?action=healthtoken`). Installed straight to Nathan's iPhone 15 Pro over Wi-Fi with `devicectl` (no TestFlight); **the development profile expires 2027-10-05**, so rebuild and reinstall before then: `xcodegen generate && xcodebuild ... -allowProvisioningUpdates -authenticationKey* build`, then `devicectl device install app`. Apple's own Sleep Score is NOT readable by any app; the "Apple Watch" score shown is our Apple-fitted rubric on the Watch's stages.

## Night sounds + lost signal (2026-10-06)
- Sleep Sync 1.0 (2) adds `NightListener` (SoundAnalysis `.version1` classifier + level meter vs the room's 10th-percentile quiet), uploads every 5 min to `/api/soundEvents` (health token), Live Activity while listening, App Intents Start/Stop for Shortcuts. iOS only allows starting recording in the foreground (Apple forum 815725), so Start opens the app.
- `sound.ts` matches sounds to pod wake-ups/tosses with a chance baseline (`likelyCause`); live tuner ignores tosses within 2 min after a sound. `nightMetrics.soundJson`.
- Lost signal: a session that opens 20+ min before the first vitals counts from the first reading (`signalGapHours`); 5-6 Oct Laurence read nothing 23:30-02:10 and the pod called it 2h55 awake. Night card explains; insights skip the duration verdict.
- A harmless `setup_test` sound row exists at 2026-10-06 ~08:2x UTC (daytime, outside any sleep window).
- First listening night not yet observed. Nathan sets two Shortcuts automations (Bedtime Begins -> Start Night Listening; Waking Up -> Stop).

## Open items
- Both profiles drifted while away (Nathan mid 26.3 -> 24.8, deep 26.5 -> 26; Laurence deep 28.6 -> 30.2), all from stale evidence. Restoring the pre-holiday profiles is Nathan's call.

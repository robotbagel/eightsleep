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

## Open items
**1. Naps are stored and displayed as nights.** Confirmed in the raw pod data: a 36-minute lie-down on 09-26 and a 2h12m afternoon nap on 09-14 are both stored as nights, scoring 15 and 25. `sessionsToMetrics` keeps anything with `sleepDuration > 0`.
- Not harmful to the loop: `thermalScore` returns null under 2 hours, so these are already excluded from the ledger.
- It is harmful to what you read: they appear in history and they drag the "compared with usual" averages that `buildVerdict` computes.
- Suggested fix: a minimum-night threshold in `sessionsToMetrics`, kept separate from the existing thermal cutoff so a nap is not shown as a night at all. Needs one decision from Nathan: what is the shortest thing that counts as a night, and should naps be visible somewhere rather than dropped.

**2. The scheduler leaves no trace when the pod is unreachable.** Nathan has zero temperature events for the nights of 27 Sep through 3 Oct, while the daily AI pass ran and auto-applied every one of those days. Events resume 4 Oct and the night of 4-5 Oct is normal.
- Most likely the pod was off or offline during travel, so `getCurrentHeatingStatus` threw, the per-user catch skipped the rest, and nothing was written. The empty-bed shutoff correctly does nothing when the side is already off.
- The gap is invisible to monitoring: the cron heartbeat still updates and the daily pass still reports ok, so the status endpoint and the email both say healthy.
- This is the same class as the 2026-08-24 incident, where the fix was to make the failure observable. Suggested fix: log a `pod-unreachable` row in `aiRunLog` or `temperatureEvents` when the status read throws, and have `check-ai-status.py` report a night with no scheduled events.
- Worth confirming the cause from Vercel logs for that window before building anything.

## Current state, 2026-10-05
| | Nathan | Laurence |
|---|---|---|
| Last night | 85 score, 85 quality | 99 score, 93 quality |
| Away set | none | none |
| Empty-bed shutoff | on | on |
| Auto-apply | on | on |
| Nights flagged "not you" | none | none |

Both accounts' daily passes ran ok on 03, 04 and 05 Oct. No share links of mine are left active; any that exist are Nathan's own.

## Next action
Decide the two open items above. Neither is urgent and neither is breaking the loop today.

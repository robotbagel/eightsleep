// Signed, expiring links to the video clips kept on the NAS.
//
// The NAS serves clips at sleep-clips.geshido.now through the Cloudflare
// tunnel, but only for a request carrying an expiry and an HMAC of
// "<file>|<expiry>" made with the shared key (CRON_SECRET; the NAS reads the
// same secret from ~/.config/8sleep/cron-secret). The app hands a signed link
// only to a signed-in owner, so a clip address can neither be guessed nor
// passed on for long.
import { createHmac } from "crypto";

const CLIP_HOST = "https://sleep-clips.geshido.now";
/** Long enough to watch a night's clips in one sitting. */
const LINK_HOURS = 6;

export function signedClipUrl(file: string, now = Date.now()): string | null {
  const key = process.env.CRON_SECRET;
  if (!key) return null;
  const exp = Math.floor(now / 1000) + LINK_HOURS * 3600;
  const sig = createHmac("sha256", key).update(`${file}|${exp}`).digest("hex");
  return `${CLIP_HOST}/clip/${encodeURIComponent(file)}?exp=${exp}&sig=${sig}`;
}

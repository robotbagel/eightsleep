"""Night ears: the bedroom camera, used as a microphone and a cat detector.

Pulls the Eufy camera's local RTSP stream at night and turns it into a list
of what happened, never a recording:

- Sound: Google's YAMNet classifier (AudioSet, 521 classes) names each
  second of audio; cat meows and purrs, thuds, doors, snoring, speech and
  coughs are kept, with how far they rose above the room's quiet.
- Sight: when the picture changes, an EfficientDet detector checks whether a
  cat is what moved, so a cat jumping on the bed shows up even when silent.

Events go to the sleep app's /api/soundEvents in the same shape Sleep Sync
uses, so the night card, the chart and the live tuner treat them alike.
Audio and frames exist only in memory for the second they are analysed.

Configuration by environment:
  RTSP_URL      the camera's stream, rtsp://user:pass@host/live0 (secret)
  EVENT_URL     https://.../api/soundEvents
  TOKEN_FILE    file holding the sleep app's import token
  NIGHT_START   local hour listening starts (default 21)
  NIGHT_END     local hour it stops (default 10)
  TZ            Europe/Brussels
"""

import json
import logging
import os
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import audio as mp_audio
from mediapipe.tasks.python import vision as mp_vision
from mediapipe.tasks.python.components.containers import audio_data as mp_audio_data
import mediapipe as mp

def rtsp_url() -> str:
    """The camera link, read fresh each time: it carries the camera password,
    so it lives in a file, and it can be filled in after the service starts."""
    path = os.environ.get("RTSP_URL_FILE")
    if path:
        try:
            return open(path).read().strip()
        except OSError:
            return ""
    return os.environ.get("RTSP_URL", "")
EVENT_URL = os.environ["EVENT_URL"]
TOKEN = open(os.environ["TOKEN_FILE"]).read().strip()
NIGHT_START = int(os.environ.get("NIGHT_START", "21"))
NIGHT_END = int(os.environ.get("NIGHT_END", "10"))
DEVICE = os.environ.get("DEVICE_NAME", "Bedroom camera")
MODEL_DIR = os.environ.get("MODEL_DIR", "/models")

RATE = 16000
WINDOW = 15600  # YAMNet's 0.975 s frame
VIDEO_W, VIDEO_H, FPS = 640, 360, 2

# YAMNet label -> the app's kind (same names Sleep Sync uses).
KINDS = {
    "Meow": "cat_meow",
    "Caterwaul": "cat_meow",
    "Cat": "cat_meow",
    "Purr": "cat_purr",
    "Hiss": "cat_meow",
    "Thump, thud": "thump_thud",
    "Door": "door",
    "Slam": "door_slam",
    "Knock": "knock",
    "Snoring": "snoring",
    "Speech": "speech",
    "Cough": "cough",
    "Dog": "dog_bark",
    "Bark": "dog_bark",
    "Baby cry, infant cry": "baby_crying",
    "Alarm clock": "alarm_clock",
}
MIN_SCORE = 0.35
# Unnamed sound this far above the room's quiet is reported as "loud". 15 dB
# gave 149 a night, mostly the TV and morning bustle; 22 keeps real bangs.
LOUD_ABOVE_QUIET = 22
# Each event carries a short clip so a person can hear what it was and judge:
# CLIP_BEFORE windows (~1 s each) before the moment and CLIP_AFTER after.
CLIP_BEFORE = 3
CLIP_AFTER = 4
# Video clips: the stream is also copied (no re-encoding) into 4-second
# segments in a rolling buffer; around each event 15 s are cut from it
# (7 before, 8 after), shrunk to 720p and kept on the NAS for 14 days.
CLIP_DIR = os.environ.get("CLIP_DIR", "/clips")
BUFFER_DIR = os.path.join(CLIP_DIR, "buffer")
SEGMENT_S = 4
VIDEO_BEFORE_S = 7
VIDEO_AFTER_S = 8
KEEP_DAYS = 14
CLIP_PORT = int(os.environ.get("CLIP_PORT", "8790"))
CLIP_KEY = (
    open(os.environ["CLIP_KEY_FILE"]).read().strip() if os.environ.get("CLIP_KEY_FILE") else ""
)
MERGE_S = 10  # the same kind within this many seconds is one event
CAT_MIN_SCORE = 0.4
# On a dim, grey night picture the detector mixes animals up (a test cat was
# read as "dog" and, by the smaller model, "horse"). No horse sleeps here, so
# any animal it sees is taken to be the cat.
ANIMALS = {"cat", "dog", "horse", "sheep", "cow", "bear", "teddy bear", "bird"}
# Movement = this share of the (downscaled) picture changed by more than
# PIXEL_CHANGE grey levels. A cat is small in a bedroom shot, so the share,
# not the average change, is what notices it.
PIXEL_CHANGE = 20
MOTION_SHARE = 0.004
CAT_COOLDOWN_S = 30

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("night-ears")


# The camera's microphone is quiet: a voice in the room peaks near -40 dBFS,
# inaudible on a phone at normal volume. Clips are levelled per quarter
# second, up to 30x (+30 dB), so a meow is audible without hand-turning the
# volume up and a door slam is not boosted into distortion.
AUDIO_LEVEL = "dynaudnorm=f=250:g=15:p=0.9:m=30"


def encode_clip(pcm: bytes) -> str | None:
    """16 kHz mono PCM -> AAC in an .m4a, base64. AAC because the iPhone's
    browser plays it natively; ~7 s at 32 kbit/s is about 25 KB."""
    import base64
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".m4a") as out:
        result = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(RATE),
             "-ac", "1", "-i", "pipe:0", "-af", AUDIO_LEVEL, "-c:a", "aac", "-b:a", "32k",
             "-movflags", "+faststart", out.name],
            input=pcm,
        )
        if result.returncode != 0:
            return None
        return base64.b64encode(open(out.name, "rb").read()).decode()


class Clips:
    """The last few seconds of sound, and clips still being filled. Audio
    exists only here, in memory, until a clip is encoded and sent."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.recent: list[bytes] = []
        self.open: list[tuple[dict, list[bytes], int]] = []

    def push(self, window: bytes) -> list[tuple[dict, bytes]]:
        """Add one window; return clips that are now complete."""
        done: list[tuple[dict, bytes]] = []
        with self.lock:
            self.recent.append(window)
            del self.recent[:-CLIP_BEFORE]
            still: list[tuple[dict, list[bytes], int]] = []
            for event, parts, left in self.open:
                parts.append(window)
                if left - 1 <= 0:
                    done.append((event, b"".join(parts)))
                else:
                    still.append((event, parts, left - 1))
            self.open = still
        return done

    def start(self, event: dict) -> None:
        with self.lock:
            self.open.append((event, list(self.recent), CLIP_AFTER))


CLIPS = Clips()


class Outbox:
    """Events waiting to be sent; posted every minute, kept on failure. An
    event whose clip is still recording waits for it (at most ~10 s)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.pending: list[dict] = []
        self.last_by_kind: dict[str, float] = {}

    def add(self, kind: str, confidence: float | None, above_quiet: float | None, duration: int) -> None:
        now = time.time()
        with self.lock:
            last = self.last_by_kind.get(kind)
            self.last_by_kind[kind] = now
            if last is not None and now - last < MERGE_S:
                return
            event = {
                "_clip_pending": True,
                "_video_pending": True,
                "_t": now,
                "at": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "kind": kind,
                "durationS": duration,
            }
            if confidence is not None:
                event["confidence"] = round(confidence, 3)
            if above_quiet is not None:
                event["aboveQuietDb"] = round(above_quiet, 1)
            self.pending.append(event)
        CLIPS.start(event)
        threading.Timer(VIDEO_AFTER_S + SEGMENT_S + 2, cut_video, args=(event, now, kind)).start()
        log.info("heard %s (%.2f, +%s dB)", kind, confidence or 0, above_quiet)

    def flush(self) -> None:
        # A clip that never completed (the stream dropped) does not hold
        # its event back for more than half a minute.
        cutoff = time.time() - 60
        with self.lock:
            for e in self.pending:
                if e.get("_t", 0) < cutoff:
                    e.pop("_clip_pending", None)
                    e.pop("_video_pending", None)
        def waiting(e: dict) -> bool:
            return bool(e.get("_clip_pending") or e.get("_video_pending"))
        with self.lock:
            ready = [e for e in self.pending if not waiting(e)]
            self.pending = [e for e in self.pending if waiting(e)]
        # Clips make a batch heavy; send a few at a time.
        for start in range(0, len(ready), 10):
            self._send(ready[start : start + 10])

    def _send(self, batch: list[dict]) -> None:
        if not batch:
            return
        clean = [{k: v for k, v in e.items() if not k.startswith("_")} for e in batch]
        body = json.dumps({"device": DEVICE, "events": clean}).encode()
        req = urllib.request.Request(
            EVENT_URL,
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                log.info("sent %d events: %s", len(batch), resp.read()[:120])
        except Exception as exc:
            log.warning("send failed (%s); keeping %d events", exc, len(batch))
            with self.lock:
                self.pending[:0] = batch


def has_audio(path: str) -> bool:
    """Whether a file carries a decodable sound track (a silent clip is a bug)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    rate = probe.stdout.strip()
    return rate.isdigit() and int(rate) > 0


def cut_video(event: dict, at: float, kind: str) -> None:
    """Cut 15 s around `at` from the segment buffer into a 720p .mp4."""
    try:
        start = at - VIDEO_BEFORE_S
        end = at + VIDEO_AFTER_S
        segments = []
        for name in sorted(os.listdir(BUFFER_DIR)):
            if not name.endswith(".ts"):
                continue
            seg_start = int(name[:-3])
            if seg_start + SEGMENT_S >= start and seg_start <= end:
                segments.append((seg_start, os.path.join(BUFFER_DIR, name)))
        if not segments:
            return
        listing = os.path.join(BUFFER_DIR, f"cut-{int(at * 1000)}.txt")
        with open(listing, "w") as fh:
            for _, path in segments:
                fh.write(f"file '{path}'\n")
        offset = max(0.0, start - segments[0][0])
        name = f"{int(at)}-{kind}.mp4"
        result = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing,
             "-map", "0:v:0", "-map", "0:a:0?",
             "-ss", f"{offset:.2f}", "-t", str(VIDEO_BEFORE_S + VIDEO_AFTER_S),
             "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
             "-af", AUDIO_LEVEL, "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart",
             os.path.join(CLIP_DIR, name)],
            capture_output=True,
        )
        os.remove(listing)
        if result.returncode == 0:
            event["videoFile"] = name
            if not has_audio(os.path.join(CLIP_DIR, name)):
                log.warning("clip %s has no sound track", name)
        else:
            log.warning("clip cut failed: %s", result.stderr[-200:])
    except Exception as exc:
        log.warning("clip cut failed: %s", exc)
    finally:
        event.pop("_video_pending", None)


def housekeeping() -> None:
    """Keep the buffer to a few minutes and clips to KEEP_DAYS."""
    while True:
        now = time.time()
        for folder, max_age in ((BUFFER_DIR, 180), (CLIP_DIR, KEEP_DAYS * 86400)):
            try:
                for name in os.listdir(folder):
                    path = os.path.join(folder, name)
                    if os.path.isfile(path) and now - os.path.getmtime(path) > max_age:
                        os.remove(path)
            except OSError:
                pass
        time.sleep(30)


def serve_clips() -> None:
    """Serves clips over HTTP for the app, through the Cloudflare tunnel.
    Every request needs a signature the app makes with the shared key and an
    expiry, so a clip address cannot be guessed, and stops working."""
    import hashlib
    import hmac
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # quiet
            pass

        def do_GET(self) -> None:
            url = urlparse(self.path)
            name = url.path.removeprefix("/clip/")
            query = parse_qs(url.query)
            exp = query.get("exp", [""])[0]
            sig = query.get("sig", [""])[0]
            valid_name = (
                "/" not in name and name.endswith(".mp4") and not name.startswith(".")
            )
            expected = hmac.new(CLIP_KEY.encode(), f"{name}|{exp}".encode(), hashlib.sha256).hexdigest()
            if (
                not CLIP_KEY
                or not valid_name
                or not exp.isdigit()
                or int(exp) < time.time()
                or not hmac.compare_digest(expected, sig)
            ):
                self.send_error(403)
                return
            path = os.path.join(CLIP_DIR, name)
            if not os.path.isfile(path):
                self.send_error(404)
                return
            data = open(path, "rb").read()
            size = len(data)
            start, end = 0, size - 1
            rng = self.headers.get("Range", "")
            status = 200
            if rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                start = int(a) if a else 0
                end = min(int(b) if b else size - 1, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "private, max-age=3600")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            self.wfile.write(data[start : end + 1])

    ThreadingHTTPServer(("0.0.0.0", CLIP_PORT), Handler).serve_forever()


def is_night() -> bool:
    hour = datetime.now().hour
    return hour >= NIGHT_START or hour < NIGHT_END


CAMERA_MAC = os.environ.get("CAMERA_MAC", "").lower()
_moved_to: str | None = None  # the camera's current address, if it changed


def find_camera() -> str | None:
    """The camera's address on the LAN, found by its hardware (MAC) address.
    Moving the camera to another room can get it a new address from the
    router; the link file still holds the old one. Touching port 554 on every
    address fills the neighbour table, which then maps the MAC to its IP."""
    if not CAMERA_MAC:
        return None
    import socket
    from concurrent.futures import ThreadPoolExecutor

    def touch(ip: str) -> None:
        with socket.socket() as sock:
            sock.settimeout(0.5)
            sock.connect_ex((ip, 554))

    with ThreadPoolExecutor(64) as pool:
        list(pool.map(touch, [f"192.168.50.{i}" for i in range(2, 255)]))
    try:
        for line in open("/proc/net/arp").read().splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 4 and parts[3].lower() == CAMERA_MAC:
                return parts[0]
    except OSError:
        pass
    return None


def current_url() -> str:
    """The link with the camera's present address swapped in, if it moved."""
    url = rtsp_url()
    if _moved_to and url.startswith("rtsp://") and "@" in url:
        creds, rest = url.split("@", 1)
        path = rest.split("/", 1)[1] if "/" in rest else ""
        port = ":554"
        url = f"{creds}@{_moved_to}{port}/{path}"
    return url


def open_stream() -> tuple[subprocess.Popen, int]:
    """ONE connection to the camera, split into sound (stdout) and picture
    (a second pipe): cameras often allow only a couple of RTSP clients."""
    url = current_url()
    os.makedirs(BUFFER_DIR, exist_ok=True)
    video_read, video_write = os.pipe()
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error",
         # Over TCP for a camera; a plain file (for testing) is read in real time.
         *(["-rtsp_transport", "tcp"] if url.startswith("rtsp") else ["-re"]),
         "-i", url,
         "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1",
         "-map", "0:v:0", "-vf", f"fps={FPS},scale={VIDEO_W}:{VIDEO_H}",
         "-pix_fmt", "rgb24", "-f", "rawvideo", f"pipe:{video_write}",
         # The picture untouched, in short segments named by start time, for
         # cutting clips around events. Pruned to a few minutes. The sound is
         # re-encoded: the camera's AAC copied as-is lands in MPEG-TS without
         # a sample rate, and the clip cutter then drops it without a word
         # (every clip of 2026-10-07/08 was silent).
         "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
         "-c:a", "aac", "-ar", str(RATE), "-ac", "1", "-b:a", "48k",
         "-f", "segment", "-segment_time", str(SEGMENT_S), "-segment_format", "mpegts",
         "-reset_timestamps", "1", "-strftime", "1",
         os.path.join(BUFFER_DIR, "%s.ts")],
        stdout=subprocess.PIPE,
        pass_fds=(video_write,),
    )
    os.close(video_write)
    return proc, video_read


def read_exact(stream, size: int) -> bytes:
    buf = b""
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def listen(outbox: Outbox, audio) -> None:
    """Sound: YAMNet on each 0.975 s of 16 kHz mono audio."""
    classifier = mp_audio.AudioClassifier.create_from_options(
        mp_audio.AudioClassifierOptions(
            base_options=mp_python.BaseOptions(
                model_asset_path=f"{MODEL_DIR}/yamnet.tflite",
                delegate=mp_python.BaseOptions.Delegate.CPU,
            ),
            max_results=5,
            score_threshold=0.1,
        )
    )
    levels: list[float] = []  # one dBFS per window, last ~5 minutes
    while True:
        raw = read_exact(audio, WINDOW * 2)
        if len(raw) < WINDOW * 2:
            return
        for event, clip_pcm in CLIPS.push(raw):
            clip = encode_clip(clip_pcm)
            if clip:
                event["clip"] = clip
            event.pop("_clip_pending", None)
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        db = 20 * np.log10(max(float(np.sqrt(np.mean(pcm ** 2))), 1e-9))
        levels.append(db)
        del levels[:-300]
        quiet = float(np.percentile(levels, 10)) if len(levels) >= 30 else db
        above = max(0.0, db - quiet)
        result = classifier.classify(mp_audio_data.AudioData.create_from_array(pcm, RATE))
        named = False
        for category in result[0].classifications[0].categories:
            kind = KINDS.get(category.category_name)
            if kind and category.score >= MIN_SCORE:
                outbox.add(kind, category.score, above, 1)
                named = True
                break
        if not named and len(levels) >= 30 and above >= LOUD_ABOVE_QUIET:
            outbox.add("loud", None, above, 1)


def watch(outbox: Outbox, video) -> None:
    """Sight: 2 frames a second; when the picture changes, is it an animal?
    EfficientDet-Lite2 rather than Lite0: on night-vision grey Lite0 called a
    cat a horse; Lite2 found it, at ~0.2 s a frame on the NAS's CPU."""
    detector = mp_vision.ObjectDetector.create_from_options(
        mp_vision.ObjectDetectorOptions(
            base_options=mp_python.BaseOptions(
                model_asset_path=f"{MODEL_DIR}/efficientdet.tflite",
                delegate=mp_python.BaseOptions.Delegate.CPU,
            ),
            score_threshold=0.3,
            max_results=5,
        )
    )
    frame_bytes = VIDEO_W * VIDEO_H * 3
    previous = None
    last_cat = 0.0
    while True:
        raw = read_exact(video, frame_bytes)
        if len(raw) < frame_bytes:
            return
        frame = np.frombuffer(raw, dtype=np.uint8).reshape(VIDEO_H, VIDEO_W, 3)
        small = frame[::4, ::4].mean(axis=2)
        moved = (
            previous is not None
            and float(np.mean(np.abs(small - previous) > PIXEL_CHANGE)) >= MOTION_SHARE
        )
        previous = small
        if not moved or time.time() - last_cat < CAT_COOLDOWN_S:
            continue
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame))
        for detection in detector.detect(image).detections:
            top = detection.categories[0]
            if top.category_name in ANIMALS and top.score >= CAT_MIN_SCORE:
                outbox.add("cat_moving", top.score, None, 1)
                last_cat = time.time()
                break


def main() -> None:
    global _moved_to
    outbox = Outbox()

    def sender() -> None:
        while True:
            time.sleep(60)
            outbox.flush()

    threading.Thread(target=sender, daemon=True).start()
    os.makedirs(BUFFER_DIR, exist_ok=True)
    threading.Thread(target=housekeeping, daemon=True).start()
    threading.Thread(target=serve_clips, daemon=True).start()
    while True:
        if not is_night():
            outbox.flush()
            time.sleep(60)
            continue
        if not rtsp_url():
            log.info("no camera link yet; checking again in a minute")
            time.sleep(60)
            continue
        proc, video_fd = open_stream()
        video = os.fdopen(video_fd, "rb", buffering=0)
        workers = [
            threading.Thread(target=listen, args=(outbox, proc.stdout), daemon=True),
            threading.Thread(target=watch, args=(outbox, video), daemon=True),
        ]
        for worker in workers:
            worker.start()
        log.info("listening and watching")
        # A dropped stream ends the workers; dawn ends the night. Either way
        # the one ffmpeg is killed, which unblocks both readers.
        started = time.time()
        while all(w.is_alive() for w in workers) and is_night():
            time.sleep(10)
        # A stream that died within a minute usually means the camera is not
        # where the link says: look for it by its MAC address.
        if is_night() and time.time() - started < 60:
            found = find_camera()
            if found:
                if found != _moved_to:
                    log.info("camera found at %s", found)
                _moved_to = found
        proc.kill()
        proc.wait()
        video.close()
        log.info("stream ended or night over; restarting in 15 s")
        time.sleep(15)


if __name__ == "__main__":
    main()

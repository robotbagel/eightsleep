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


class Outbox:
    """Events waiting to be sent; posted every minute, kept on failure."""

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
                "at": datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "kind": kind,
                "durationS": duration,
            }
            if confidence is not None:
                event["confidence"] = round(confidence, 3)
            if above_quiet is not None:
                event["aboveQuietDb"] = round(above_quiet, 1)
            self.pending.append(event)
        log.info("heard %s (%.2f, +%s dB)", kind, confidence or 0, above_quiet)

    def flush(self) -> None:
        with self.lock:
            batch, self.pending = self.pending, []
        if not batch:
            return
        body = json.dumps({"device": DEVICE, "events": batch}).encode()
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


def is_night() -> bool:
    hour = datetime.now().hour
    return hour >= NIGHT_START or hour < NIGHT_END


def open_stream() -> tuple[subprocess.Popen, int]:
    """ONE connection to the camera, split into sound (stdout) and picture
    (a second pipe): cameras often allow only a couple of RTSP clients."""
    url = rtsp_url()
    video_read, video_write = os.pipe()
    proc = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error",
         # Over TCP for a camera; a plain file (for testing) is read in real time.
         *(["-rtsp_transport", "tcp"] if url.startswith("rtsp") else ["-re"]),
         "-i", url,
         "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1",
         "-map", "0:v:0", "-vf", f"fps={FPS},scale={VIDEO_W}:{VIDEO_H}",
         "-pix_fmt", "rgb24", "-f", "rawvideo", f"pipe:{video_write}"],
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
        if not named and len(levels) >= 30 and above >= 15:
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
    outbox = Outbox()

    def sender() -> None:
        while True:
            time.sleep(60)
            outbox.flush()

    threading.Thread(target=sender, daemon=True).start()
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
        while all(w.is_alive() for w in workers) and is_night():
            time.sleep(10)
        proc.kill()
        proc.wait()
        video.close()
        log.info("stream ended or night over; restarting in 15 s")
        time.sleep(15)


if __name__ == "__main__":
    main()

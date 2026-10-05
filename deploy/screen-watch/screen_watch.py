"""Bedroom screen watcher.

Watches the bedroom projector's Chromecast with Google TV and tells the sleep
app every time the screen goes on or off, so sleep-onset latency can be
measured from lights out instead of from getting into bed (see
src/server/ai/screen.ts).

The Chromecast learns over HDMI-CEC whether the projector is on and reports it
as `is_stand_by`. If the dongle draws power from the projector it simply
vanishes when the projector is off, so an unreachable device also counts as
off once it has been gone for a while.

Runs on the NAS in Docker with host networking (Cast discovery is mDNS).
Configuration by environment:
  CAST_NAME     friendly name to watch            (default "Bedroom TV")
  EVENT_URL     the app's /api/screenEvent URL
  SECRET_FILE   file holding the app's CRON_SECRET
"""

import json
import logging
import os
import threading
import time
import urllib.request

import pychromecast

CAST_NAME = os.environ.get("CAST_NAME", "Bedroom TV")
EVENT_URL = os.environ["EVENT_URL"]
SECRET = open(os.environ["SECRET_FILE"]).read().strip()

# A state must hold this long before it is reported, so an input switch or a
# CEC hiccup is not mistaken for the screen going off.
SETTLE_S = 20
# The dongle unreachable this long counts as the projector being off.
GONE_S = 90
HEARTBEAT_S = 300

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("screen-watch")


def post(payload: dict) -> None:
    """Deliver to the app, retrying for up to ~10 minutes. Never raises."""
    data = json.dumps(payload).encode()
    for attempt in range(8):
        try:
            req = urllib.request.Request(
                EVENT_URL,
                data=data,
                headers={
                    "Authorization": f"Bearer {SECRET}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                log.info("posted %s -> %s", payload, resp.read()[:200])
                return
        except Exception as exc:  # network, 5xx, anything: wait and retry
            log.warning("post failed (%s), attempt %d", exc, attempt + 1)
            time.sleep(min(2 ** attempt * 5, 120))
    log.error("gave up posting %s", payload)


class Watch:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.observed: str | None = None  # what the device says right now
        self.observed_since = time.time()
        self.reported: str | None = None  # what the app was last told
        self.app: str | None = None
        # Starts at launch, so a device that never appears (projector off and
        # the dongle unpowered) is reported off once GONE_S has passed.
        self.last_contact = time.time()

    def observe(self, state: str, app: str | None) -> None:
        with self.lock:
            self.last_contact = time.time()
            if state != self.observed:
                self.observed = state
                self.observed_since = time.time()
            self.app = app

    def new_cast_status(self, status) -> None:  # pychromecast listener
        if status.is_stand_by is not None:
            on = status.is_stand_by is False
        else:
            # No CEC report: fall back to whether the Chromecast is the
            # projector's active input.
            on = status.is_active_input is True
        self.observe("on" if on else "off", status.display_name)

    def tick(self) -> None:
        """Report a settled change; treat a long-gone device as off."""
        now = time.time()
        with self.lock:
            if now - self.last_contact > GONE_S and self.observed != "off":
                self.observed = "off"
                self.observed_since = self.last_contact
            state, since, app = self.observed, self.observed_since, self.app
        if state is None or state == self.reported or now - since < SETTLE_S:
            return
        self.reported = state
        at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(since))
        threading.Thread(
            target=post,
            args=({"state": state, "at": at, "app": app, "device": CAST_NAME},),
            daemon=True,
        ).start()


def main() -> None:
    watch = Watch()
    cast = None
    browser = None
    last_heartbeat = 0.0
    while True:
        try:
            if cast is None:
                casts, browser = pychromecast.get_listed_chromecasts(
                    friendly_names=[CAST_NAME], timeout=15
                )
                if casts:
                    cast = casts[0]
                    cast.wait(timeout=20)
                    cast.register_status_listener(watch)
                    if cast.status:
                        watch.new_cast_status(cast.status)
                    log.info("watching %s at %s", CAST_NAME, cast.cast_info.host)
                else:
                    if browser:
                        browser.stop_discovery()
                    browser = None
            if cast is not None:
                if cast.socket_client.is_connected:
                    # Status pushes only arrive on change; touch the contact
                    # clock while the link is up.
                    with watch.lock:
                        watch.last_contact = time.time()
                    if watch.observed is None and cast.status:
                        watch.new_cast_status(cast.status)
            watch.tick()
            if time.time() - last_heartbeat > HEARTBEAT_S and watch.reported:
                last_heartbeat = time.time()
                threading.Thread(
                    target=post,
                    args=({"state": watch.reported, "heartbeat": True, "device": CAST_NAME},),
                    daemon=True,
                ).start()
        except Exception as exc:
            log.warning("watch loop error: %s", exc)
            cast = None
            if browser:
                try:
                    browser.stop_discovery()
                except Exception:
                    pass
                browser = None
        time.sleep(5)


if __name__ == "__main__":
    main()

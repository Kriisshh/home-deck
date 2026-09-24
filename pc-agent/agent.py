"""Home Deck PC agent.

Runs on the main Windows PC and exposes a small authenticated HTTP API on the LAN:
  * now-playing info + transport control for Spotify (via Windows media sessions / SMTC)
  * system and per-app volume (via Core Audio)
  * "deck" actions defined in config.json (hotkeys, launch apps, open URLs, macros...)

Only actions listed in config.json can be triggered - the laptop never sends raw commands.
"""

from __future__ import annotations

import asyncio
import ctypes
import hashlib
import json
import logging
import logging.handlers
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import comtypes
import comtypes.client
from pycaw.pycaw import AudioUtilities, IAudioEndpointVolume
from winrt.windows.media import MediaPlaybackAutoRepeatMode as RepeatMode
from winrt.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)
from winrt.windows.storage.streams import Buffer, InputStreamOptions

VERSION = "1.0.0"
HERE = Path(__file__).resolve().parent
CONFIG_PATH = HERE / "config.json"
EXAMPLE_CONFIG_PATH = HERE / "config.example.json"

log = logging.getLogger("deck-agent")


# --------------------------------------------------------------------------- config

class Config:
    """config.json, reloaded automatically when the file changes (edit actions without restarting)."""

    def __init__(self, path: Path):
        self.path = path
        self._mtime = 0.0
        self._data: dict = {}
        self._lock = threading.Lock()
        if not path.exists():
            self._create_default()
        self.reload(force=True)

    def _create_default(self) -> None:
        data = json.loads(EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8"))
        data["token"] = secrets.token_urlsafe(24)
        data["name"] = socket.gethostname()
        self.path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        log.info("Created %s with a new random token", self.path.name)

    def reload(self, force: bool = False) -> dict:
        with self._lock:
            try:
                mtime = self.path.stat().st_mtime
                if force or mtime != self._mtime:
                    self._data = json.loads(self.path.read_text(encoding="utf-8"))
                    self._mtime = mtime
                    if not force:
                        log.info("Reloaded config.json")
            except (OSError, json.JSONDecodeError) as exc:
                if force:
                    raise
                log.error("config.json is invalid, keeping previous version: %s", exc)
            return self._data

    @property
    def data(self) -> dict:
        return self.reload()


# --------------------------------------------------------------------------- keyboard input

user32 = ctypes.WinDLL("user32", use_last_error=True)

INPUT_KEYBOARD = 1
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


VK = {
    "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B, "lwin": 0x5B, "rwin": 0x5C,
    "lctrl": 0xA2, "rctrl": 0xA3, "lshift": 0xA0, "rshift": 0xA1, "lalt": 0xA4, "ralt": 0xA5,
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "return": 0x0D, "pause": 0x13, "capslock": 0x14,
    "esc": 0x1B, "escape": 0x1B, "space": 0x20, "pageup": 0x21, "pagedown": 0x22, "end": 0x23,
    "home": 0x24, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28, "printscreen": 0x2C,
    "insert": 0x2D, "delete": 0x2E, "del": 0x2E, "apps": 0x5D, "menu": 0x5D,
    "numlock": 0x90, "scrolllock": 0x91,
    "volume_mute": 0xAD, "volume_down": 0xAE, "volume_up": 0xAF,
    "media_next": 0xB0, "media_prev": 0xB1, "media_stop": 0xB2, "media_play_pause": 0xB3,
    ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, "`": 0xC0,
    "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE,
}
VK.update({chr(c).lower(): c for c in range(ord("A"), ord("Z") + 1)})
VK.update({str(n): 0x30 + n for n in range(10)})
VK.update({f"f{n}": 0x6F + n for n in range(1, 25)})
VK.update({f"num{n}": 0x60 + n for n in range(10)})

EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D,
                0xA3, 0xA5, 0x90, *range(0xAD, 0xB8)}


def _key_input(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
    if vk in EXTENDED_VKS:
        flags |= KEYEVENTF_EXTENDEDKEY
    return INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags)))


def _send(inputs: list[INPUT]) -> None:
    arr = (INPUT * len(inputs))(*inputs)
    if user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT)) != len(inputs):
        raise OSError(f"SendInput failed (error {ctypes.get_last_error()}). "
                      "The focused window may be running as administrator.")


def press_keys(keys: list[str]) -> None:
    """Press a combo like ["ctrl", "shift", "m"]: all down in order, then up in reverse."""
    try:
        vks = [VK[k.lower()] for k in keys]
    except KeyError as exc:
        raise ValueError(f"Unknown key {exc.args[0]!r}") from None
    _send([_key_input(vk) for vk in vks] + [_key_input(vk, flags=KEYEVENTF_KEYUP) for vk in reversed(vks)])


def type_text(text: str) -> None:
    data = text.encode("utf-16-le")
    inputs = []
    for i in range(0, len(data), 2):
        code = int.from_bytes(data[i:i + 2], "little")
        inputs += [_key_input(scan=code, flags=KEYEVENTF_UNICODE),
                   _key_input(scan=code, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
    if inputs:
        _send(inputs)


# --------------------------------------------------------------------------- media (SMTC)

def _app_name(aumid: str) -> str:
    name = aumid.split("!")[-1]
    if name.lower().endswith(".exe"):
        name = name[:-4]
    return name.split("\\")[-1] or aumid


class NoSession(Exception):
    pass


class Media:
    """Wraps the Windows global media session manager on a dedicated asyncio loop."""

    def __init__(self, config: Config):
        self.config = config
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="media-loop", daemon=True).start()
        self._manager = None
        self._art: tuple[str, bytes, str] | None = None

    def run(self, coro, timeout: float = 6.0):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    async def _session(self):
        if self._manager is None:
            self._manager = await SessionManager.request_async()
        opts = self.config.data.get("media", {})
        preferred = (opts.get("preferred_app") or "").lower()
        if preferred:
            for session in self._manager.get_sessions():
                if preferred in session.source_app_user_model_id.lower():
                    return session
            if not opts.get("fallback_to_any", True):
                return None
        return self._manager.get_current_session()

    @staticmethod
    def _key(app: str, props) -> str:
        return hashlib.sha1(f"{app}|{props.title}|{props.artist}|{props.album_title}".encode()).hexdigest()[:16]

    async def _state(self) -> dict:
        session = await self._session()
        if session is None:
            return {"active": False}
        props = await session.try_get_media_properties_async()
        playback = session.get_playback_info()
        timeline = session.get_timeline_properties()
        controls = playback.controls
        playing = playback.playback_status == PlaybackStatus.PLAYING

        duration = max(0.0, (timeline.end_time - timeline.start_time).total_seconds())
        position = timeline.position.total_seconds()
        if playing and timeline.last_updated_time.year > 1601:
            elapsed = (datetime.now(timezone.utc) - timeline.last_updated_time).total_seconds()
            position += max(0.0, elapsed) * (playback.playback_rate or 1.0)
        if duration:
            position = min(position, duration)

        app = _app_name(session.source_app_user_model_id)
        repeat = playback.auto_repeat_mode
        return {
            "active": True,
            "app": app,
            "title": props.title,
            "artist": props.artist or props.album_artist,
            "album": props.album_title,
            "status": PlaybackStatus(playback.playback_status).name.lower(),
            "playing": playing,
            "position": round(max(0.0, position), 2),
            "duration": round(duration, 2),
            "shuffle": playback.is_shuffle_active,
            "repeat": {RepeatMode.NONE: "off", RepeatMode.TRACK: "track", RepeatMode.LIST: "list"}.get(repeat),
            "art_key": self._key(app, props) if props.thumbnail else None,
            "can": {
                "play_pause": controls.is_play_pause_toggle_enabled or controls.is_play_enabled,
                "next": controls.is_next_enabled,
                "previous": controls.is_previous_enabled,
                "seek": controls.is_playback_position_enabled,
                "shuffle": controls.is_shuffle_enabled,
                "repeat": controls.is_repeat_enabled,
            },
        }

    async def _read_art(self) -> tuple[str, bytes, str] | None:
        session = await self._session()
        if session is None:
            return None
        props = await session.try_get_media_properties_async()
        if not props.thumbnail:
            return None
        key = self._key(_app_name(session.source_app_user_model_id), props)
        if self._art and self._art[0] == key:
            return self._art
        stream = await props.thumbnail.open_read_async()
        buf = Buffer(stream.size)
        await stream.read_async(buf, stream.size, InputStreamOptions.READ_AHEAD)
        self._art = (key, bytes(memoryview(buf)), stream.content_type or "image/png")
        return self._art

    async def _command(self, command: str, value=None) -> bool:
        session = await self._session()
        if session is None:
            raise NoSession
        playback = session.get_playback_info()
        match command:
            case "play_pause":
                return await session.try_toggle_play_pause_async()
            case "play":
                return await session.try_play_async()
            case "pause":
                return await session.try_pause_async()
            case "next":
                return await session.try_skip_next_async()
            case "previous":
                return await session.try_skip_previous_async()
            case "seek":
                return await session.try_change_playback_position_async(int(float(value) * 10_000_000))
            case "shuffle":
                target = (not playback.is_shuffle_active) if value is None else bool(value)
                return await session.try_change_shuffle_active_async(target)
            case "repeat":
                order = [RepeatMode.NONE, RepeatMode.LIST, RepeatMode.TRACK]
                if value is None:
                    current = playback.auto_repeat_mode if playback.auto_repeat_mode in order else RepeatMode.NONE
                    target = order[(order.index(current) + 1) % len(order)]
                else:
                    target = {"off": RepeatMode.NONE, "list": RepeatMode.LIST, "track": RepeatMode.TRACK}[value]
                return await session.try_change_auto_repeat_mode_async(target)
        raise ValueError(f"Unknown media command {command!r}")

    def state(self) -> dict:
        return self.run(self._state())

    def art(self):
        return self.run(self._read_art())

    def command(self, command: str, value=None) -> bool:
        fallback_keys = {"play_pause": "media_play_pause", "next": "media_next", "previous": "media_prev"}
        try:
            return self.run(self._command(command, value))
        except NoSession:
            if command in fallback_keys:  # nothing registered (e.g. Spotify just started) - use media keys
                press_keys([fallback_keys[command]])
                return True
            raise


# --------------------------------------------------------------------------- volume (Core Audio)

class Volume:
    """All COM calls run on one dedicated thread with COM initialised.

    Enumerating audio sessions is the expensive part (~20 ms CPU), so the speaker endpoint and the
    app's sessions are cached and rescanned at most every CACHE_SECONDS.
    """

    CACHE_SECONDS = 10

    def __init__(self, config: Config):
        self.config = config
        self.pool = ThreadPoolExecutor(1, initializer=comtypes.CoInitialize, thread_name_prefix="com")
        self._scanned_at = 0.0
        self._endpoint = None
        self._sessions: list = []

    def _scan(self, force: bool = False) -> None:
        if not force and time.monotonic() - self._scanned_at < self.CACHE_SECONDS:
            return
        target = (self.config.data.get("media", {}).get("app_process") or "Spotify.exe").lower()
        self._endpoint = AudioUtilities.GetSpeakers().EndpointVolume
        self._sessions = [s for s in AudioUtilities.GetAllSessions()
                          if s.Process and s.Process.name().lower() == target]
        self._scanned_at = time.monotonic()

    def _cached(self, fn, *args):
        """Run fn against the cached COM objects; rescan once if they went stale (device/app changed)."""
        self._scan()
        try:
            return fn(*args)
        except (comtypes.COMError, OSError, AttributeError):
            self._scan(force=True)
            return fn(*args)

    def _read(self) -> dict:
        endpoint = self._endpoint
        result = {"system": {"level": round(endpoint.GetMasterVolumeLevelScalar(), 3),
                             "muted": bool(endpoint.GetMute())},
                  "app": None}
        if self._sessions:
            vol = self._sessions[0].SimpleAudioVolume
            result["app"] = {"level": round(vol.GetMasterVolume(), 3), "muted": bool(vol.GetMute())}
        return result

    def _write(self, target: str, level=None, delta=None, muted=None) -> dict:
        if target == "system":
            e = self._endpoint
            controls = [(e.GetMasterVolumeLevelScalar, e.SetMasterVolumeLevelScalar, e.GetMute, e.SetMute)]
        elif target == "app":
            if not self._sessions:
                self._scan(force=True)  # the app may have started since the last scan
            controls = [(s.SimpleAudioVolume.GetMasterVolume, s.SimpleAudioVolume.SetMasterVolume,
                         s.SimpleAudioVolume.GetMute, s.SimpleAudioVolume.SetMute) for s in self._sessions]
            if not controls:
                raise NoSession
        else:
            raise ValueError("target must be 'system' or 'app'")
        for get_level, set_level, get_mute, set_mute in controls:
            if delta is not None:
                level = get_level() + float(delta)
            if level is not None:
                set_level(min(1.0, max(0.0, float(level))), None)
            if muted == "toggle":
                muted = not get_mute()
            if muted is not None:
                set_mute(bool(muted), None)
        return self._read()

    def _get(self) -> dict:
        return self._cached(self._read)

    def _set(self, target: str, level=None, delta=None, muted=None) -> dict:
        return self._cached(self._write, target, level, delta, muted)

    def _mic_mute(self, muted=None) -> bool:
        device = AudioUtilities.GetMicrophone()  # raw IMMDevice in current pycaw
        if device is None:
            raise NoSession
        endpoint = device.Activate(IAudioEndpointVolume._iid_, comtypes.CLSCTX_ALL, None).QueryInterface(
            IAudioEndpointVolume)
        target = (not endpoint.GetMute()) if muted in (None, "toggle") else bool(muted)
        endpoint.SetMute(target, None)
        return target

    def get(self) -> dict:
        return self.pool.submit(self._get).result(5)

    def set(self, target: str, level=None, delta=None, muted=None) -> dict:
        return self.pool.submit(self._set, target, level, delta, muted).result(5)

    def mic_mute(self, muted=None) -> bool:
        return self.pool.submit(self._mic_mute, muted).result(5)

    def com(self, fn):
        """Run fn on the COM thread (for other COM automation, e.g. the Windows shell)."""
        return self.pool.submit(fn).result(5)


# --------------------------------------------------------------------------- deck actions

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008


class Actions:
    PUBLIC_FIELDS = ("id", "label", "icon", "color", "key", "confirm", "group")

    def __init__(self, config: Config, media: Media, volume: Volume):
        self.config = config
        self.media = media
        self.volume = volume

    def list(self) -> list[dict]:
        return [{k: a[k] for k in self.PUBLIC_FIELDS if k in a} for a in self.config.data.get("actions", [])]

    def find(self, action_id: str) -> dict | None:
        return next((a for a in self.config.data.get("actions", []) if a.get("id") == action_id), None)

    def run(self, action: dict):
        kind = action.get("type")
        match kind:
            case "hotkey":
                press_keys(action["keys"])
            case "text":
                type_text(action["text"])
            case "run":
                cmd = action["command"]
                subprocess.Popen(cmd, cwd=action.get("cwd"), creationflags=DETACHED_PROCESS,
                                 close_fds=True, shell=isinstance(cmd, str))
            case "open":
                os.startfile(os.path.expandvars(action["target"]))
            case "screenshot":  # Snipping Tool overlay, same as Win+Shift+S but without a keystroke
                os.startfile("ms-screenclip:")
            case "show_desktop":
                self.volume.com(lambda: comtypes.client.CreateObject("Shell.Application").ToggleDesktop())
            case "task_manager":  # via the shell, so Windows can elevate it
                os.startfile("taskmgr.exe")
            case "shell":
                subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                                  "-Command", action["command"]], creationflags=CREATE_NO_WINDOW)
            case "media":
                return self.media.command(action["command"], action.get("value"))
            case "volume":
                return self.volume.set(action.get("target", "system"), action.get("level"),
                                       action.get("delta"), action.get("muted"))
            case "mic_mute":
                return {"muted": self.volume.mic_mute(action.get("muted"))}
            case "lock":
                user32.LockWorkStation()
            case "sleep":
                self._later(lambda: ctypes.WinDLL("powrprof").SetSuspendState(False, False, False))
            case "shutdown" | "restart":
                flag = "/s" if kind == "shutdown" else "/r"
                self._later(lambda: subprocess.Popen(["shutdown", flag, "/t", str(action.get("delay", 0))],
                                                     creationflags=CREATE_NO_WINDOW))
            case "multi":
                for step in action["steps"]:
                    if "delay_ms" in step and len(step) == 1:
                        time.sleep(step["delay_ms"] / 1000)
                    else:
                        self.run(step)
            case _:
                raise ValueError(f"Unknown action type {kind!r}")
        return None

    @staticmethod
    def _later(fn, delay: float = 1.0) -> None:
        """Run after the HTTP response has gone out (for sleep/shutdown)."""
        threading.Timer(delay, fn).start()


# --------------------------------------------------------------------------- HTTP API

class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Handler(BaseHTTPRequestHandler):
    server_version = f"HomeDeckAgent/{VERSION}"
    protocol_version = "HTTP/1.1"
    app: "Agent"  # set on the class at startup

    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    # ---- plumbing
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status: int = 200):
        self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise HttpError(400, "Body must be JSON") from None

    def _authorised(self) -> bool:
        expected = self.app.config.data.get("token", "")
        header = self.headers.get("Authorization", "")
        given = header[7:] if header.startswith("Bearer ") else ""
        return bool(expected) and secrets.compare_digest(given.encode(), expected.encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str):
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                if path != "/api/ping" and not self._authorised():
                    raise HttpError(401, "Invalid or missing token")
                self._api(method, path[5:].strip("/").split("/"))
            else:
                raise HttpError(404, "Not found")
        except HttpError as exc:
            self._json({"ok": False, "error": str(exc)}, exc.status)
        except NoSession:
            self._json({"ok": False, "error": "Nothing is playing on the PC"}, 409)
        except (ValueError, KeyError, TypeError) as exc:
            self._json({"ok": False, "error": f"Bad request: {exc}"}, 400)
        except Exception as exc:  # noqa: BLE001 - report everything to the client
            log.exception("Request failed: %s %s", method, path)
            self._json({"ok": False, "error": str(exc) or exc.__class__.__name__}, 500)

    def _api(self, method: str, parts: list[str]):
        app = self.app
        match method, parts:
            case "GET", ["ping"]:
                self._json({"ok": True, "app": "home-deck-agent", "version": VERSION})
            case "GET", ["status"]:
                self._json({"ok": True, "name": app.config.data.get("name") or socket.gethostname(),
                            "version": VERSION})
            case "GET", ["media"]:
                state = app.media.state()
                try:
                    state["volume"] = app.volume.get()
                except Exception as exc:  # noqa: BLE001 - volume is optional, never break now-playing
                    log.warning("Volume read failed: %s", exc)
                    state["volume"] = None
                self._json(state)
            case "GET", ["media", "art"]:
                art = app.media.art()
                if not art:
                    raise HttpError(404, "No artwork")
                key, data, ctype = art
                self._send(200, data, ctype, {"X-Art-Key": key})
            case "POST", ["media", command]:
                body = self._body()
                ok = app.media.command(command, body.get("value"))
                self._json({"ok": bool(ok)})
            case "GET", ["volume"]:
                self._json(app.volume.get())
            case "POST", ["volume"]:
                body = self._body()
                self._json(app.volume.set(body.get("target", "system"), body.get("level"),
                                          body.get("delta"), body.get("muted")))
            case "GET", ["actions"]:
                self._json({"actions": app.actions.list()})
            case "POST", ["actions", action_id]:
                action = app.actions.find(unquote(action_id))
                if not action:
                    raise HttpError(404, f"No action with id {action_id!r}")
                log.info("Running action %s", action["id"])
                self._json({"ok": True, "result": app.actions.run(action)})
            case _:
                raise HttpError(404, "Unknown endpoint")


class Agent:
    def __init__(self):
        self.config = Config(CONFIG_PATH)
        self.media = Media(self.config)
        self.volume = Volume(self.config)
        self.actions = Actions(self.config, self.media, self.volume)

    def serve(self):
        cfg = self.config.data
        host, port = cfg.get("host", "0.0.0.0"), int(cfg.get("port", 8765))
        Handler.app = self
        server = ThreadingHTTPServer((host, port), Handler)
        server.daemon_threads = True
        log.info("Home Deck agent %s listening on http://%s:%d", VERSION, host, port)
        for ip in _lan_ips():
            log.info("  Agent URL for the laptop: http://%s:%d", ip, port)
        log.info("  Token: %s", cfg.get("token"))
        server.serve_forever()


def _lan_ips() -> list[str]:
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        return sorted({i[4][0] for i in infos if not i[4][0].startswith("127.")})
    except OSError:
        return []


def main():
    handlers: list[logging.Handler] = [logging.handlers.RotatingFileHandler(
        HERE / "agent.log", maxBytes=1_000_000, backupCount=1, encoding="utf-8")]
    if sys.stdout is not None:  # pythonw has no console
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    if not EXAMPLE_CONFIG_PATH.exists() and not CONFIG_PATH.exists():
        sys.exit("config.example.json is missing")
    Agent().serve()


if __name__ == "__main__":
    main()

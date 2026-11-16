#!/usr/bin/env python3
"""Home Deck wake service (runs on the always-on Android phone in Termux, or a Linux box).

Chrome can't send Wake-on-LAN packets, but Linux can. This listens on port 9009 and, when Home Deck
POSTs to /wake, broadcasts a magic packet for the given MAC address. It sleeps in accept() the rest
of the time, so it costs nothing while idle. Standard library only.

    POST http://penguin.linux.test:9009/wake   {"mac": "04:7C:16:48:3D:E8"}
"""

import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9009
# Optional port forwards, e.g. {"20388": "192.168.3.4"} sends anything arriving on port 20388 (TCP and
# UDP) to the laptop - so a remote app (Wolow Companion commands) can reach it through this device.
FORWARDS_FILE = os.path.expanduser("~/.home-deck-forwards.json")
TARGETS = [("255.255.255.255", 9), ("255.255.255.255", 7)]  # plus this network's x.y.z.255, see send()

# Phone notifications: the phone (MacroDroid) POSTs each one to /notify, Home Deck reads /notifications.
# Both need the key in ~/.home-deck-notify-key (made on first run), because notifications are private.
NOTIFY_FILE = os.path.expanduser("~/.home-deck-notifications.json")
NOTIFY_KEY_FILE = os.path.expanduser("~/.home-deck-notify-key")
ICON_DIR = os.path.expanduser("~/.home-deck-icons")
NOTIFY_MAX = 60
NOTIFY_MAX_AGE = 3 * 24 * 3600 * 1000  # ms
notify_lock = threading.Lock()


def notify_key() -> str:
    try:
        with open(NOTIFY_KEY_FILE, encoding="utf-8") as f:
            key = f.read().strip()
            if key:
                return key
    except OSError:
        pass
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O or 1/I mix-ups
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    key = f"{raw[:4]}-{raw[4:]}"
    with open(NOTIFY_KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key + "\n")
    return key


def _norm_key(k: str) -> str:
    return re.sub(r"[^0-9A-Z]", "", str(k).upper())


def load_notifications() -> dict:
    try:
        with open(NOTIFY_FILE, encoding="utf-8") as f:
            data = json.load(f)
            return {"next": int(data.get("next", 1)), "items": list(data.get("items", []))}
    except (OSError, ValueError):
        return {"next": 1, "items": []}


def save_notifications(data: dict) -> None:
    tmp = NOTIFY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, NOTIFY_FILE)


NOTIFICATIONS = load_notifications()


def add_notification(fields: dict) -> dict | None:
    def clean(key: str, limit: int) -> str:
        value = str(fields.get(key, "") or "").strip()[:limit]
        # MacroDroid sends an unknown magic-text placeholder as-is; treat it as empty.
        return "" if re.fullmatch(r"[{\[][a-z_]+[}\]]", value) else value

    item = {"app": clean("app", 80), "pkg": clean("pkg", 120), "title": clean("title", 200), "text": clean("text", 4000)}
    nkey = clean("nkey", 300)  # the phone's id for this notification (Home Deck Notify app)
    if not item["title"] and not item["text"]:
        return None
    now = int(time.time() * 1000)
    with notify_lock:
        items = [i for i in NOTIFICATIONS["items"] if now - i["t"] < NOTIFY_MAX_AGE]
        # Apps often re-post the same notification unchanged (alerts, summaries): keep the one shown.
        same = lambda i: (i["pkg"], i["app"], i["title"], i["text"]) == (item["pkg"], item["app"], item["title"], item["text"])
        for i in items:
            if same(i) and (i.get("nkey") == nkey if nkey else now - i["t"] < 60000):
                return i
        if nkey:  # an update to a notification already shown (e.g. a second message): replace it
            items = [i for i in items if i.get("nkey") != nkey]
            item["nkey"] = nkey
        item.update(id=NOTIFICATIONS["next"], t=now)
        NOTIFICATIONS["next"] += 1
        NOTIFICATIONS["items"] = (items + [item])[-NOTIFY_MAX:]
        save_notifications(NOTIFICATIONS)
    return item


def dismiss_notifications(ids=None, nkeys=None) -> None:
    """Remove by id (from Home Deck), by phone key (cleared on the phone), or everything."""
    with notify_lock:
        if ids is None and nkeys is None:
            NOTIFICATIONS["items"] = []
        else:
            NOTIFICATIONS["items"] = [i for i in NOTIFICATIONS["items"]
                                      if i["id"] not in (ids or ()) and i.get("nkey") not in (nkeys or ())]
        save_notifications(NOTIFICATIONS)


def app_icon(pkg: str) -> bytes | None:
    """The app's Play Store icon (96 px), fetched once and cached; None if it can't be found."""
    if not re.fullmatch(r"[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+", pkg or ""):
        return None
    os.makedirs(ICON_DIR, exist_ok=True)
    path = os.path.join(ICON_DIR, pkg + ".png")
    try:
        if os.path.getsize(path) > 0:
            with open(path, "rb") as f:
                return f.read()
        if time.time() - os.path.getmtime(path) < 24 * 3600:
            return None  # looked it up recently and found nothing
    except OSError:
        pass
    data = b""
    try:
        req = urllib.request.Request(f"https://play.google.com/store/apps/details?id={pkg}&hl=en",
                                     headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8", "replace")
        m = re.search(r'<meta property="og:image" content="([^"]+)"', html)
        if m:
            url = re.sub(r"=[^/=]*$", "", m.group(1)) + "=s96"
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10).read()
    except (OSError, ValueError):
        data = b""
    with open(path, "wb") as f:
        f.write(data)
    return data or None


def magic_packet(mac: str) -> bytes:
    digits = re.sub(r"[^0-9a-fA-F]", "", mac)
    if len(digits) != 12:
        raise ValueError(f"not a MAC address: {mac!r}")
    return b"\xff" * 6 + bytes.fromhex(digits) * 16


def local_broadcast() -> str | None:
    """x.y.z.255 for the address this device uses on its network (assumes a /24 home network)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("1.1.1.1", 9))  # no packet is sent; this just picks the outgoing address
            ip = probe.getsockname()[0]
        return ip.rsplit(".", 1)[0] + ".255"
    except OSError:
        return None


def send(mac: str, ip: str = "") -> None:
    packet = magic_packet(mac)
    # Broadcasts often stay inside the Linux container's private network, so when the device's IP is
    # known, also send straight to it (that crosses Chrome OS's NAT onto the home network).
    targets = list(TARGETS)
    subnet = local_broadcast()
    if subnet:
        targets = [(subnet, 9), (subnet, 7)] + targets
    if ip:
        socket.inet_aton(ip)  # raises OSError/ValueError for a bad IP
        targets = [(ip, 9), (ip, 7)] + targets
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for addr in targets:
            try:
                sock.sendto(packet, addr)
            except OSError:
                pass  # one unreachable target shouldn't stop the others


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")  # Chrome: page -> private address
        self.send_header("Access-Control-Max-Age", "600")

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        # CORS preflight: headers only - a 204 must not carry a body
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authorised(self, query: dict) -> bool:
        given = self.headers.get("X-Key") or query.get("key", [""])[0]
        return bool(given) and secrets.compare_digest(_norm_key(given), _norm_key(notify_key()))

    def _fields(self, query: dict) -> dict:
        """Fields from the query string plus a JSON or form body (MacroDroid can send either)."""
        fields = {k: v[0] for k, v in query.items()}
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b""
        if body:
            text = body.decode("utf-8", "replace")
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    fields.update(parsed)
            except ValueError:
                fields.update({k: v[0] for k, v in urllib.parse.parse_qs(text, keep_blank_values=True).items()})
        return fields

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path.rstrip("/"), urllib.parse.parse_qs(url.query)
        if path in ("/notifications", "/icon") and not self._authorised(query):
            return self._reply(401, {"ok": False, "error": "wrong or missing key"})
        if path == "/notifications":
            with notify_lock:
                items = list(NOTIFICATIONS["items"])
            return self._reply(200, {"ok": True, "items": items})
        if path == "/icon":
            data = app_icon(query.get("pkg", [""])[0])
            if not data:
                return self._reply(404, {"ok": False, "error": "no icon"})
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "image/png")
            self.send_header("Cache-Control", "max-age=604800")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._reply(200, {"ok": True, "app": "home-deck-wol", "notifications": True})

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        path, query = url.path.rstrip("/"), urllib.parse.parse_qs(url.query)
        if path in ("/notify", "/notifications/dismiss"):
            if not self._authorised(query):
                return self._reply(401, {"ok": False, "error": "wrong or missing key"})
            fields = self._fields(query)
            if path == "/notify":
                item = add_notification(fields)
                return self._reply(200, {"ok": True, "id": item and item["id"]})
            if fields.get("all"):
                dismiss_notifications()
            else:
                dismiss_notifications({int(i) for i in fields.get("ids") or []}, {str(k) for k in fields.get("nkeys") or []})
            return self._reply(200, {"ok": True})
        if path != "/wake":
            return self._reply(404, {"ok": False, "error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            send(str(body.get("mac", "")), str(body.get("ip", "") or ""))
            self._reply(200, {"ok": True})
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            self._reply(400, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        pass


def mac_from_packet(data: bytes) -> str | None:
    """The MAC address in a magic packet (6 x FF, then the MAC 16 times), or None if it isn't one."""
    start = data.find(b"\xff" * 6)
    if start < 0 or len(data) < start + 6 + 96:
        return None
    mac = data[start + 6:start + 12]
    if data[start + 6:start + 102] != mac * 16:
        return None
    return mac.hex(":")


def udp_relay() -> None:
    """Rebroadcast magic packets that arrive on UDP PORT, so WoL apps (e.g. WolOn) can wake devices
    from anywhere by sending to this phone over Tailscale (Tailscale doesn't carry broadcasts)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("0.0.0.0", PORT))
        while True:
            data, _ = sock.recvfrom(2048)
            mac = mac_from_packet(data)
            if mac:
                try:
                    send(mac)
                except OSError:
                    pass


def load_forwards() -> dict[int, str]:
    try:
        with open(FORWARDS_FILE, encoding="utf-8") as f:
            return {int(port): str(host) for port, host in json.load(f).items()}
    except (OSError, ValueError):
        return {}


def _pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def tcp_forward(port: int, host: str) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("0.0.0.0", port))
        server.listen(16)
        while True:
            client, _ = server.accept()
            try:
                upstream = socket.create_connection((host, port), timeout=5)
                upstream.settimeout(None)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pipe, args=(client, upstream), daemon=True).start()
            threading.Thread(target=_pipe, args=(upstream, client), daemon=True).start()


def udp_forward(port: int, host: str) -> None:
    """Forward datagrams to host:port and send its replies back to whoever asked."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
        server.bind(("0.0.0.0", port))
        upstreams: dict[tuple, socket.socket] = {}
        while True:
            data, client = server.recvfrom(65536)
            up = upstreams.get(client)
            if up is None:
                up = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                up.bind(("0.0.0.0", 0))  # bind before listening for replies
                upstreams[client] = up

                def replies(up=up, client=client):
                    try:
                        while True:
                            server.sendto(up.recvfrom(65536)[0], client)
                    except OSError:
                        pass
                threading.Thread(target=replies, daemon=True).start()
            try:
                up.sendto(data, (host, port))
            except OSError:
                pass


if __name__ == "__main__":
    for fwd_port, fwd_host in load_forwards().items():
        threading.Thread(target=tcp_forward, args=(fwd_port, fwd_host), daemon=True).start()
        threading.Thread(target=udp_forward, args=(fwd_port, fwd_host), daemon=True).start()
    threading.Thread(target=udp_relay, daemon=True).start()
    notify_key()  # make the key on first run, so it can be shown to the user
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

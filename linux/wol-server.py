#!/usr/bin/env python3
"""Home Deck wake service for the Chrome OS Linux container (penguin).

Chrome can't send Wake-on-LAN packets, but Linux can. This listens on port 9009 and, when Home Deck
POSTs to /wake, broadcasts a magic packet for the given MAC address. It sleeps in accept() the rest
of the time, so it costs nothing while idle. Standard library only.

    POST http://penguin.linux.test:9009/wake   {"mac": "04:7C:16:48:3D:E8"}
"""

import json
import re
import socket
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9009
TARGETS = [("255.255.255.255", 9), ("255.255.255.255", 7)]  # plus this network's x.y.z.255, see send()


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
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
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

    def do_GET(self):
        self._reply(200, {"ok": True, "app": "home-deck-wol"})

    def do_POST(self):
        if self.path.rstrip("/") != "/wake":
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


if __name__ == "__main__":
    import threading
    threading.Thread(target=udp_relay, daemon=True).start()
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

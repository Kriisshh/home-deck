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
TARGETS = [("255.255.255.255", 9), ("192.168.1.255", 9), ("255.255.255.255", 7)]


def magic_packet(mac: str) -> bytes:
    digits = re.sub(r"[^0-9a-fA-F]", "", mac)
    if len(digits) != 12:
        raise ValueError(f"not a MAC address: {mac!r}")
    return b"\xff" * 6 + bytes.fromhex(digits) * 16


def send(mac: str, ip: str = "") -> None:
    packet = magic_packet(mac)
    # Broadcasts often stay inside the Linux container's private network, so when the device's IP is
    # known, also send straight to it (that crosses Chrome OS's NAT onto the home network).
    targets = list(TARGETS)
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


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

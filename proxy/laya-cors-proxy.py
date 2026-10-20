#!/usr/bin/env python3
"""CORS proxy in front of the local Laya server.

The Laya server (127.0.0.1:8765) is a FastAPI app with no CORS middleware, so a
browser page served from SillyTavern (127.0.0.1:8000) cannot call it directly:
the preflight is answered with 405 and no Access-Control-Allow-Origin header.

This process does NOT load any model. It only forwards /v1/systemone and /health
to the real server and adds the CORS headers. Stdlib only, no venv required.

    python3 laya-cors-proxy.py            # serves 127.0.0.1:8766

Env: LAYA_PROXY_PORT (default 8766), LAYA_UPSTREAM (default http://127.0.0.1:8765)
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("LAYA_UPSTREAM", "http://127.0.0.1:8765").rstrip("/")
PORT = int(os.environ.get("LAYA_PROXY_PORT", "8766"))
HOST = os.environ.get("LAYA_PROXY_HOST", "127.0.0.1")

FORWARD_PATHS = ("/v1/systemone", "/v1/systemone/batch", "/health")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "laya-cors-proxy/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _reply(self, status, body=b"", content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - stdlib naming
        self._reply(204)

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self._reply(404, b'{"detail":"not found"}')
            return
        self._forward("GET", b"")

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path not in FORWARD_PATHS:
            self._reply(404, b'{"detail":"not found"}')
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self._forward("POST", body)

    def _forward(self, method, body):
        url = UPSTREAM + self.path
        request = urllib.request.Request(url, data=body if method == "POST" else None, method=method)
        request.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        auth = self.headers.get("Authorization")
        if auth:
            request.add_header("Authorization", auth)

        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as error:
            payload = error.read()
            status = error.code
            content_type = error.headers.get("Content-Type", "application/json")
        except Exception as error:  # upstream down, timeout, DNS
            payload = json.dumps({"detail": f"laya proxy: {error}"}).encode()
            status = 502
            content_type = "application/json"

        self._reply(status, payload, content_type)

    def log_message(self, fmt, *args):
        print(f"[laya-cors] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"[laya-cors] {HOST}:{PORT} -> {UPSTREAM}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

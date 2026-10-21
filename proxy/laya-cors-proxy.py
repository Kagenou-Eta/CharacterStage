#!/usr/bin/env python3
"""CORS proxy in front of the local Laya server.

The Laya server (127.0.0.1:8765) is a FastAPI app with no CORS middleware, so a
browser page served from SillyTavern (127.0.0.1:8000) cannot call it directly:
the preflight is answered with 405 and no Access-Control-Allow-Origin header.

This process does NOT load any model. It only forwards /v1/systemone and /health
to the real server and adds the CORS headers. Stdlib only, no venv required.

It also prints a readable I/O line per request, because Laya's own access log only
shows the HTTP status:

    [13:04:12] -> batch 5 states  1.9 KB  2 questions each
    [13:04:12] <- Adrian Cho            sadness 0.87     38ms  "Adrian Cho leaned against the lockers..."
    [13:04:12] <- Maddy Katherine       embarrassment 0.92

    python3 laya-cors-proxy.py            # serves 127.0.0.1:8766

Env: LAYA_PROXY_PORT (default 8766), LAYA_UPSTREAM (default http://127.0.0.1:8765),
     LAYA_PROXY_VERBOSE (default 1 - set 0 for access lines only),
     LAYA_PROXY_FULL_STATE (default 0 - set 1 to print the whole state text).
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("LAYA_UPSTREAM", "http://127.0.0.1:8765").rstrip("/")
PORT = int(os.environ.get("LAYA_PROXY_PORT", "8766"))
HOST = os.environ.get("LAYA_PROXY_HOST", "127.0.0.1")

FORWARD_PATHS = ("/v1/systemone", "/v1/systemone/batch", "/health")

VERBOSE = os.environ.get("LAYA_PROXY_VERBOSE", "1").strip() not in ("0", "false", "no", "")
FULL_STATE = os.environ.get("LAYA_PROXY_FULL_STATE", "0").strip() in ("1", "true", "yes")

# "Focus character: Adrian Cho" - the extension prefixes every state this way.
FOCUS = re.compile(r"^Focus character:\s*(.+)$", re.MULTILINE)
WS = re.compile(r"\s+")


def _tty():
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


class C:
    dim = "\033[2m" if _tty() else ""
    bold = "\033[1m" if _tty() else ""
    green = "\033[32m" if _tty() else ""
    yellow = "\033[33m" if _tty() else ""
    red = "\033[31m" if _tty() else ""
    off = "\033[0m" if _tty() else ""


def stamp():
    return time.strftime("%H:%M:%S")


def say(text):
    print(text, flush=True)


def preview(text, limit=70):
    """One flattened line, so a multi-paragraph state still fits on a terminal row."""
    raw = str(text)
    # Drop the "Focus character: X" header first - the name already has its own column.
    # It must go before flattening, or the $ anchor eats the whole paragraph.
    match = FOCUS.search(raw)
    if match:
        raw = raw[:match.start()] + raw[match.end():]
    flat = WS.sub(" ", raw).strip()
    if FULL_STATE or len(flat) <= limit:
        return flat
    return flat[:limit].rstrip() + "..."


def focus_of(state):
    """Character name from the state prefix, falling back to who is being described."""
    match = FOCUS.search(str(state or ""))
    if match:
        return match.group(1).strip()
    return ""


def describe_request(path, body):
    """Print what went in. Returns the parsed payload so the reply can be matched to it."""
    if not VERBOSE or not body:
        return None
    try:
        payload = json.loads(body)
    except Exception:
        say(f"{C.dim}[{stamp()}] -> {path} {len(body)} B (unparseable){C.off}")
        return None

    if path.endswith("/batch"):
        states = payload.get("states") or []
        questions = payload.get("questions") or {}
        say(
            f"{C.dim}[{stamp()}] -> {C.off}{C.bold}batch {len(states)} states{C.off}"
            f"{C.dim}  {len(body) / 1024:.1f} KB  {len(questions)} questions each"
            f"  model={payload.get('model') or 'auto'}{C.off}"
        )
        for index, state in enumerate(states):
            say(f"{C.dim}[{stamp()}]    in {index + 1}: {focus_of(state) or '(no name)'}  {C.off}{preview(state)}")
        return payload

    state = payload.get("state", "")
    questions = payload.get("questions") or {}
    say(
        f"{C.dim}[{stamp()}] -> {C.off}{C.bold}{focus_of(state) or path}{C.off}"
        f"{C.dim}  {len(str(state))} chars  {len(questions)} questions"
        f"  model={payload.get('model') or 'auto'}{C.off}"
    )
    say(f"{C.dim}[{stamp()}]    in: {C.off}{preview(state)}")
    return payload


def answer_line(answers, ms):
    """Summarise one answer set: the choice winner and its confidence."""
    if not isinstance(answers, dict):
        return None
    choice = answers.get("expression") or {}
    label = choice.get("choice")
    confidence = choice.get("answer_confidence")
    if label is None:
        # No choice head in this call - show the strongest noul instead.
        scored = [(k, v.get("noul")) for k, v in answers.items()
                  if isinstance(v, dict) and isinstance(v.get("noul"), (int, float))]
        if not scored:
            return None
        label, confidence = max(scored, key=lambda item: item[1])
    return label, confidence, ms


def report_response(path, payload, body, ms):
    """Print what came back, matched to the request it belongs to."""
    if not VERBOSE:
        return
    try:
        data = json.loads(body)
    except Exception:
        say(f"{C.dim}[{stamp()}] <- could not parse reply ({len(body)} B) {ms:.0f}ms{C.off}")
        return

    usage = data.get("usage") or {}
    tokens = ""
    if usage.get("state_tokens") is not None:
        tokens = f"{C.dim}  {usage['state_tokens']} tok"
        if usage.get("state_tokens_dropped"):
            tokens += f", {usage['state_tokens_dropped']} dropped"
        tokens += C.off

    states = payload.get("states") if isinstance(payload, dict) else None
    results = data.get("results")

    if isinstance(results, list) and isinstance(states, list):
        for index, result in enumerate(results):
            name = focus_of(states[index]) if index < len(states) else f"#{index + 1}"
            line = answer_line((result or {}).get("answers"), ms)
            if line is None:
                say(f"{C.dim}[{stamp()}] <- {name:<20} no answer{C.off}")
                continue
            label, confidence, _ = line
            conf = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else "?"
            result_usage = (result or {}).get("usage") or {}
            tok = ""
            if result_usage.get("state_tokens") is not None:
                tok = f"  {result_usage['state_tokens']} tok"
                if result_usage.get("state_tokens_dropped"):
                    tok += f", {result_usage['state_tokens_dropped']} dropped"
            say(f"{C.dim}[{stamp()}] <- {C.off}{C.green}{name:<20}{C.off} "
                f"{C.bold}{label:<14}{C.off} {C.dim}{conf}{tok}{C.off}")
        say(f"{C.dim}[{stamp()}]    batch finished in {ms:.0f}ms{C.off}")
        return

    name = focus_of((payload or {}).get("state", "")) or path
    line = answer_line(data.get("answers"), ms)
    if line is None:
        say(f"{C.dim}[{stamp()}] <- {name} no answer  {ms:.0f}ms{C.off}")
        return
    label, confidence, elapsed = line
    conf = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else "?"
    say(f"{C.dim}[{stamp()}] <- {C.off}{C.green}{name:<20}{C.off} "
        f"{C.bold}{label:<14}{C.off} {C.dim}{conf}  {elapsed:.0f}ms{C.off}{tokens}")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "laya-cors-proxy/1.1"

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
        path = self.path
        # Liveness polling would otherwise bury the useful lines.
        quiet = path.split("?")[0] == "/health"
        payload = None if quiet else describe_request(path, body)

        url = UPSTREAM + path
        request = urllib.request.Request(url, data=body if method == "POST" else None, method=method)
        request.add_header("Content-Type", self.headers.get("Content-Type", "application/json"))
        auth = self.headers.get("Authorization")
        if auth:
            request.add_header("Authorization", auth)

        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                reply = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as error:
            reply = error.read()
            status = error.code
            content_type = error.headers.get("Content-Type", "application/json")
        except Exception as error:  # upstream down, timeout, DNS
            reply = json.dumps({"detail": f"laya proxy: {error}"}).encode()
            status = 502
            content_type = "application/json"
        elapsed_ms = (time.perf_counter() - started) * 1000

        if not quiet:
            if status >= 400:
                say(f"{C.red}[{stamp()}] !! HTTP {status} from upstream {path} "
                    f"({elapsed_ms:.0f}ms){C.off} {reply[:200].decode('utf-8', 'replace')}")
            else:
                report_response(path, payload, reply, elapsed_ms)

        self._reply(status, reply, content_type)

    def log_message(self, fmt, *args):
        # Replaced by the structured lines above; keep stderr clean.
        pass


if __name__ == "__main__":
    say(f"[laya-cors] {HOST}:{PORT} -> {UPSTREAM}"
        f"  (verbose={'on' if VERBOSE else 'off'}, full state={'on' if FULL_STATE else 'off'})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

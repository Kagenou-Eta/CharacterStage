# Laya CORS proxy

The Laya server (`127.0.0.1:8765`) is a FastAPI app with no CORS middleware, so a page
served from SillyTavern (`127.0.0.1:8000`) cannot call it: the preflight is answered with
`405` and no `Access-Control-Allow-Origin` header. This proxy sits in front of it, forwards
`/v1/systemone`, `/v1/systemone/batch` and `/health`, and adds the headers.

It does **not** load any model — it is a thin stdlib-only forwarder, so it needs no venv.

```bash
python3 laya-cors-proxy.py          # serves 127.0.0.1:8766
```

Environment variables:

| Variable | Default |
| --- | --- |
| `LAYA_PROXY_HOST` | `127.0.0.1` |
| `LAYA_PROXY_PORT` | `8766` |
| `LAYA_UPSTREAM` | `http://127.0.0.1:8765` |
| `LAYA_PROXY_VERBOSE` | `1` |
| `LAYA_PROXY_FULL_STATE` | `0` |

## What it prints

Laya's own access log reports only the HTTP status, which tells you nothing about the
classification. The proxy sees both sides of the exchange, so each request gets a block:

```text
[13:04:12] -> batch 5 states  1.9 KB  8 questions each  model=auto
[13:04:12]    in 1: Adrian Cho  Adrian Cho leaned against the lockers and sighed. "Whatever....
[13:04:12]    in 2: Maddy Katherine  Maddy Katherine peeked out from behind the corner, cheeks ...
[13:04:12] <- Adrian Cho           anger          0.93  38 tok
[13:04:12] <- Maddy Katherine      embarrassment  0.92  41 tok
[13:04:12]    batch finished in 358ms
```

The incoming line shows the character (taken from the extension's `Focus character:`
prefix) plus a preview of the excerpt Laya was given; the outgoing line shows the winning
label, its confidence, and the state token count. Set `LAYA_PROXY_VERBOSE=0` for
access-lines only, or `LAYA_PROXY_FULL_STATE=1` to print complete state strings instead
of previews. `/health` polling is never logged, so it cannot bury the useful lines.

## Run it as a user service

`laya-cors.service` is a ready-made systemd user unit. It assumes the script lives at
`~/laya/laya-cors-proxy.py`; adjust `WorkingDirectory` and `ExecStart` if yours is
elsewhere.

```bash
mkdir -p ~/.config/systemd/user
cp laya-cors.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now laya-cors
```

Note that output under systemd goes to the journal (`journalctl --user -u laya-cors -f`).
If you want the I/O streamed live in a terminal, run the script directly instead of as a
service — Laya holds a model in VRAM, so most people only start it when they need it.

Check it with `systemctl --user status laya-cors` or
`curl http://127.0.0.1:8766/health`.

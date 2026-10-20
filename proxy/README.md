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

Check it with `systemctl --user status laya-cors` or
`curl http://127.0.0.1:8766/health`.

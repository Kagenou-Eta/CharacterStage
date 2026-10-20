# CharacterStage

Show **any** character's sprites in **any** chat, with the expression chosen by a local
System One model (Laya). Built for a workflow where one blank character card is used and
every character lives in a lorebook, so SillyTavern's native sprite support — which only
works across a group chat — is not enough.

![Five characters on the Character Stage, each showing the expression matched to the reply](docs/stage.jpg)

Install from SillyTavern's **Extensions** menu → **Install Extension**, pasting
`https://github.com/Kagenou-Eta/CharacterStage` as the Git URL.

## What it does

- **Roster from lorebooks.** Scans the active (or selected) lorebooks for
  `[Character: Name | ...]` headers and keeps only names that have a matching sprite folder
  in `data/default-user/characters/<Name>/`. The roster can be edited by hand
  (`Display Name | Sprite Folder | alias, alias`).
- **Stage.** Up to *Max characters on stage* sprites at once. In Visual Novel mode they stand
  in one row across the window with the chat box drawn over their lower half — the native
  SillyTavern look, outer sprites slightly larger and in front. In flat-chat mode the cast
  splits into a left and a right group in the free margins.
- **Auto-cast.** After every reply the characters mentioned in the latest assistant turn go
  on stage and stay for `stickiness` extra turns. Characters can also be added, pinned,
  removed and given a manual expression from the floating panel (wand menu → **Character
  Stage**).
- **Expressions.** The latest assistant turn is sent to Laya, which scores each expression
  label; the best label above *Minimum confidence* is applied. A small cue list biases
  obvious physical signs (tears, a cracking voice) towards sadness. Expression choice never
  touches the main chat model.

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) — developed and tested against 1.19.0.
- [Laya](https://huggingface.co/convaiinnovations/laya) running locally and reachable from the
  browser. The browser cannot call Laya directly (the server sends no CORS headers), so run the
  bundled proxy — see [`proxy/`](proxy/).

  ```bash
  python3 proxy/laya-cors-proxy.py      # serves 127.0.0.1:8766 -> 127.0.0.1:8765
  ```

  Default proxy URL is `http://127.0.0.1:8766`, configurable in the settings.

- Character folders with expression images named after SillyTavern's noun-form convention:
  `anger`, `aroused`, `embarrassment`, `happy`, `neutral`, `profile`, `sadness`, `surprise`.
  Sets that ship the 28-label GoEmotions set are mapped onto these labels automatically
  (`joy` → `happy`, `annoyance` → `anger`, …).

## About Laya

[Laya](https://huggingface.co/convaiinnovations/laya) is a non-autoregressive System 1 decision
model from Convai Innovations: give it a state (text, email, ticket, JSON) and typed questions,
and it returns typed answers with calibrated probabilities in a single forward pass — around
33 ms on a T4 — across 100+ languages. It never generates text, so there is nothing to parse
and nothing to hallucinate, which is exactly what an expression picker needs.

This extension uses the self-hosted HTTP server rather than the Python SDK, so any
Jev-compatible `/v1/systemone` endpoint works. A minimal setup:

```bash
pip install "laya[serve]"
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve     # 0.0.0.0:8000, preloads the checkpoints
```

Set `LAYA_HOST=127.0.0.1 LAYA_PORT=8765` to match the proxy's default upstream. Copy
`laya.env` style settings into a systemd unit if you want it to start with your session.

Useful links: [model card](https://huggingface.co/convaiinnovations/laya) ·
[GitHub](https://github.com/NandhaKishorM/laya) ·
[docs](https://nandhakishorm.github.io/laya/) ·
[PyPI](https://pypi.org/project/laya/)

## Settings

| Setting | Meaning |
| --- | --- |
| Enable the sprite stage | Master switch |
| Change expressions automatically (Laya) | Turn classification off to keep expressions manual |
| Put characters on stage when their name appears in the reply | Auto-cast |
| Dim characters who are not in the current reply | Visual de-emphasis |
| Prefer sadness when the text describes crying or a breaking voice | Cue hints |
| Proxy URL / Model override | Laya endpoint and optional checkpoint name |
| Minimum confidence | Below this the current expression is kept |
| Maximum characters on stage | 1-8, default 5 |
| Sprite height (% of window) | 20-100, default 90 (matches native VN sizing) |
| Extra turns a character stays | Stickiness after the last mention |
| Text sent to Laya per character | Excerpt length |
| Lorebooks to scan / Roster | Where characters come from and the resulting list |

## How expression picking works

Each assistant turn is classified in one `/v1/systemone/batch` request (about 50 ms for five
characters), with a per-character fallback if the batch fails. Per character, two kinds of
question are asked at once and blended 50/50:

- one `choice` question with every expression label as a criterion, and
- one `noul` question per label — `"Is this true of the focus character in the scene? the focus
  character is angry or glaring"`.

Laya's [model card](https://huggingface.co/convaiinnovations/laya) documents two failure modes
this pairing works around:

- **High-cardinality choice questions** share a fixed token budget (`head_max_len`, 192 on the
  English checkpoint by default), so many options leave each label only a few tokens and the
  labels stop being distinguishable. Seven labels is still fine, but the `noul` questions use
  the budget better.
- **`noul` can latch onto its own `false:`/`true:` labels** instead of reading the state. Since
  the two primitives fail differently, blending them lets either one carry the answer — that is
  what raised accuracy from 9/12 to 10/12 on the local probe set.

A small cue list catches the unambiguous physical signs of crying (tears, a cracking voice) and
biases towards `sadness`, because those lines otherwise get read as `happy`.

**On calibration:** Laya ships over-confident — the model card reports ECE 0.466 before
temperature fitting, 0.081 after. The extension's *Minimum confidence* gate defaults to `0.2`
rather than a high value for that reason: the raw number is a relative ranking between labels,
not a literal probability, so gating aggressively would throw away correct answers. Fit
temperatures on your own data if you want the number to mean what it says.

## Files

- `index.js` — roster scan, cast management, layout, Laya classification
- `style.css` — stage and panel styling
- `settings.html` — settings block injected into the Extensions drawer
- `manifest.json` — extension manifest
- `proxy/laya-cors-proxy.py` — dependency-free CORS proxy for the Laya server
- `proxy/laya-cors.service` — systemd user unit for the proxy

## Credits

- [Laya](https://huggingface.co/convaiinnovations/laya) by Convai Innovations (Apache 2.0) —
  the System 1 decision model.
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) — the host application.

## License

MIT — see [LICENSE](LICENSE).

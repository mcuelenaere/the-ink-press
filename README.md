# the-ink-press

Daily news → summary → image prompt → generated image (CLI).

## Setup

- Install deps:

```bash
bun install
```

- Configure env:

```bash
cp .env.example .env
```

Then set:
- `AI_GATEWAY_API_KEY` (used for both the OpenAI+web_search headlines step and `google/gemini-3-pro-image-preview`)

### Inkposter upload (optional)

To upload generated images to your Inkposter e-ink display, also set:
- `INKPOSTER_EMAIL` — Your Inkposter account email
- `INKPOSTER_PASSWORD` — Your Inkposter account password
- `INKPOSTER_FRAME_UUID` — The frame UUID to upload to
- `INKPOSTER_FRAME_MODEL` — Frame model for image resizing: `Frame_13_3`, `Frame_28_5`, `Frame_31_5` (or `13.3`, `28.5`, `31.5`)

Optional Inkposter settings:
- `INKPOSTER_ROTATE` — Rotation in degrees (`0`, `90`, `180`, `270`); useful if the image appears upside down
- `INKPOSTER_TOKEN_FILE` — Path for persisting auth state across restarts (default: `.inkposter-tokens.json`)

Authentication is handled automatically: the app logs in with your email/password on first run, persists tokens to `.inkposter-tokens.json`, and refreshes them as needed.

Then run with `--upload` to enable uploading after image generation.

## Run

```bash
bun run dev
```

## Useful flags

```bash
bun run dev -- --query "top tech news today" --headlines 8
bun run dev -- --no-image
bun run dev -- --upload  # Generate and upload to Inkposter
```

## Output

Each run writes to `./out/<timestamp>/`:
- `manifest.json` (headlines, summary, image prompt, metadata, Inkposter upload status if `--upload`)
- `summary.txt`
- `image-prompt.txt`
- `image.<ext>` (when an image was returned)

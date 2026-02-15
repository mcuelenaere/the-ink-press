# the-ink-press

Daily news → summary → image prompt → generated image (CLI).

## Setup

- Install deps:

```bash
npm install
```

- Configure env:

```bash
cp .env.example .env
```

Then set:
- `AI_GATEWAY_API_KEY` (used for both the OpenAI+web_search headlines step and `google/gemini-3-pro-image-preview`)

### Inkposter upload (optional)

To upload generated images to your Inkposter e-ink display, also set:
- `INKPOSTER_TOKEN` — Bearer token from the Inkposter app
- `INKPOSTER_DEVICE_ID` — Your device ID
- `INKPOSTER_FRAME_UUID` — The frame UUID to upload to

Then run with `--upload` to enable uploading after image generation.

## Run

- **One-shot run (recommended for testing)**:

```bash
npm run dev -- --once
```

- **Run continuously (24h loop)**:

```bash
npm run dev
```

## Useful flags

```bash
npm run dev -- --once --query "top tech news today; emphasize AI + policy" --headlines 8
npm run dev -- --once --no-image
npm run dev -- --interval-hours 6
npm run dev -- --once --upload  # Generate and upload to Inkposter
```

The `--query` value is used both to guide web search and to shape the summary.

## RSS feeds (optional)

By default, headlines are gathered using ChatGPT web search. You can add RSS
feeds as extra context by providing one or more feed URLs:

```bash
npm run dev -- --once --rss https://example.com/rss
npm run dev -- --once --rss https://a.com/rss,https://b.com/rss
```

## Output

Each run writes to `./out/<timestamp>/`:
- `manifest.json` (headlines, summary, image prompt, metadata, Inkposter upload status if `--upload`)
- `summary.txt`
- `image-prompt.txt`
- `image.<ext>` (when an image was returned)



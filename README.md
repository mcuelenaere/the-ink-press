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
npm run dev -- --once --query "top tech news today" --headlines 8
npm run dev -- --once --no-image
npm run dev -- --interval-hours 6
```

## Output

Each run writes to `./out/<timestamp>/`:
- `manifest.json` (headlines, summary, image prompt, metadata)
- `summary.txt`
- `image-prompt.txt`
- `image.<ext>` (when an image was returned)



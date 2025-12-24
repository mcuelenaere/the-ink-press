import 'dotenv/config';

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import { fetchDailyNews, generateGeminiImage } from './ai';
import {
    fileExtensionFromMediaType,
    getRequiredEnv,
    isoTimestampForPath,
    logStatus,
    mkdirp,
    sleep,
    writeJson
} from './utils';

type CliOptions = {
    once: boolean;
    intervalHours: number;
    query: string;
    headlines: number;
    out: string;
    noImage: boolean;
};

function parseCliArgs(argv: string[]): CliOptions {
    const program = new Command();

    program
        .name('the-ink-press')
        .description('Daily news -> summary -> image prompt -> generated image (CLI).')
        .option('--once', 'Run a single cycle and exit', false)
        .option('--interval-hours <n>', 'Loop interval in hours', (v) => Number(v), 24)
        .option('--query <string>', 'Search query for today’s headlines', 'top news headlines today')
        .option('--headlines <n>', 'Number of headlines to include', (v) => Number(v), 10)
        .option('--out <path>', 'Output directory', './out')
        .option('--no-image', 'Skip image generation (debug)', false)
        .parse(argv);

    const opts = program.opts<CliOptions>();

    if (!Number.isFinite(opts.intervalHours) || opts.intervalHours <= 0) {
        throw new Error(`--interval-hours must be a positive number (got: ${String(opts.intervalHours)})`);
    }

    if (!Number.isInteger(opts.headlines) || opts.headlines <= 0 || opts.headlines > 50) {
        throw new Error(`--headlines must be an integer between 1 and 50 (got: ${String(opts.headlines)})`);
    }

    return opts;
}

// AI calls live in src/ai.ts; helpers live in src/utils.ts.

async function runCycle(cli: CliOptions) {
    const startedAt = new Date();
    const dateLabel = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        timeZone: 'UTC'
    }).format(startedAt);

    const runId = isoTimestampForPath(startedAt);
    const runDir = path.resolve(cli.out, runId);
    await mkdirp(runDir);

    logStatus(`Cycle start (runId=${runId})`);
    logStatus(`Preparing output dir: ${runDir}`);

    const manifest: Record<string, unknown> = {
        runId,
        startedAt: startedAt.toISOString(),
        query: cli.query,
        requestedHeadlineCount: cli.headlines,
        models: {
            headlines: 'gateway:openai/gpt-5.2 (with openai.web_search_preview)',
            image: cli.noImage ? null : 'gateway:google/gemini-3-pro-image-preview'
        }
    };

    try {
        logStatus(
            `Headlines+prompt: starting (model=gateway:openai/gpt-5.2, date=${dateLabel}, query=${JSON.stringify(cli.query)}, maxHeadlines=${cli.headlines})`
        );
        const news = await fetchDailyNews({
            query: cli.query,
            maxHeadlines: cli.headlines,
            dateLabel,
            reporter: { info: (m) => logStatus(m) }
        });
        logStatus(`Headlines+prompt: received (${news.headlines.length} headlines)`);

        manifest.news = news;

        logStatus(`Writing summary + image prompt files...`);
        await fs.promises.writeFile(path.join(runDir, 'summary.txt'), news.summary + '\n', 'utf8');
        await fs.promises.writeFile(path.join(runDir, 'caption.txt'), news.captionText + '\n', 'utf8');
        await fs.promises.writeFile(path.join(runDir, 'concepts.txt'), news.concepts.join('\n') + '\n', 'utf8');
        await fs.promises.writeFile(path.join(runDir, 'image-prompt.txt'), news.imagePrompt + '\n', 'utf8');

        if (!cli.noImage) {
            logStatus(`Image generation: starting (model=gateway:google/gemini-3-pro-image-preview)`);
            const imageResult = await generateGeminiImage({
                imagePrompt: news.imagePrompt,
                captionText: news.captionText,
                reporter: { info: (m) => logStatus(m) }
            });
            manifest.image = {
                mediaType: imageResult.image?.mediaType ?? null,
                hadImageFile: Boolean(imageResult.image),
                modelText: imageResult.rawText?.slice(0, 4000) ?? ''
            };

            if (imageResult.image) {
                const ext = fileExtensionFromMediaType(imageResult.image.mediaType);
                const outPath = path.join(runDir, `image.${ext}`);
                logStatus(`Writing image file: ${path.basename(outPath)} (${imageResult.image.mediaType}, ${imageResult.image.file.byteLength} bytes)`);
                await fs.promises.writeFile(outPath, imageResult.image.file);
                manifest.image = { ...(manifest.image as object), file: path.basename(outPath) };
            } else {
                logStatus(`Image generation: no image file returned; writing debug file`);
                await fs.promises.writeFile(
                    path.join(runDir, 'image-generation.txt'),
                    `No image file was returned.\n\nModel text output:\n${imageResult.rawText}\n`,
                    'utf8'
                );
            }
        }

        manifest.finishedAt = new Date().toISOString();
        manifest.status = 'ok';
        logStatus(`Cycle done (ok)`);
    } catch (err) {
        manifest.finishedAt = new Date().toISOString();
        manifest.status = 'error';
        manifest.error = err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
        logStatus(`Cycle done (error)`);
        throw err;
    } finally {
        logStatus(`Writing manifest.json`);
        await writeJson(path.join(runDir, 'manifest.json'), manifest);
        // Helpful pointer in logs:
        // eslint-disable-next-line no-console
        console.log(`Wrote run output to: ${runDir}`);
    }
}

async function main() {
    const cli = parseCliArgs(process.argv);
    // Used for both the OpenAI+web_search step and the Gemini image generation step.
    getRequiredEnv('AI_GATEWAY_API_KEY');

    // eslint-disable-next-line no-console
    console.log(
        `the-ink-press starting (once=${cli.once}, intervalHours=${cli.intervalHours}, headlines=${cli.headlines}, noImage=${cli.noImage})`
    );

    while (true) {
        try {
            await runCycle(cli);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(err);
            const backoffMs = 10 * 60 * 1000;
            // eslint-disable-next-line no-console
            console.log(`Error cycle; retrying in ${Math.round(backoffMs / 60000)} minutes...`);
            await sleep(backoffMs);
            continue;
        }

        if (cli.once) return;

        const sleepMs = cli.intervalHours * 60 * 60 * 1000;
        // eslint-disable-next-line no-console
        console.log(`Sleeping for ${cli.intervalHours} hours...`);
        await sleep(sleepMs);
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
});



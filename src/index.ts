import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { generateGeminiImage } from "./ai";
import { getInkposterConfig, InkposterAuth, uploadAndPoll } from "./inkposter";
import { fetchDailyNews } from "./news";
import {
	fileExtensionFromMediaType,
	getRequiredEnv,
	isoTimestampForPath,
	logStatus,
	mkdirp,
	sleep,
	writeJson,
} from "./utils";

type CliOptions = {
	prompt: string;
	headlines: number;
	out: string;
	noImage: boolean;
	upload: boolean;
	rssFeeds: string[];
};

function collectRssFeeds(value: string, previous: string[]) {
	const parts = value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	return previous.concat(parts);
}

function normalizeRssFeeds(values: string[]): string[] {
	const unique = new Set<string>();
	const feeds: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			throw new Error(`Invalid RSS feed URL: ${trimmed}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`RSS feed URL must be http or https: ${url.toString()}`);
		}
		const normalized = url.toString();
		if (!unique.has(normalized)) {
			unique.add(normalized);
			feeds.push(normalized);
		}
	}

	return feeds;
}

function parseCliArgs(argv: string[]): CliOptions {
	const program = new Command();

	program
		.name("the-ink-press")
		.description(
			"Daily news -> summary -> image prompt -> generated image (CLI).",
		)
		.option(
			"--query <string>",
			"Prompt for web search + daily brief summary",
			"top news headlines today",
		)
		.option(
			"--headlines <n>",
			"Number of headlines to include",
			(v) => Number(v),
			10,
		)
		.option(
			"--rss <url>",
			"RSS feed URL (repeatable or comma-separated)",
			collectRssFeeds,
			[],
		)
		.option("--out <path>", "Output directory", "./out")
		.option("--no-image", "Skip image generation (debug)", false)
		.option("--upload", "Upload generated image to Inkposter", false)
		.parse(argv);

	const opts = program.opts<{
		query: string;
		headlines: number;
		out: string;
		noImage: boolean;
		upload: boolean;
		rss: string[];
	}>();

	if (
		!Number.isInteger(opts.headlines) ||
		opts.headlines <= 0 ||
		opts.headlines > 50
	) {
		throw new Error(
			`--headlines must be an integer between 1 and 50 (got: ${String(opts.headlines)})`,
		);
	}

	const rssFeeds = normalizeRssFeeds(opts.rss);

	return {
		prompt: opts.query,
		headlines: opts.headlines,
		out: opts.out,
		noImage: opts.noImage,
		upload: opts.upload,
		rssFeeds,
	};
}

// AI calls live in src/ai.ts; helpers live in src/utils.ts.

async function runCycle(cli: CliOptions, inkposterAuth: InkposterAuth | null) {
	const startedAt = new Date();
	const dateLabel = new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "short",
		day: "2-digit",
		timeZone: "UTC",
	}).format(startedAt);

	const runId = isoTimestampForPath(startedAt);
	const runDir = path.resolve(cli.out, runId);
	await mkdirp(runDir);

	logStatus(`Cycle start (runId=${runId})`);
	logStatus(`Preparing output dir: ${runDir}`);

	const newsSourceConfig = {
		prompt: cli.prompt,
		rssFeeds: cli.rssFeeds.length > 0 ? cli.rssFeeds : undefined,
	};

	const manifest: Record<string, unknown> = {
		runId,
		startedAt: startedAt.toISOString(),
		prompt: cli.prompt,
		query: cli.prompt,
		requestedHeadlineCount: cli.headlines,
		rssFeeds: cli.rssFeeds.length > 0 ? cli.rssFeeds : undefined,
		models: {
			headlines: "gateway:openai/gpt-5.2 (with openai.web_search_preview)",
			brief: "gateway:openai/gpt-5.2",
			image: cli.noImage ? null : "gateway:google/gemini-3-pro-image-preview",
		},
	};

	try {
		logStatus(
			`News: starting (date=${dateLabel}, prompt=${JSON.stringify(cli.prompt)}, maxHeadlines=${cli.headlines}, rssFeeds=${cli.rssFeeds.length})`,
		);
		const news = await fetchDailyNews({
			source: newsSourceConfig,
			dateLabel,
			maxHeadlines: cli.headlines,
			reporter: { info: (m) => logStatus(m) },
		});
		logStatus(`News: received (${news.headlines.length} headlines)`);

		manifest.news = news;
		manifest.newsSources = news.sources;

		logStatus(`Writing summary + image prompt files...`);
		await fs.promises.writeFile(
			path.join(runDir, "summary.txt"),
			`${news.summary}\n`,
			"utf8",
		);
		await fs.promises.writeFile(
			path.join(runDir, "caption.txt"),
			`${news.captionText}\n`,
			"utf8",
		);
		await fs.promises.writeFile(
			path.join(runDir, "concepts.txt"),
			`${news.concepts.join("\n")}\n`,
			"utf8",
		);
		await fs.promises.writeFile(
			path.join(runDir, "image-prompt.txt"),
			`${news.imagePrompt}\n`,
			"utf8",
		);

		if (!cli.noImage) {
			logStatus(
				`Image generation: starting (model=gateway:google/gemini-3-pro-image-preview)`,
			);
			const imageResult = await generateGeminiImage({
				imagePrompt: news.imagePrompt,
				captionText: news.captionText,
				reporter: { info: (m) => logStatus(m) },
			});
			manifest.image = {
				mediaType: imageResult.image?.mediaType ?? null,
				hadImageFile: Boolean(imageResult.image),
				modelText: imageResult.rawText?.slice(0, 4000) ?? "",
			};

			if (imageResult.image) {
				const ext = fileExtensionFromMediaType(imageResult.image.mediaType);
				const outPath = path.join(runDir, `image.${ext}`);
				logStatus(
					`Writing image file: ${path.basename(outPath)} (${imageResult.image.mediaType}, ${imageResult.image.file.byteLength} bytes)`,
				);
				await fs.promises.writeFile(outPath, imageResult.image.file);
				manifest.image = {
					...(manifest.image as object),
					file: path.basename(outPath),
				};

				// Upload to Inkposter if requested
				if (cli.upload && inkposterAuth) {
					logStatus(`Inkposter upload: starting`);
					const maxRetries = 5;
					let lastError: unknown;
					for (let attempt = 1; attempt <= maxRetries; attempt++) {
						try {
							const uploadResult = await uploadAndPoll(
								inkposterAuth,
								imageResult.image.file,
							);
							manifest.inkposter = {
								uploaded: true,
								queueId: uploadResult.convertResponse.queueId,
								resize: {
									originalSize: `${uploadResult.resize.originalWidth}x${uploadResult.resize.originalHeight}`,
									targetSize: `${uploadResult.resize.targetWidth}x${uploadResult.resize.targetHeight}`,
									frameModel: inkposterAuth.config.frameModel,
								},
								poll: {
									attempts: uploadResult.poll.attempts,
									elapsedMs: uploadResult.poll.elapsedMs,
									finalStatus: uploadResult.poll.finalResponse.status,
									finalMessage: uploadResult.poll.finalResponse.message ?? null,
									finalItem: uploadResult.poll.finalResponse.item ?? null,
								},
							};
							logStatus(
								`Inkposter upload: complete (status=${uploadResult.poll.finalResponse.status})`,
							);
							lastError = undefined;
							break;
						} catch (err) {
							lastError = err;
							logStatus(
								`Inkposter upload: attempt ${attempt}/${maxRetries} failed: ${err instanceof Error ? err.message : String(err)}`,
							);
							if (attempt < maxRetries) {
								const retryDelaySec = 30;
								logStatus(`Inkposter upload: retrying in ${retryDelaySec}s...`);
								await sleep(retryDelaySec * 1000);
							}
						}
					}
					if (lastError) {
						logStatus(
							`Inkposter upload: giving up after ${maxRetries} attempts`,
						);
						manifest.inkposter = {
							uploaded: false,
							error:
								lastError instanceof Error
									? {
											message: lastError.message,
											stack: lastError.stack,
										}
									: { message: String(lastError) },
							attempts: maxRetries,
						};
					}
				}
			} else {
				logStatus(
					`Image generation: no image file returned; writing debug file`,
				);
				await fs.promises.writeFile(
					path.join(runDir, "image-generation.txt"),
					`No image file was returned.\n\nModel text output:\n${imageResult.rawText}\n`,
					"utf8",
				);
			}
		}

		manifest.finishedAt = new Date().toISOString();
		manifest.status = "ok";
		logStatus(`Cycle done (ok)`);
	} catch (err) {
		manifest.finishedAt = new Date().toISOString();
		manifest.status = "error";
		manifest.error =
			err instanceof Error
				? { message: err.message, stack: err.stack }
				: { message: String(err) };
		logStatus(`Cycle done (error)`);
		throw err;
	} finally {
		logStatus(`Writing manifest.json`);
		await writeJson(path.join(runDir, "manifest.json"), manifest);
		// Helpful pointer in logs:
		// eslint-disable-next-line no-console
		console.log(`Wrote run output to: ${runDir}`);
	}
}

async function main() {
	const cli = parseCliArgs(process.argv);
	// Used for both the OpenAI+web_search step and the Gemini image generation step.
	getRequiredEnv("AI_GATEWAY_API_KEY");

	// Create Inkposter auth once so refreshed tokens persist across cycles.
	// This performs a login (or loads persisted tokens) on first run.
	let inkposterAuth: InkposterAuth | null = null;
	if (cli.upload) {
		inkposterAuth = await InkposterAuth.create(getInkposterConfig());
	}

	// eslint-disable-next-line no-console
	console.log(
		`the-ink-press starting (headlines=${cli.headlines}, noImage=${cli.noImage}, upload=${cli.upload})`,
	);

	await runCycle(cli, inkposterAuth);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error(err);
	process.exitCode = 1;
});

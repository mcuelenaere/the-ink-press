import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { generateGeminiImage } from "./ai";
import { getInkposterConfig, uploadAndPoll } from "./inkposter";
import { fetchDailyNews } from "./news";
import type { NewsSourceId } from "./news-sources";
import { isNewsSourceId, NEWS_SOURCE_IDS } from "./news-sources";
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
	once: boolean;
	intervalHours: number;
	query: string;
	headlines: number;
	out: string;
	noImage: boolean;
	upload: boolean;
	newsSource: NewsSourceId;
	rssFeeds: string[];
};

const DEFAULT_NEWS_SOURCE: NewsSourceId = "chatgpt-web-search";

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
		.option("--once", "Run a single cycle and exit", false)
		.option(
			"--interval-hours <n>",
			"Loop interval in hours",
			(v) => Number(v),
			24,
		)
		.option(
			"--query <string>",
			"Search query for today’s headlines",
			"top news headlines today",
		)
		.option(
			"--headlines <n>",
			"Number of headlines to include",
			(v) => Number(v),
			10,
		)
		.option(
			"--news-source <id>",
			`Headline source module (${NEWS_SOURCE_IDS.join(", ")})`,
			DEFAULT_NEWS_SOURCE,
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
		once: boolean;
		intervalHours: number;
		query: string;
		headlines: number;
		out: string;
		noImage: boolean;
		upload: boolean;
		newsSource: string;
		rss: string[];
	}>();

	if (!Number.isFinite(opts.intervalHours) || opts.intervalHours <= 0) {
		throw new Error(
			`--interval-hours must be a positive number (got: ${String(opts.intervalHours)})`,
		);
	}

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
	let newsSource = opts.newsSource;
	const newsSourceSource = program.getOptionValueSource("newsSource");

	if (rssFeeds.length > 0 && newsSourceSource !== "cli") {
		newsSource = "rss-feeds";
	}

	if (!isNewsSourceId(newsSource)) {
		throw new Error(
			`--news-source must be one of: ${NEWS_SOURCE_IDS.join(", ")} (got: ${newsSource})`,
		);
	}

	if (newsSource !== "rss-feeds" && rssFeeds.length > 0) {
		throw new Error(
			`--rss can only be used with --news-source rss-feeds (got: ${newsSource})`,
		);
	}

	if (newsSource === "rss-feeds" && rssFeeds.length === 0) {
		throw new Error(
			`--news-source rss-feeds requires at least one --rss feed URL`,
		);
	}

	return {
		once: opts.once,
		intervalHours: opts.intervalHours,
		query: opts.query,
		headlines: opts.headlines,
		out: opts.out,
		noImage: opts.noImage,
		upload: opts.upload,
		newsSource,
		rssFeeds,
	};
}

// AI calls live in src/ai.ts; helpers live in src/utils.ts.

async function runCycle(cli: CliOptions) {
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
		id: cli.newsSource,
		query: cli.query,
		rssFeeds: cli.rssFeeds.length > 0 ? cli.rssFeeds : undefined,
	};

	const manifest: Record<string, unknown> = {
		runId,
		startedAt: startedAt.toISOString(),
		query: cli.query,
		requestedHeadlineCount: cli.headlines,
		newsSource: {
			id: cli.newsSource,
			rssFeeds: cli.rssFeeds.length > 0 ? cli.rssFeeds : undefined,
		},
		models: {
			headlines:
				cli.newsSource === "chatgpt-web-search"
					? "gateway:openai/gpt-5.2 (with openai.web_search_preview)"
					: "rss-feeds",
			brief: "gateway:openai/gpt-5.2",
			image: cli.noImage ? null : "gateway:google/gemini-3-pro-image-preview",
		},
	};

	try {
		logStatus(
			`News: starting (source=${cli.newsSource}, date=${dateLabel}, query=${JSON.stringify(cli.query)}, maxHeadlines=${cli.headlines})`,
		);
		const news = await fetchDailyNews({
			source: newsSourceConfig,
			dateLabel,
			maxHeadlines: cli.headlines,
			reporter: { info: (m) => logStatus(m) },
		});
		logStatus(`News: received (${news.headlines.length} headlines)`);

		manifest.news = news;
		manifest.newsSource = news.source;

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
				if (cli.upload) {
					logStatus(`Inkposter upload: starting`);
					const inkposterConfig = getInkposterConfig();
					const uploadResult = await uploadAndPoll(
						inkposterConfig,
						imageResult.image.file,
					);
					manifest.inkposter = {
						uploaded: true,
						queueId: uploadResult.convertResponse.queueId,
						resize: {
							originalSize: `${uploadResult.resize.originalWidth}x${uploadResult.resize.originalHeight}`,
							targetSize: `${uploadResult.resize.targetWidth}x${uploadResult.resize.targetHeight}`,
							frameModel: inkposterConfig.frameModel,
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

	// Validate Inkposter env vars early if upload is enabled
	if (cli.upload) {
		getInkposterConfig();
	}

	// eslint-disable-next-line no-console
	console.log(
		`the-ink-press starting (once=${cli.once}, intervalHours=${cli.intervalHours}, headlines=${cli.headlines}, noImage=${cli.noImage}, upload=${cli.upload})`,
	);

	while (true) {
		try {
			await runCycle(cli);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error(err);
			const backoffMs = 10 * 60 * 1000;
			// eslint-disable-next-line no-console
			console.log(
				`Error cycle; retrying in ${Math.round(backoffMs / 60000)} minutes...`,
			);
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

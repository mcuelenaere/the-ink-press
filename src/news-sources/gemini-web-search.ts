import { google } from "@ai-sdk/google";
import { gateway, isStepCount, Output, streamText, zodSchema } from "ai";
import { z } from "zod";

import { logLlmStream } from "../ai-utils";
import { GEMINI_HEADLINES_MODEL } from "../models";
import { getReporter } from "../reporting";
import type { NewsSourceModule, NewsSourceOptions } from "./types";
import { buildWebSearchPrompt, HeadlineSchema } from "./web-search-prompt";

function last24HoursFilter() {
	const endTime = new Date();
	const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000);
	return {
		startTime: startTime.toISOString(),
		endTime: endTime.toISOString(),
	};
}

export const geminiWebSearchModule: NewsSourceModule = {
	id: "gemini-web-search",
	displayName: "Gemini Web Search",
	async fetchHeadlines(options: NewsSourceOptions) {
		const { prompt, maxHeadlines, dateLabel, reporter } = options;

		if (!prompt.trim()) {
			throw new Error("Gemini web search requires a non-empty prompt.");
		}

		const report = getReporter(reporter);
		const startedAt = Date.now();

		const HeadlinesSchema = z.object({
			headlines: z.array(HeadlineSchema).min(1).max(maxHeadlines),
		});

		report(`NEWS: streaming start (model=gateway:${GEMINI_HEADLINES_MODEL})`);
		const result = await streamText({
			model: gateway(GEMINI_HEADLINES_MODEL),
			toolChoice: "required",
			stopWhen: isStepCount(5),
			tools: {
				google_search: google.tools.googleSearch({
					searchTypes: { webSearch: {} },
					timeRangeFilter: last24HoursFilter(),
				}),
			},
			output: Output.object({
				schema: zodSchema(HeadlinesSchema),
				name: "DailyHeadlines",
				description: "Top headlines with canonical URLs and source names.",
			}),
			prompt: buildWebSearchPrompt({ dateLabel, prompt, maxHeadlines }),
		});

		await logLlmStream(report, result.stream, "NEWS");

		const out = await result.output;
		report(`NEWS: done (ms=${Date.now() - startedAt})`);

		return {
			headlines: out.headlines.slice(0, maxHeadlines),
			meta: {
				model: `gateway:${GEMINI_HEADLINES_MODEL}`,
				tool: "google.google_search",
			},
		};
	},
};

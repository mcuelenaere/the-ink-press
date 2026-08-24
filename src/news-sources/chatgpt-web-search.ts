import { openai } from "@ai-sdk/openai";
import { gateway, isStepCount, Output, streamText, zodSchema } from "ai";
import { z } from "zod";

import { logLlmStream } from "../ai-utils";
import { CHATGPT_HEADLINES_MODEL, OPENAI_PROVIDER_OPTIONS } from "../models";
import { getReporter } from "../reporting";
import type { NewsSourceModule, NewsSourceOptions } from "./types";
import { buildWebSearchPrompt, HeadlineSchema } from "./web-search-prompt";

export const chatgptWebSearchModule: NewsSourceModule = {
	id: "chatgpt-web-search",
	displayName: "ChatGPT Web Search",
	async fetchHeadlines(options: NewsSourceOptions) {
		const { prompt, maxHeadlines, dateLabel, reporter } = options;

		if (!prompt.trim()) {
			throw new Error("ChatGPT web search requires a non-empty prompt.");
		}

		const report = getReporter(reporter);
		const startedAt = Date.now();

		const HeadlinesSchema = z.object({
			headlines: z.array(HeadlineSchema).min(1).max(maxHeadlines),
		});

		report(`NEWS: streaming start (model=gateway:${CHATGPT_HEADLINES_MODEL})`);
		const result = await streamText({
			model: gateway(CHATGPT_HEADLINES_MODEL),
			providerOptions: OPENAI_PROVIDER_OPTIONS,
			toolChoice: "required",
			stopWhen: isStepCount(5),
			tools: {
				web_search: openai.tools.webSearch({
					searchContextSize: "high",
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
				model: `gateway:${CHATGPT_HEADLINES_MODEL}`,
				tool: "openai.web_search",
			},
		};
	},
};

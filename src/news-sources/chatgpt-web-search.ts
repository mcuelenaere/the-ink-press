import { openai } from "@ai-sdk/openai";
import { gateway, Output, stepCountIs, streamText, zodSchema } from "ai";
import { z } from "zod";

import { logLlmStream } from "../ai-utils";
import { getReporter } from "../reporting";
import type { NewsSourceModule, NewsSourceOptions } from "./types";

const HeadlineSchema = z.object({
	title: z.string().min(1),
	url: z.string().min(1),
	source: z.string().min(1),
});

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

		report(`NEWS: streaming start (model=gateway:openai/gpt-5.2)`);
		const result = await streamText({
			model: gateway("openai/gpt-5.2"),
			toolChoice: "required",
			stopWhen: stepCountIs(5),
			tools: {
				web_search: openai.tools.webSearchPreview({
					searchContextSize: "high",
				}),
			},
			output: Output.object({
				schema: zodSchema(HeadlinesSchema),
				name: "DailyHeadlines",
				description: "Top headlines with canonical URLs and source names.",
			}),
			prompt: [
				`You are collecting today's most important headlines for a daily brief.`,
				``,
				`Today is: ${dateLabel}`,
				``,
				`User prompt:`,
				prompt,
				``,
				`Task: Use web search to find today's top headlines that best address the user prompt.`,
				``,
				`Rules:`,
				`- Use the web_search tool to gather sources (dedupe and prefer reputable outlets).`,
				`- Focus on stories from the last 24 hours whenever possible.`,
				`- Return at most ${maxHeadlines} headlines.`,
				`- Each headline MUST include a title, a canonical URL, and a short source name.`,
				``,
				`Return JSON matching the schema exactly.`,
			].join("\n"),
		});

		await logLlmStream(report, result.fullStream, "NEWS");

		const out = await result.output;
		report(`NEWS: done (ms=${Date.now() - startedAt})`);

		return {
			headlines: out.headlines.slice(0, maxHeadlines),
			meta: {
				model: "gateway:openai/gpt-5.2",
				tool: "openai.web_search_preview",
			},
		};
	},
};

import { gateway, Output, streamText, zodSchema } from "ai";
import { z } from "zod";

import { logLlmStream, toOneLineJson } from "./ai-utils";
import type { NewsHeadline } from "./news/types";
import { getReporter, type Reporter } from "./reporting";

const DailyBriefSchema = z.object({
	summary: z.string().min(1),
	concepts: z.array(z.string().min(1)).min(1).max(3),
	captionText: z.string().min(1),
	imagePrompt: z.string().min(1),
});

export type DailyBrief = z.infer<typeof DailyBriefSchema>;

function formatHeadlines(headlines: NewsHeadline[]) {
	return headlines
		.map((headline, index) => {
			return `${index + 1}. ${headline.title} (${headline.source}) - ${headline.url}`;
		})
		.join("\n");
}

function formatHeadlinesSection(label: string, headlines: NewsHeadline[]) {
	if (headlines.length === 0) {
		return `${label}: (none)`;
	}
	return `${label}:\n${formatHeadlines(headlines)}`;
}

export async function generateDailyBrief(options: {
	prompt: string;
	webHeadlines: NewsHeadline[];
	rssHeadlines?: NewsHeadline[];
	dateLabel: string;
	reporter?: Reporter;
}): Promise<DailyBrief> {
	const { prompt, webHeadlines, rssHeadlines = [], dateLabel, reporter } = options;

	if (webHeadlines.length === 0 && rssHeadlines.length === 0) {
		throw new Error("Daily brief requires at least one headline.");
	}

	const report = getReporter(reporter);
	const startedAt = Date.now();

	report(`BRIEF: streaming start (model=gateway:openai/gpt-5.2)`);
	const result = await streamText({
		model: gateway("openai/gpt-5.2"),
		output: Output.object({
			schema: zodSchema(DailyBriefSchema),
			name: "DailyBrief",
			description:
				"Summary, up to 3 visual concepts, caption text, and a painting-style image prompt for today.",
		}),
		prompt: [
			`You are generating a daily brief and an image prompt.`,
			``,
			`Today is: ${dateLabel}`,
			``,
			`User prompt:`,
			prompt,
			``,
			formatHeadlinesSection("Web search headlines", webHeadlines),
			rssHeadlines.length > 0
				? formatHeadlinesSection("RSS feed headlines", rssHeadlines)
				: "",
			``,
			`Rules:`,
			`- Use ONLY the provided headlines; do not add new stories.`,
			`- Use BOTH the web search and RSS headlines if provided.`,
			`- Use the user prompt to decide what to emphasize.`,
			`- Write a concise summary (5-8 sentences).`,
			`- Choose 1-3 short 'concepts' that best represent the day. This is the MAX number of concepts allowed in the image.`,
			`- The image MUST ONLY depict those concepts (no more than 3).`,
			`- Write captionText: a very brief, readable line (max ~10 words) that will be rendered as text in the image.`,
			`  - The captionText MUST include the date (${dateLabel}) in some form.`,
			`- Write an imagePrompt for a single painting (colors allowed).`,
			`  - IMPORTANT: do NOT depict an e-book, e-ink device, screen, frame, UI, newspaper page, or any kind of display showing the image.`,
			`  - IMPORTANT: do NOT depict a poster/mockup of an artwork; just paint the scene itself.`,
			`  - The imagePrompt MUST instruct the model to include the captionText as short in-image text (tasteful, legible).`,
			`  - The imagePrompt MUST include the date (${dateLabel}) explicitly.`,
			``,
			`Return JSON matching the schema exactly.`,
		].join("\n"),
	});

	await logLlmStream(report, result.fullStream, "BRIEF");

	const out = await result.output;
	report(`BRIEF: done (ms=${Date.now() - startedAt})`);
	return out;
}

export async function generateGeminiImage(options: {
	imagePrompt: string;
	captionText?: string;
	reporter?: Reporter;
}): Promise<{
	image?: { file: Uint8Array; mediaType: string };
	rawText: string;
}> {
	const { imagePrompt, captionText, reporter } = options;
	const report = reporter?.info ?? (() => {});
	const startedAt = Date.now();

	report(
		`IMAGE: streaming start (model=gateway:google/gemini-3-pro-image-preview)`,
	);
	const result = await streamText({
		model: gateway("google/gemini-3-pro-image-preview"),
		maxRetries: 2,
		prompt: [
			`Generate exactly one image based on this prompt.`,
			`Do not return any additional text unless necessary.`,
			captionText
				? `Ensure the image includes this exact short text (legible): ${captionText}`
				: "",
			``,
			imagePrompt,
		].join("\n"),
	});

	for await (const part of result.fullStream) {
		if (part.type === "finish") {
			report(`IMAGE: stream finish (finishReason=${part.finishReason})`);
		}
	}

	const files = await result.files;
	const imageFile = files.find((f) => f.mediaType.startsWith("image/"));
	report(
		`IMAGE: done (ms=${Date.now() - startedAt}, files=${files.length}, mediaTypes=${toOneLineJson(files.map((f) => f.mediaType))})`,
	);

	return {
		image: imageFile
			? { file: imageFile.uint8Array, mediaType: imageFile.mediaType }
			: undefined,
		rawText: await result.text,
	};
}

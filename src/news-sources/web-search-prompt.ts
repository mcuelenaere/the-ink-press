import { z } from "zod";

export const HeadlineSchema = z.object({
	title: z.string().min(1),
	url: z.string().min(1),
	source: z.string().min(1),
});

export function buildWebSearchPrompt(options: {
	dateLabel: string;
	prompt: string;
	maxHeadlines: number;
}) {
	const { dateLabel, prompt, maxHeadlines } = options;

	return [
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
		`- Use the web search tool to gather sources (dedupe and prefer reputable outlets).`,
		`- Focus on stories from the last 24 hours whenever possible.`,
		`- Return at most ${maxHeadlines} headlines.`,
		`- Each headline MUST include a title, a canonical URL, and a short source name.`,
		``,
		`Return JSON matching the schema exactly.`,
	].join("\n");
}

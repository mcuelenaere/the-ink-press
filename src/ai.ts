import { generateText, gateway, stepCountIs, Output, zodSchema } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { getRequiredEnv } from './utils.js';

const NewsResultSchema = z.object({
    headlines: z
        .array(
            z.object({
                title: z.string().min(1),
                url: z.string().min(1),
                source: z.string().min(1),
            }),
        )
        .min(1),
    summary: z.string().min(1),
    imagePrompt: z.string().min(1),
});

export type NewsResult = z.infer<typeof NewsResultSchema>;

export async function fetchDailyNews(options: { query: string; maxHeadlines: number }): Promise<NewsResult> {
    const { query, maxHeadlines } = options;

    const result = await generateText({
        model: gateway('openai/gpt-5.2'),
        toolChoice: 'required',
        stopWhen: stepCountIs(5),
        tools: {
            web_search: openai.tools.webSearchPreview({ searchContextSize: 'high' }),
        },
        output: Output.object({
            schema: zodSchema(NewsResultSchema),
            name: 'DailyBrief',
            description: 'Headlines, summary, and an image prompt for an e-ink display.',
        }),
        prompt: [
            `You are generating a daily brief and an image prompt for an e-ink display.`,
            ``,
            `Task: Use web search to find today's most important headlines for this query:`,
            `${query}`,
            ``,
            `Rules:`,
            `- Use the web_search tool to gather sources (dedupe and prefer reputable outlets).`,
            `- Return at most ${maxHeadlines} headlines.`,
            `- Each headline MUST include a title, a canonical URL, and a short source name.`,
            `- Write a concise summary (5-8 sentences).`,
            `- Write an imagePrompt that is visually descriptive and safe for general audiences.`,
            `- The imagePrompt should work well for a monochrome e-ink style illustration.`,
            ``,
            `Return JSON matching the schema exactly.`,
        ].join('\n'),
    });

    return result.output;
}

export async function generateGeminiImage(options: { imagePrompt: string }): Promise<{
    image?: { file: Uint8Array; mediaType: string };
    rawText: string;
}> {
    // AI Gateway uses AI_GATEWAY_API_KEY for API-key auth.
    getRequiredEnv('AI_GATEWAY_API_KEY');

    const { imagePrompt } = options;

    const result = await generateText({
        model: gateway('google/gemini-3-pro-image-preview'),
        maxRetries: 2,
        prompt: [
            `Generate exactly one image based on this prompt.`,
            `Do not return any additional text unless necessary.`,
            ``,
            imagePrompt,
        ].join('\n'),
    });

    const imageFile = result.files.find((f) => f.mediaType.startsWith('image/'));
    return {
        image: imageFile ? { file: imageFile.uint8Array, mediaType: imageFile.mediaType } : undefined,
        rawText: result.text,
    };
}



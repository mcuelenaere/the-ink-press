import { streamText, gateway, stepCountIs, Output, zodSchema } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { getRequiredEnv } from './utils';

export type Reporter = {
    info: (message: string) => void;
};

function toOneLineJson(value: unknown, maxLen = 240) {
    try {
        const s = JSON.stringify(value);
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen - 3) + '...';
    } catch {
        return '[unserializable]';
    }
}

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

export async function fetchDailyNews(options: {
    query: string;
    maxHeadlines: number;
    reporter?: Reporter;
}): Promise<NewsResult> {
    const { query, maxHeadlines, reporter } = options;
    const report = reporter?.info ?? (() => { });
    const startedAt = Date.now();
    let step = 0;

    report(`LLM: streaming start (model=gateway:openai/gpt-5.2)`);
    const result = await streamText({
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

    for await (const part of result.fullStream) {
        // We intentionally log only high-signal events.
        switch (part.type) {
            case 'start-step':
                step += 1;
                report(`LLM: step ${step} start`);
                break;
            case 'tool-call':
                report(`LLM: toolCall ${part.toolName} input=${toOneLineJson(part.input)}`);
                break;
            case 'tool-input-delta':
                if (part.delta.trim()) {
                    report(`LLM: toolInputΔ=${toOneLineJson(part.delta, 160)}`);
                }
                break;
            case 'tool-result':
                report(
                    `LLM: toolResult ${part.toolName} preliminary=${Boolean(part.preliminary)} output=${toOneLineJson(part.output, 200)}`,
                );
                break;
            case 'reasoning-delta':
                // Keep reasoning updates short; they can be very chatty.
                if (part.text.trim()) {
                    report(`LLM: reasoningΔ=${toOneLineJson(part.text, 160)}`);
                }
                break;
            case 'finish-step':
                report(`LLM: step ${step} finish (finishReason=${part.finishReason})`);
                break;
            case 'finish':
                report(`LLM: stream finish (finishReason=${part.finishReason})`);
                break;
            default:
                break;
        }
    }

    const out = await result.output;
    report(`LLM: done (ms=${Date.now() - startedAt})`);
    return out;
}

export async function generateGeminiImage(options: {
    imagePrompt: string;
    reporter?: Reporter;
}): Promise<{
    image?: { file: Uint8Array; mediaType: string };
    rawText: string;
}> {
    // AI Gateway uses AI_GATEWAY_API_KEY for API-key auth.
    getRequiredEnv('AI_GATEWAY_API_KEY');

    const { imagePrompt, reporter } = options;
    const report = reporter?.info ?? (() => { });
    const startedAt = Date.now();

    report(`IMAGE: streaming start (model=gateway:google/gemini-3-pro-image-preview)`);
    const result = await streamText({
        model: gateway('google/gemini-3-pro-image-preview'),
        maxRetries: 2,
        prompt: [
            `Generate exactly one image based on this prompt.`,
            `Do not return any additional text unless necessary.`,
            ``,
            imagePrompt,
        ].join('\n'),
    });

    for await (const part of result.fullStream) {
        if (part.type === 'finish') {
            report(`IMAGE: stream finish (finishReason=${part.finishReason})`);
        }
    }

    const files = await result.files;
    const imageFile = files.find((f) => f.mediaType.startsWith('image/'));
    report(
        `IMAGE: done (ms=${Date.now() - startedAt}, files=${files.length}, mediaTypes=${toOneLineJson(files.map((f) => f.mediaType))})`,
    );

    return {
        image: imageFile ? { file: imageFile.uint8Array, mediaType: imageFile.mediaType } : undefined,
        rawText: (await result.text),
    };
}



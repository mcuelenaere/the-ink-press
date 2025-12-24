import { streamText, gateway, stepCountIs, Output, zodSchema } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

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
    dateLabel: z.string().min(1),
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
    concepts: z.array(z.string().min(1)).min(1).max(3),
    captionText: z.string().min(1),
    imagePrompt: z.string().min(1),
});

export type NewsResult = z.infer<typeof NewsResultSchema>;

export async function fetchDailyNews(options: {
    query: string;
    maxHeadlines: number;
    dateLabel: string;
    reporter?: Reporter;
}): Promise<NewsResult> {
    const { query, maxHeadlines, dateLabel, reporter } = options;
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
            description:
                'Headlines, summary, up to 3 visual concepts, caption text, and a painting-style image prompt for today.',
        }),
        prompt: [
            `You are generating a daily brief and an image prompt.`,
            ``,
            `Today is: ${dateLabel}`,
            ``,
            `Task: Use web search to find today's most important headlines for this query:`,
            `${query}`,
            ``,
            `Rules:`,
            `- Use the web_search tool to gather sources (dedupe and prefer reputable outlets).`,
            `- Return at most ${maxHeadlines} headlines.`,
            `- Each headline MUST include a title, a canonical URL, and a short source name.`,
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
    captionText?: string;
    reporter?: Reporter;
}): Promise<{
    image?: { file: Uint8Array; mediaType: string };
    rawText: string;
}> {
    const { imagePrompt, captionText, reporter } = options;
    const report = reporter?.info ?? (() => { });
    const startedAt = Date.now();

    report(`IMAGE: streaming start (model=gateway:google/gemini-3-pro-image-preview)`);
    const result = await streamText({
        model: gateway('google/gemini-3-pro-image-preview'),
        maxRetries: 2,
        prompt: [
            `Generate exactly one image based on this prompt.`,
            `Do not return any additional text unless necessary.`,
            captionText ? `Ensure the image includes this exact short text (legible): ${captionText}` : '',
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



import { generateDailyBrief } from "./ai";
import type { NewsHeadline } from "./news/types";
import { getNewsSourceModule } from "./news-sources";
import type { NewsSourceId, NewsSourceResult } from "./news-sources/types";
import type { Reporter } from "./reporting";

export type NewsSourceConfig = {
	prompt: string;
	rssFeeds?: string[];
};

type SourceInfo = {
	id: NewsSourceId;
	label: string;
	meta?: NewsSourceResult["meta"];
};

export type NewsResult = {
	dateLabel: string;
	prompt: string;
	headlines: NewsHeadline[];
	chatgptHeadlines: NewsHeadline[];
	geminiHeadlines: NewsHeadline[];
	rssHeadlines: NewsHeadline[];
	summary: string;
	concepts: string[];
	captionText: string;
	imagePrompt: string;
	sources: {
		chatgptWebSearch: SourceInfo;
		geminiWebSearch: SourceInfo;
		rssFeeds?: SourceInfo;
	};
};

export async function fetchDailyNews(options: {
	source: NewsSourceConfig;
	maxHeadlines: number;
	dateLabel: string;
	reporter?: Reporter;
}): Promise<NewsResult> {
	const { source, maxHeadlines, dateLabel, reporter } = options;
	const chatgptModule = getNewsSourceModule("chatgpt-web-search");
	const geminiModule = getNewsSourceModule("gemini-web-search");
	const rssFeedsModule = getNewsSourceModule("rss-feeds");

	const rssFeeds = source.rssFeeds?.length ? source.rssFeeds : undefined;

	const [chatgptResult, geminiResult, rssResult] = await Promise.all([
		chatgptModule.fetchHeadlines({
			prompt: source.prompt,
			dateLabel,
			maxHeadlines,
			reporter,
		}),
		geminiModule.fetchHeadlines({
			prompt: source.prompt,
			dateLabel,
			maxHeadlines,
			reporter,
		}),
		rssFeeds
			? rssFeedsModule.fetchHeadlines({
					prompt: source.prompt,
					dateLabel,
					maxHeadlines,
					rssFeeds,
					reporter,
				})
			: Promise.resolve(null),
	]);

	const chatgptHeadlines = chatgptResult.headlines;
	const geminiHeadlines = geminiResult.headlines;
	const rssHeadlines = rssResult?.headlines ?? [];

	const headlines = dedupeHeadlines(
		chatgptHeadlines,
		geminiHeadlines,
		rssHeadlines,
	);

	if (headlines.length === 0) {
		throw new Error("No headlines were returned from web search or RSS feeds.");
	}

	const brief = await generateDailyBrief({
		prompt: source.prompt,
		chatgptHeadlines,
		geminiHeadlines,
		rssHeadlines,
		dateLabel,
		reporter,
	});

	return {
		dateLabel,
		prompt: source.prompt,
		headlines,
		chatgptHeadlines,
		geminiHeadlines,
		rssHeadlines,
		...brief,
		sources: {
			chatgptWebSearch: {
				id: chatgptModule.id,
				label: chatgptModule.displayName,
				meta: chatgptResult.meta,
			},
			geminiWebSearch: {
				id: geminiModule.id,
				label: geminiModule.displayName,
				meta: geminiResult.meta,
			},
			rssFeeds: rssResult
				? {
						id: rssFeedsModule.id,
						label: rssFeedsModule.displayName,
						meta: rssResult.meta,
					}
				: undefined,
		},
	};
}

function dedupeHeadlines(
	...groups: Array<NewsHeadline[] | undefined>
): NewsHeadline[] {
	const seen = new Set<string>();
	const combined: NewsHeadline[] = [];

	for (const group of groups) {
		if (!group) continue;
		for (const headline of group) {
			const url = headline.url.trim();
			if (!url || seen.has(url)) continue;
			seen.add(url);
			combined.push(headline);
		}
	}

	return combined;
}

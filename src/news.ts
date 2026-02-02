import { generateDailyBrief } from "./ai";
import { getNewsSourceModule } from "./news-sources";
import type { NewsSourceId } from "./news-sources";
import type { NewsSourceResult } from "./news-sources/types";
import type { NewsHeadline } from "./news/types";
import type { Reporter } from "./reporting";

export type NewsSourceConfig = {
	id: NewsSourceId;
	query: string;
	rssFeeds?: string[];
};

export type NewsResult = {
	dateLabel: string;
	headlines: NewsHeadline[];
	summary: string;
	concepts: string[];
	captionText: string;
	imagePrompt: string;
	source: {
		id: NewsSourceId;
		label: string;
		meta?: NewsSourceResult["meta"];
	};
};

export async function fetchDailyNews(options: {
	source: NewsSourceConfig;
	maxHeadlines: number;
	dateLabel: string;
	reporter?: Reporter;
}): Promise<NewsResult> {
	const { source, maxHeadlines, dateLabel, reporter } = options;
	const module = getNewsSourceModule(source.id);

	const sourceResult = await module.fetchHeadlines({
		query: source.query,
		dateLabel,
		maxHeadlines,
		rssFeeds: source.rssFeeds,
		reporter,
	});

	if (sourceResult.headlines.length === 0) {
		throw new Error(`News source "${module.id}" returned no headlines.`);
	}

	const brief = await generateDailyBrief({
		headlines: sourceResult.headlines,
		dateLabel,
		reporter,
	});

	return {
		dateLabel,
		headlines: sourceResult.headlines,
		...brief,
		source: {
			id: module.id,
			label: module.displayName,
			meta: sourceResult.meta,
		},
	};
}

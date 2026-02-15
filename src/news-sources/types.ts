import type { NewsHeadline } from "../news/types";
import type { Reporter } from "../reporting";

export type NewsSourceId = "chatgpt-web-search" | "rss-feeds";

export type NewsSourceOptions = {
	prompt: string;
	dateLabel: string;
	maxHeadlines: number;
	rssFeeds?: string[];
	reporter?: Reporter;
};

export type NewsSourceResult = {
	headlines: NewsHeadline[];
	meta?: Record<string, unknown>;
};

export type NewsSourceModule = {
	id: NewsSourceId;
	displayName: string;
	fetchHeadlines: (options: NewsSourceOptions) => Promise<NewsSourceResult>;
};

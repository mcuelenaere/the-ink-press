import { chatgptWebSearchModule } from "./chatgpt-web-search";
import { geminiWebSearchModule } from "./gemini-web-search";
import { rssFeedsModule } from "./rss-feeds";
import type { NewsSourceId, NewsSourceModule } from "./types";

const NEWS_SOURCE_IDS = [
	"chatgpt-web-search",
	"gemini-web-search",
	"rss-feeds",
] as const satisfies NewsSourceId[];

const NEWS_SOURCE_MODULES: Record<NewsSourceId, NewsSourceModule> = {
	"chatgpt-web-search": chatgptWebSearchModule,
	"gemini-web-search": geminiWebSearchModule,
	"rss-feeds": rssFeedsModule,
};

function isNewsSourceId(value: string): value is NewsSourceId {
	return (NEWS_SOURCE_IDS as readonly string[]).includes(value);
}

function getNewsSourceModule(id: NewsSourceId): NewsSourceModule {
	return NEWS_SOURCE_MODULES[id];
}

export type {
	NewsSourceId,
	NewsSourceModule,
	NewsSourceOptions,
	NewsSourceResult,
} from "./types";
export {
	getNewsSourceModule,
	isNewsSourceId,
	NEWS_SOURCE_IDS,
	NEWS_SOURCE_MODULES,
};

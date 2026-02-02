import { chatgptWebSearchModule } from "./chatgpt-web-search";
import { rssFeedsModule } from "./rss-feeds";
import type { NewsSourceId, NewsSourceModule } from "./types";

const NEWS_SOURCE_IDS = [
	"chatgpt-web-search",
	"rss-feeds",
] as const satisfies NewsSourceId[];

const NEWS_SOURCE_MODULES: Record<NewsSourceId, NewsSourceModule> = {
	"chatgpt-web-search": chatgptWebSearchModule,
	"rss-feeds": rssFeedsModule,
};

function isNewsSourceId(value: string): value is NewsSourceId {
	return (NEWS_SOURCE_IDS as readonly string[]).includes(value);
}

function getNewsSourceModule(id: NewsSourceId): NewsSourceModule {
	return NEWS_SOURCE_MODULES[id];
}

export {
	NEWS_SOURCE_IDS,
	NEWS_SOURCE_MODULES,
	getNewsSourceModule,
	isNewsSourceId,
};
export type {
	NewsSourceId,
	NewsSourceModule,
	NewsSourceOptions,
	NewsSourceResult,
} from "./types";

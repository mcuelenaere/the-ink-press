import { XMLParser } from "fast-xml-parser";
import type { NewsHeadline } from "../news/types";
import { getReporter } from "../reporting";
import type { NewsSourceModule, NewsSourceOptions } from "./types";

type FeedItem = {
	title: string;
	url: string;
	source: string;
	publishedAt?: number;
};

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	textNodeName: "#text",
	trimValues: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function extractText(value: unknown): string | null {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const candidates = [
			record["#text"],
			record["#cdata"],
			record["@_href"],
			record["@_url"],
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim()) {
				return candidate.trim();
			}
		}
	}

	return null;
}

function extractAtomLink(value: unknown): string | null {
	const links = toArray(value);
	for (const link of links) {
		if (typeof link === "string" && link.trim()) {
			return link.trim();
		}
		if (link && typeof link === "object") {
			const record = link as Record<string, unknown>;
			const rel = typeof record["@_rel"] === "string" ? record["@_rel"] : "";
			const href = typeof record["@_href"] === "string" ? record["@_href"] : "";
			if (href && (!rel || rel === "alternate")) {
				return href.trim();
			}
		}
	}
	return null;
}

function parseDate(value: unknown): number | undefined {
	const text = extractText(value);
	if (!text) return undefined;
	const parsed = Date.parse(text);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function buildSourceLabel(feedTitle: string | null, feedUrl: string): string {
	const trimmedTitle = feedTitle?.trim();
	if (trimmedTitle) return trimmedTitle;
	try {
		return new URL(feedUrl).hostname;
	} catch {
		return "RSS";
	}
}

function collectRssItems(
	feedUrl: string,
	parsed: Record<string, unknown>,
): FeedItem[] {
	const rss = parsed.rss as Record<string, unknown> | undefined;
	const channel = rss?.channel as Record<string, unknown> | undefined;
	if (!channel) return [];

	const feedTitle = extractText(channel.title);
	const sourceLabel = buildSourceLabel(feedTitle, feedUrl);
	const items = toArray(channel.item as unknown);

	return items
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const record = item as Record<string, unknown>;
			const title = extractText(record.title);
			const url = extractText(record.link) ?? extractText(record.guid);
			if (!title || !url) return null;
			const publishedAt =
				parseDate(record.pubDate) ??
				parseDate(record["dc:date"]) ??
				parseDate(record["atom:updated"]);
			const base: FeedItem = { title, url, source: sourceLabel };
			return publishedAt !== undefined ? { ...base, publishedAt } : base;
		})
		.filter((item): item is FeedItem => Boolean(item));
}

function collectAtomItems(
	feedUrl: string,
	parsed: Record<string, unknown>,
): FeedItem[] {
	const feed = parsed.feed as Record<string, unknown> | undefined;
	if (!feed) return [];

	const feedTitle = extractText(feed.title);
	const sourceLabel = buildSourceLabel(feedTitle, feedUrl);
	const entries = toArray(feed.entry as unknown);

	return entries
		.map((entry) => {
			if (!entry || typeof entry !== "object") return null;
			const record = entry as Record<string, unknown>;
			const title = extractText(record.title);
			const url = extractAtomLink(record.link);
			if (!title || !url) return null;
			const publishedAt =
				parseDate(record.updated) ?? parseDate(record.published) ?? undefined;
			const base: FeedItem = { title, url, source: sourceLabel };
			return publishedAt !== undefined ? { ...base, publishedAt } : base;
		})
		.filter((item): item is FeedItem => Boolean(item));
}

function dedupeAndLimit(
	items: FeedItem[],
	maxHeadlines: number,
): NewsHeadline[] {
	const sorted = [...items].sort((a, b) => {
		return (b.publishedAt ?? 0) - (a.publishedAt ?? 0);
	});

	const seen = new Set<string>();
	const headlines: NewsHeadline[] = [];

	for (const item of sorted) {
		const url = item.url.trim();
		if (!url || seen.has(url)) continue;
		seen.add(url);
		headlines.push({ title: item.title, url, source: item.source });
		if (headlines.length >= maxHeadlines) break;
	}

	return headlines;
}

export const rssFeedsModule: NewsSourceModule = {
	id: "rss-feeds",
	displayName: "RSS Feeds",
	async fetchHeadlines(options: NewsSourceOptions) {
		const { rssFeeds, maxHeadlines, reporter } = options;
		const report = getReporter(reporter);

		if (!rssFeeds || rssFeeds.length === 0) {
			throw new Error("RSS feeds source requires at least one feed URL.");
		}

		report(`NEWS: fetching ${rssFeeds.length} RSS feeds`);

		const allItems: FeedItem[] = [];
		const failures: string[] = [];

		for (const feedUrl of rssFeeds) {
			try {
				report(`NEWS: RSS fetch ${feedUrl}`);
				const response = await fetch(feedUrl, {
					headers: {
						"User-Agent": "the-ink-press/0.1 (+https://github.com/)",
					},
				});
				if (!response.ok) {
					throw new Error(`HTTP ${response.status} ${response.statusText}`);
				}
				const xml = await response.text();
				const parsed = parser.parse(xml) as Record<string, unknown>;

				const rssItems = collectRssItems(feedUrl, parsed);
				const atomItems = collectAtomItems(feedUrl, parsed);
				const items = rssItems.length > 0 ? rssItems : atomItems;

				if (items.length === 0) {
					throw new Error("No RSS/Atom items detected.");
				}

				allItems.push(...items);
				report(`NEWS: RSS parsed ${items.length} items (${feedUrl})`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`${feedUrl} (${message})`);
				report(`NEWS: RSS failed ${feedUrl} (${message})`);
			}
		}

		if (allItems.length === 0) {
			const detail = failures.length ? ` Failures: ${failures.join("; ")}` : "";
			throw new Error(`RSS feeds returned no items.${detail}`);
		}

		const headlines = dedupeAndLimit(allItems, maxHeadlines);

		if (headlines.length === 0) {
			throw new Error("RSS feeds returned no usable headlines.");
		}

		return {
			headlines,
			meta: {
				feedCount: rssFeeds.length,
				itemCount: allItems.length,
				failedFeeds: failures.length,
			},
		};
	},
};

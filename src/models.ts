export const HEADLINES_MODEL = "openai/gpt-5.6-sol";
export const CHATGPT_HEADLINES_MODEL = "openai/gpt-5.6-terra";
export const GEMINI_HEADLINES_MODEL = "google/gemini-3.7-flash";
export const IMAGE_MODEL = "google/gemini-3.1-flash-image";

/** OpenAI Flex: ~half price, higher latency. Gateway bills the tier actually served. */
export const OPENAI_PROVIDER_OPTIONS = {
	openai: { serviceTier: "flex" as const },
};

/**
 * Gemini Flex / Flex PayGo: cheaper, higher latency.
 * `gateway.serviceTier` covers whichever backend serves the model;
 * `google` covers Gemini API (`serviceTier`) and Vertex (`sharedRequestType`).
 */
export const GEMINI_PROVIDER_OPTIONS = {
	gateway: { serviceTier: "flex" as const },
	google: {
		serviceTier: "flex" as const,
		sharedRequestType: "flex" as const,
	},
};

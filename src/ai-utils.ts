type StreamPart = {
	type: string;
	[key: string]: unknown;
};

export function toOneLineJson(value: unknown, maxLen = 240) {
	try {
		const s = JSON.stringify(value);
		if (s.length <= maxLen) return s;
		return `${s.slice(0, maxLen - 3)}...`;
	} catch {
		return "[unserializable]";
	}
}

export async function logLlmStream(
	report: (message: string) => void,
	stream: AsyncIterable<StreamPart>,
	prefix: string,
) {
	let step = 0;

	for await (const part of stream) {
		switch (part.type) {
			case "start-step":
				step += 1;
				report(`${prefix}: step ${step} start`);
				break;
			case "tool-call":
				report(
					`${prefix}: toolCall ${String(part.toolName)} input=${toOneLineJson(part.input)}`,
				);
				break;
			case "tool-input-delta": {
				const delta = String(part.delta ?? "");
				if (delta.trim()) {
					report(`${prefix}: toolInputΔ=${toOneLineJson(delta, 160)}`);
				}
				break;
			}
			case "tool-result":
				report(
					`${prefix}: toolResult ${String(part.toolName)} preliminary=${Boolean(part.preliminary)} output=${toOneLineJson(part.output, 200)}`,
				);
				break;
			case "reasoning-delta": {
				const text = String(part.text ?? "");
				if (text.trim()) {
					report(`${prefix}: reasoningΔ=${toOneLineJson(text, 160)}`);
				}
				break;
			}
			case "finish-step":
				report(
					`${prefix}: step ${step} finish (finishReason=${String(part.finishReason)})`,
				);
				break;
			case "finish":
				report(`${prefix}: stream finish (finishReason=${String(part.finishReason)})`);
				break;
			default:
				break;
		}
	}
}

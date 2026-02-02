export type Reporter = {
	info: (message: string) => void;
};

export function getReporter(reporter?: Reporter) {
	return reporter?.info ?? (() => {});
}

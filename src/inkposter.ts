import crypto from "node:crypto";
import fs from "node:fs";
import {
	compressJpeg,
	Orientation,
	ResizeFit,
	Transformer,
} from "@napi-rs/image";
import { getRequiredEnv, logStatus, sleep } from "./utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FrameModel = "Frame_13_3" | "Frame_28_5" | "Frame_31_5";

export type FrameResolution = {
	width: number;
	height: number;
};

export type RotationAngle = 0 | 90 | 180 | 270;

export type InkposterConfig = {
	email: string;
	password: string;
	frameUuid: string;
	frameModel: FrameModel;
	rotate: RotationAngle;
};

export type ConvertResponse = {
	queueId: string;
};

export type IsConvertedResponse = {
	status: string;
	message?: string;
	item?: string | null;
};

export type PollResult = {
	queueId: string;
	attempts: number;
	elapsedMs: number;
	finalResponse: IsConvertedResponse;
};

export type ResizeResult = {
	resizedBytes: Uint8Array;
	mediaType: string;
	originalWidth: number;
	originalHeight: number;
	targetWidth: number;
	targetHeight: number;
};

export type UploadResult = {
	convertResponse: ConvertResponse;
	poll: PollResult;
	resize: ResizeResult;
};

type PersistedState = {
	deviceId: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

type AuthResponse = {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants (reverse-engineered defaults)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.inkposter.com";

// Signing credentials (from Android APK, see reverse-engineer/API_AUTH.md)
const CLIENT_ID = "android";
const CLIENT_SECRET = "t5L1zS3D5CAZOE66afhWy8oPVEkZaB5p";

const DEFAULT_HEADERS: Record<string, string> = {
	"x-header-country": "BE",
	"x-header-language": "en",
	"x-client-id": CLIENT_ID,
	"x-header-clientid": CLIENT_ID,
};

const CONVERT_EXTRA_HEADERS = {
	"Upload-Draft-Interop-Version": "6",
	"Upload-Complete": "?1",
};

// Polling defaults
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

// Refresh token 1 hour before expiry
const REFRESH_BUFFER_SECS = 60 * 60;

// Frame resolutions (from Inkposter product specs)
const FRAME_RESOLUTIONS: Record<FrameModel, FrameResolution> = {
	Frame_13_3: { width: 1200, height: 1600 }, // 13.3" portrait
	Frame_28_5: { width: 2160, height: 3060 }, // 28.5" portrait
	Frame_31_5: { width: 2560, height: 1440 }, // 31.5" landscape
};

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

function parseFrameModel(value: string): FrameModel {
	const normalized = value.trim();
	if (normalized === "Frame_13_3" || normalized === "13.3") return "Frame_13_3";
	if (normalized === "Frame_28_5" || normalized === "28.5") return "Frame_28_5";
	if (normalized === "Frame_31_5" || normalized === "31.5") return "Frame_31_5";
	throw new Error(
		`Invalid INKPOSTER_FRAME_MODEL: "${value}". ` +
			`Valid values: Frame_13_3, Frame_28_5, Frame_31_5 (or 13.3, 28.5, 31.5)`,
	);
}

function parseRotation(value: string | undefined): RotationAngle {
	if (!value) return 0;
	const num = parseInt(value.trim(), 10);
	if (num === 0 || num === 90 || num === 180 || num === 270) return num;
	throw new Error(
		`Invalid INKPOSTER_ROTATE: "${value}". Valid values: 0, 90, 180, 270`,
	);
}

export function getInkposterConfig(): InkposterConfig {
	return {
		email: getRequiredEnv("INKPOSTER_EMAIL"),
		password: getRequiredEnv("INKPOSTER_PASSWORD"),
		frameUuid: getRequiredEnv("INKPOSTER_FRAME_UUID"),
		frameModel: parseFrameModel(getRequiredEnv("INKPOSTER_FRAME_MODEL")),
		rotate: parseRotation(process.env.INKPOSTER_ROTATE),
	};
}

export function getFrameResolution(model: FrameModel): FrameResolution {
	return FRAME_RESOLUTIONS[model];
}

// ─────────────────────────────────────────────────────────────────────────────
// Request signing (reverse-engineered from Android APK)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 signature required by Inkposter auth endpoints.
 *
 *   message  = CLIENT_ID + timestamp
 *   signature = HMAC-SHA256(CLIENT_SECRET, message)   → lowercase hex
 */
function computeAuthSignature(timestamp: number): string {
	const message = `${CLIENT_ID}${timestamp}`;
	return crypto
		.createHmac("sha256", CLIENT_SECRET)
		.update(message)
		.digest("hex");
}

/** Append `?timestamp=…&signature=…` to a URL. */
function signedUrl(baseUrl: string): string {
	const timestamp = Date.now();
	const signature = computeAuthSignature(timestamp);
	return `${baseUrl}?timestamp=${timestamp}&signature=${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE_FILE = ".inkposter-tokens.json";

function stateFilePath(): string {
	return process.env.INKPOSTER_TOKEN_FILE ?? DEFAULT_STATE_FILE;
}

function loadPersistedState(): PersistedState | null {
	try {
		const raw = fs.readFileSync(stateFilePath(), "utf8");
		const data: unknown = JSON.parse(raw);
		if (
			data !== null &&
			typeof data === "object" &&
			"deviceId" in data &&
			"accessToken" in data &&
			"refreshToken" in data &&
			"expiresAt" in data &&
			typeof (data as PersistedState).deviceId === "string" &&
			typeof (data as PersistedState).accessToken === "string" &&
			typeof (data as PersistedState).refreshToken === "string" &&
			typeof (data as PersistedState).expiresAt === "number"
		) {
			return data as PersistedState;
		}
	} catch {
		// File missing or corrupt — will login fresh.
	}
	return null;
}

function savePersistedState(state: PersistedState): void {
	try {
		fs.writeFileSync(
			stateFilePath(),
			`${JSON.stringify(state, null, 2)}\n`,
			"utf8",
		);
		logStatus(`INKPOSTER: persisted auth state to ${stateFilePath()}`);
	} catch (err) {
		logStatus(
			`INKPOSTER: warning: could not persist state to ${stateFilePath()}: ${err}`,
		);
	}
}

/**
 * Manages the full Inkposter OAuth lifecycle:
 *
 *  1. **Login** with email + password (signed request).
 *  2. **Proactive refresh** before token expiry.
 *  3. **Reactive refresh** on 401, with re-login as fallback.
 *  4. **Persistence** of device ID + tokens to a JSON file so they survive
 *     process restarts.
 *
 * Use `InkposterAuth.create(config)` to obtain an authenticated instance.
 */
export class InkposterAuth {
	readonly config: InkposterConfig;
	private deviceId: string;
	private accessToken: string;
	private refreshToken: string;
	private expiresAt: number;
	private refreshPromise: Promise<void> | null = null;

	private constructor(
		config: InkposterConfig,
		deviceId: string,
		accessToken: string,
		refreshToken: string,
		expiresAt: number,
	) {
		this.config = config;
		this.deviceId = deviceId;
		this.accessToken = accessToken;
		this.refreshToken = refreshToken;
		this.expiresAt = expiresAt;
	}

	/**
	 * Create an authenticated `InkposterAuth`.
	 *
	 * Loads persisted state when available and still valid, otherwise performs
	 * a fresh login. Proactively refreshes tokens that are close to expiry.
	 */
	static async create(config: InkposterConfig): Promise<InkposterAuth> {
		const saved = loadPersistedState();
		const nowSecs = Date.now() / 1000;

		if (saved && saved.expiresAt > nowSecs) {
			logStatus(
				`INKPOSTER: loaded persisted auth (expires ${new Date(saved.expiresAt * 1000).toISOString()})`,
			);
			const auth = new InkposterAuth(
				config,
				saved.deviceId,
				saved.accessToken,
				saved.refreshToken,
				saved.expiresAt,
			);

			if (auth.isTokenExpiringSoon()) {
				logStatus("INKPOSTER: token expiring soon, proactively refreshing…");
				try {
					await auth.doRefreshOrLogin();
				} catch (err) {
					logStatus(
						`INKPOSTER: proactive refresh failed (${err}), logging in fresh`,
					);
					await auth.doLogin();
				}
			}

			return auth;
		}

		// No valid persisted state — login fresh.
		const deviceId = saved?.deviceId ?? crypto.randomUUID();
		logStatus(
			`INKPOSTER: no valid persisted auth, logging in (device=${deviceId})`,
		);
		const auth = new InkposterAuth(config, deviceId, "", "", 0);
		await auth.doLogin();
		return auth;
	}

	// -- public API ------------------------------------------------------------

	/** Build request headers using the current access token. */
	buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
		return {
			...DEFAULT_HEADERS,
			...extra,
			Authorization: `Bearer ${this.accessToken}`,
			"x-header-deviceid": this.deviceId,
		};
	}

	/**
	 * Perform a `fetch` with automatic token management:
	 *
	 *  - Proactively refreshes if the token is close to expiry.
	 *  - On 401: refreshes, or re-logs in if refresh fails, then retries.
	 *
	 * `buildInit` is a callback so that headers can be rebuilt with the fresh
	 * token on the retry attempt.
	 */
	async fetchWithAuth(
		url: string,
		buildInit: () => RequestInit,
	): Promise<Response> {
		// Proactive refresh before the request if we're close to expiry
		if (this.isTokenExpiringSoon()) {
			logStatus("INKPOSTER: token expiring soon, refreshing before request…");
			await this.ensureValidToken();
		}

		let res = await fetch(url, buildInit());

		if (res.status === 401) {
			logStatus(
				`INKPOSTER: received 401 from ${new URL(url).pathname}, refreshing…`,
			);
			await this.ensureValidToken();
			logStatus("INKPOSTER: retrying request with fresh token…");
			res = await fetch(url, buildInit());
		}

		return res;
	}

	// -- internals -------------------------------------------------------------

	private isTokenExpiringSoon(): boolean {
		return Date.now() / 1000 >= this.expiresAt - REFRESH_BUFFER_SECS;
	}

	/**
	 * Ensure we have a valid token. Try refresh first; fall back to re-login.
	 * Concurrent calls are coalesced.
	 */
	private async ensureValidToken(): Promise<void> {
		if (!this.refreshPromise) {
			this.refreshPromise = this.doRefreshOrLogin().finally(() => {
				this.refreshPromise = null;
			});
		}
		return this.refreshPromise;
	}

	private async doRefreshOrLogin(): Promise<void> {
		try {
			await this.doRefresh();
		} catch (err) {
			logStatus(`INKPOSTER: refresh failed (${err}), falling back to login…`);
			await this.doLogin();
		}
	}

	private async doLogin(): Promise<void> {
		logStatus("INKPOSTER: logging in…");

		const url = signedUrl(`${API_BASE}/api/v1/auth/login`);
		const res = await fetch(url, {
			method: "POST",
			headers: {
				...DEFAULT_HEADERS,
				"Content-Type": "application/json",
				"x-header-deviceid": this.deviceId,
			},
			body: JSON.stringify({
				email: this.config.email,
				password: this.config.password,
				deviceId: this.deviceId,
			}),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Inkposter login failed: ${res.status} ${res.statusText} - ${text}`,
			);
		}

		const json = (await res.json()) as AuthResponse;
		this.applyAuthResponse(json);
		logStatus(
			`INKPOSTER: login successful (expires ${new Date(this.expiresAt * 1000).toISOString()})`,
		);
	}

	private async doRefresh(): Promise<void> {
		logStatus("INKPOSTER: refreshing access token…");

		const url = `${API_BASE}/api/v1/auth/refresh-token`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				...DEFAULT_HEADERS,
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.accessToken}`,
				"x-header-deviceid": this.deviceId,
			},
			body: JSON.stringify({ deviceId: this.deviceId }),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Inkposter refresh failed: ${res.status} ${res.statusText} - ${text}`,
			);
		}

		const json = (await res.json()) as AuthResponse;
		this.applyAuthResponse(json);
		logStatus(
			`INKPOSTER: token refreshed (expires ${new Date(this.expiresAt * 1000).toISOString()})`,
		);
	}

	private applyAuthResponse(json: AuthResponse): void {
		this.accessToken = json.accessToken;
		this.refreshToken = json.refreshToken;
		// expiresIn is a Unix timestamp (seconds), not a duration
		this.expiresAt = json.expiresIn;

		savePersistedState({
			deviceId: this.deviceId,
			accessToken: this.accessToken,
			refreshToken: this.refreshToken,
			expiresAt: this.expiresAt,
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function filenameFromMediaType(mediaType: string): string {
	if (mediaType === "image/png") return "userimage.png";
	if (mediaType === "image/webp") return "userimage.webp";
	// Default to jpg for jpeg or unknown
	return "userimage.jpg";
}

function rotationAngleToOrientation(
	angle: RotationAngle,
): Orientation | undefined {
	switch (angle) {
		case 0:
			return undefined; // No rotation
		case 90:
			return Orientation.Rotate90Cw;
		case 180:
			return Orientation.Rotate180;
		case 270:
			return Orientation.Rotate270Cw;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Resizing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resize an image to fit the target frame's resolution.
 * Uses cover fit (fills the frame, cropping if needed) to ensure exact dimensions.
 * Converts to JPEG for optimal compatibility with the Inkposter API.
 *
 * @param imageBytes - The original image bytes
 * @param frameModel - Target frame model (determines resolution)
 * @param rotate - Rotation in degrees (0, 90, 180, 270).
 */
export async function resizeImageForFrame(
	imageBytes: Uint8Array,
	frameModel: FrameModel,
	rotate: RotationAngle = 0,
): Promise<ResizeResult> {
	const resolution = FRAME_RESOLUTIONS[frameModel];

	// Get original image metadata
	const transformer = new Transformer(imageBytes);
	const metadata = await transformer.metadata();
	const originalWidth = metadata.width ?? 0;
	const originalHeight = metadata.height ?? 0;

	const rotateMsg = rotate !== 0 ? `, rotate ${rotate}°` : "";
	logStatus(
		`INKPOSTER: resizing image from ${originalWidth}x${originalHeight} ` +
			`to ${resolution.width}x${resolution.height} for ${frameModel}${rotateMsg}`,
	);

	// Build the @napi-rs/image pipeline:
	// 1. Apply rotation if specified
	// 2. Resize with cover fit
	// 3. Convert to JPEG with mozjpeg compression
	let pipeline = new Transformer(imageBytes);

	// Apply rotation if specified
	const orientation = rotationAngleToOrientation(rotate);
	if (orientation) {
		pipeline = pipeline.rotate(orientation);
	}

	// Resize with cover fit and encode to JPEG
	const jpegBuffer = await pipeline
		.resize({
			width: resolution.width,
			height: resolution.height,
			fit: ResizeFit.Cover,
		})
		.jpeg(100);

	// Apply mozjpeg compression for better file size
	const resizedBuffer = await compressJpeg(jpegBuffer, {
		quality: 95,
		optimizeScans: true,
	});

	logStatus(
		`INKPOSTER: image resized (${resizedBuffer.byteLength} bytes, image/jpeg)`,
	);

	return {
		resizedBytes: new Uint8Array(resizedBuffer),
		mediaType: "image/jpeg",
		originalWidth,
		originalHeight,
		targetWidth: resolution.width,
		targetHeight: resolution.height,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// API: uploadConvert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upload an image to Inkposter for conversion.
 *
 * The multipart body matches the reverse-engineered format:
 * - `frames[]`: frame UUID (Content-Type: application/json)
 * - `file`: image bytes (Content-Type: image/jpeg or similar)
 */
export async function uploadConvert(
	auth: InkposterAuth,
	imageBytes: Uint8Array,
	mediaType: string,
): Promise<ConvertResponse> {
	const url = `${API_BASE}/api/v1/item/convert`;

	// Build multipart form data
	const formData = new FormData();

	// frames[] part: the frame UUID as a simple text form field
	// The Java code uses createFormData("frames[]", str) which is a plain text field
	formData.append("frames[]", auth.config.frameUuid);

	// file part: the image bytes
	const filename = filenameFromMediaType(mediaType);
	const imageBlob = new Blob([imageBytes], { type: mediaType });
	formData.append("file", imageBlob, filename);

	logStatus(
		`INKPOSTER: uploading image (${imageBytes.byteLength} bytes, ${mediaType}) to /api/v1/item/convert`,
	);

	const res = await auth.fetchWithAuth(url, () => ({
		method: "POST",
		headers: auth.buildHeaders(CONVERT_EXTRA_HEADERS),
		body: formData,
	}));

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`Inkposter convert failed: ${res.status} ${res.statusText} - ${text}`,
		);
	}

	const json = (await res.json()) as ConvertResponse;
	logStatus(`INKPOSTER: convert response received (queueId=${json.queueId})`);
	return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// API: pollIsConverted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the is-converted endpoint until status is no longer "pending" or timeout.
 */
export async function pollIsConverted(
	auth: InkposterAuth,
	queueId: string,
): Promise<PollResult> {
	const url = `${API_BASE}/api/v1/item/is-converted`;

	const startedAt = Date.now();
	let attempts = 0;
	let lastResponse: IsConvertedResponse | null = null;

	logStatus(`INKPOSTER: polling conversion status (queueId=${queueId})`);

	while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
		attempts += 1;

		const res = await auth.fetchWithAuth(url, () => ({
			method: "POST",
			headers: {
				...auth.buildHeaders(),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ queueId }),
		}));

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`Inkposter is-converted failed: ${res.status} ${res.statusText} - ${text}`,
			);
		}

		lastResponse = (await res.json()) as IsConvertedResponse;
		logStatus(
			`INKPOSTER: poll attempt ${attempts} - status=${lastResponse.status}, message=${lastResponse.message ?? ""}`,
		);

		if (lastResponse.status !== "pending") {
			break;
		}

		await sleep(POLL_INTERVAL_MS);
	}

	const elapsedMs = Date.now() - startedAt;

	if (!lastResponse) {
		throw new Error("Inkposter poll: no response received");
	}

	if (lastResponse.status === "pending") {
		logStatus(
			`INKPOSTER: poll timed out after ${elapsedMs}ms (${attempts} attempts)`,
		);
	} else {
		logStatus(
			`INKPOSTER: conversion complete (status=${lastResponse.status}, elapsedMs=${elapsedMs})`,
		);
	}

	return {
		queueId,
		attempts,
		elapsedMs,
		finalResponse: lastResponse,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined: uploadAndPoll
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resize an image and upload it to Inkposter, then poll until conversion completes.
 * The image is automatically resized to match the configured frame model's resolution.
 * If INKPOSTER_ROTATE is set, the image is rotated by that amount (0, 90, 180, 270).
 */
export async function uploadAndPoll(
	auth: InkposterAuth,
	imageBytes: Uint8Array,
): Promise<UploadResult> {
	// Resize image to match frame resolution (with optional rotation)
	const resize = await resizeImageForFrame(
		imageBytes,
		auth.config.frameModel,
		auth.config.rotate,
	);

	// Upload resized image
	const convertResponse = await uploadConvert(
		auth,
		resize.resizedBytes,
		resize.mediaType,
	);
	const poll = await pollIsConverted(auth, convertResponse.queueId);

	return { convertResponse, poll, resize };
}

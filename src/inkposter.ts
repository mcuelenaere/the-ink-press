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
	token: string;
	deviceId: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants (reverse-engineered defaults)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://api.inkposter.com";

const DEFAULT_HEADERS = {
	"x-header-country": "BE",
	"x-header-language": "en",
	"x-client-id": "ios",
	"x-header-clientid": "ios",
};

const CONVERT_EXTRA_HEADERS = {
	"Upload-Draft-Interop-Version": "6",
	"Upload-Complete": "?1",
};

// Polling defaults
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

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
		token: getRequiredEnv("INKPOSTER_TOKEN"),
		deviceId: getRequiredEnv("INKPOSTER_DEVICE_ID"),
		frameUuid: getRequiredEnv("INKPOSTER_FRAME_UUID"),
		frameModel: parseFrameModel(getRequiredEnv("INKPOSTER_FRAME_MODEL")),
		rotate: parseRotation(process.env.INKPOSTER_ROTATE),
	};
}

export function getFrameResolution(model: FrameModel): FrameResolution {
	return FRAME_RESOLUTIONS[model];
}

function buildHeaders(
	config: InkposterConfig,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...DEFAULT_HEADERS,
		...extra,
		Authorization: `Bearer ${config.token}`,
		"x-header-deviceid": config.deviceId,
	};
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
	config: InkposterConfig,
	imageBytes: Uint8Array,
	mediaType: string,
): Promise<ConvertResponse> {
	const url = `${API_BASE}/api/v1/item/convert`;

	// Build multipart form data
	const formData = new FormData();

	// frames[] part: the frame UUID as a simple text form field
	// The Java code uses createFormData("frames[]", str) which is a plain text field
	formData.append("frames[]", config.frameUuid);

	// file part: the image bytes
	const filename = filenameFromMediaType(mediaType);
	const imageBlob = new Blob([imageBytes], { type: mediaType });
	formData.append("file", imageBlob, filename);

	const headers = buildHeaders(config, CONVERT_EXTRA_HEADERS);

	logStatus(
		`INKPOSTER: uploading image (${imageBytes.byteLength} bytes, ${mediaType}) to /api/v1/item/convert`,
	);

	const res = await fetch(url, {
		method: "POST",
		headers,
		body: formData,
	});

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
	config: InkposterConfig,
	queueId: string,
): Promise<PollResult> {
	const url = `${API_BASE}/api/v1/item/is-converted`;
	const headers = {
		...buildHeaders(config),
		"Content-Type": "application/json",
	};

	const startedAt = Date.now();
	let attempts = 0;
	let lastResponse: IsConvertedResponse | null = null;

	logStatus(`INKPOSTER: polling conversion status (queueId=${queueId})`);

	while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
		attempts += 1;

		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ queueId }),
		});

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
	config: InkposterConfig,
	imageBytes: Uint8Array,
	mediaType: string,
): Promise<UploadResult> {
	// Resize image to match frame resolution (with optional rotation)
	const resize = await resizeImageForFrame(
		imageBytes,
		config.frameModel,
		config.rotate,
	);

	// Upload resized image
	const convertResponse = await uploadConvert(
		config,
		resize.resizedBytes,
		resize.mediaType,
	);
	const poll = await pollIsConverted(config, convertResponse.queueId);

	return { convertResponse, poll, resize };
}

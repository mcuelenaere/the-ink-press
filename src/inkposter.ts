import { getRequiredEnv, logStatus, sleep } from './utils';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type InkposterConfig = {
    token: string;
    deviceId: string;
    frameUuid: string;
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

export type UploadResult = {
    convertResponse: ConvertResponse;
    poll: PollResult;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants (reverse-engineered defaults)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.inkposter.com';

const DEFAULT_HEADERS = {
    'x-header-country': 'BE',
    'x-header-language': 'en',
    'x-client-id': 'ios',
    'x-header-clientid': 'ios',
};

const CONVERT_EXTRA_HEADERS = {
    'Upload-Draft-Interop-Version': '6',
    'Upload-Complete': '?1',
};

// Polling defaults
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export function getInkposterConfig(): InkposterConfig {
    return {
        token: getRequiredEnv('INKPOSTER_TOKEN'),
        deviceId: getRequiredEnv('INKPOSTER_DEVICE_ID'),
        frameUuid: getRequiredEnv('INKPOSTER_FRAME_UUID'),
    };
}

function buildHeaders(config: InkposterConfig, extra: Record<string, string> = {}): Record<string, string> {
    return {
        ...DEFAULT_HEADERS,
        ...extra,
        Authorization: `Bearer ${config.token}`,
        'x-header-deviceid': config.deviceId,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function filenameFromMediaType(mediaType: string): string {
    if (mediaType === 'image/png') return 'userimage.png';
    if (mediaType === 'image/webp') return 'userimage.webp';
    // Default to jpg for jpeg or unknown
    return 'userimage.jpg';
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
    mediaType: string
): Promise<ConvertResponse> {
    const url = `${API_BASE}/api/v1/item/convert`;

    // Build multipart form data
    const formData = new FormData();

    // frames[] part: the frame UUID as a simple text form field
    // The Java code uses createFormData("frames[]", str) which is a plain text field
    formData.append('frames[]', config.frameUuid);

    // file part: the image bytes
    const filename = filenameFromMediaType(mediaType);
    const imageBlob = new Blob([imageBytes], { type: mediaType });
    formData.append('file', imageBlob, filename);

    const headers = buildHeaders(config, CONVERT_EXTRA_HEADERS);

    logStatus(`INKPOSTER: uploading image (${imageBytes.byteLength} bytes, ${mediaType}) to /api/v1/item/convert`);

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Inkposter convert failed: ${res.status} ${res.statusText} - ${text}`);
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
    queueId: string
): Promise<PollResult> {
    const url = `${API_BASE}/api/v1/item/is-converted`;
    const headers = {
        ...buildHeaders(config),
        'Content-Type': 'application/json',
    };

    const startedAt = Date.now();
    let attempts = 0;
    let lastResponse: IsConvertedResponse | null = null;

    logStatus(`INKPOSTER: polling conversion status (queueId=${queueId})`);

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        attempts += 1;

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ queueId }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Inkposter is-converted failed: ${res.status} ${res.statusText} - ${text}`);
        }

        lastResponse = (await res.json()) as IsConvertedResponse;
        logStatus(
            `INKPOSTER: poll attempt ${attempts} - status=${lastResponse.status}, message=${lastResponse.message ?? ''}`
        );

        if (lastResponse.status !== 'pending') {
            break;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    const elapsedMs = Date.now() - startedAt;

    if (!lastResponse) {
        throw new Error('Inkposter poll: no response received');
    }

    if (lastResponse.status === 'pending') {
        logStatus(`INKPOSTER: poll timed out after ${elapsedMs}ms (${attempts} attempts)`);
    } else {
        logStatus(`INKPOSTER: conversion complete (status=${lastResponse.status}, elapsedMs=${elapsedMs})`);
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
 * Upload an image and poll until conversion completes.
 */
export async function uploadAndPoll(
    config: InkposterConfig,
    imageBytes: Uint8Array,
    mediaType: string
): Promise<UploadResult> {
    const convertResponse = await uploadConvert(config, imageBytes, mediaType);
    const poll = await pollIsConverted(config, convertResponse.queueId);
    return { convertResponse, poll };
}

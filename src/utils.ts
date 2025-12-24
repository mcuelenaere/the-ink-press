import fs from 'node:fs';

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isoTimestampForPath(d = new Date()) {
    // 2025-12-24T13-40-12Z
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

export async function mkdirp(dir: string) {
    await fs.promises.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function getRequiredEnv(name: string) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required environment variable: ${name}`);
    return v;
}

export function fileExtensionFromMediaType(mediaType: string): string {
    if (mediaType === 'image/png') return 'png';
    if (mediaType === 'image/jpeg') return 'jpg';
    if (mediaType === 'image/webp') return 'webp';
    return 'bin';
}



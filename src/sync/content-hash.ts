export const FILEN_SHA512_HEX_REGEX = /^[0-9a-fA-F]{128}$/;

export function isValidFilenSha512(hash: unknown): hash is string {
	return typeof hash === "string" && FILEN_SHA512_HEX_REGEX.test(hash);
}

export function normalizeFilenHash(hash: string): string {
	return hash.toLowerCase();
}

// Borrow ordinary buffers only for the synchronous digest() call: WebCrypto
// snapshots the bytes before returning its promise. Never mutate or transfer the
// input here; callers retain ownership. Preserve subview bounds without slicing.
// Shared-backed views are not a supported WebCrypto BufferSource, so copy them
// into an ordinary buffer. Callers must prevent concurrent writes during that copy.
const toDigestBufferSource = (data: Uint8Array | ArrayBuffer): BufferSource => {
	if (data instanceof ArrayBuffer) return data;
	if (data.buffer instanceof ArrayBuffer) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
};

const getSubtleCrypto = (): SubtleCrypto => {
	const cryptoObj =
		globalThis.crypto ?? (typeof window !== "undefined" ? window.crypto : undefined);
	if (!cryptoObj?.subtle) {
		throw new Error("Web Crypto API (subtle) is not available.");
	}
	return cryptoObj.subtle;
};

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const subtle = getSubtleCrypto();
	const digest = await subtle.digest("SHA-256", toDigestBufferSource(data));
	return bufferToHex(new Uint8Array(digest));
}

export async function sha512Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const subtle = getSubtleCrypto();
	const digest = await subtle.digest("SHA-512", toDigestBufferSource(data));
	return bufferToHex(new Uint8Array(digest));
}

function bufferToHex(buffer: Uint8Array): string {
	let hex = "";
	for (let i = 0; i < buffer.length; i++) {
		const byte = buffer[i];
		if (byte !== undefined) {
			hex += byte.toString(16).padStart(2, "0");
		}
	}
	return hex;
}

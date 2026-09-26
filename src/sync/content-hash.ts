export const FILEN_SHA512_HEX_REGEX = /^[0-9a-fA-F]{128}$/;

export function isValidFilenSha512(hash: unknown): hash is string {
	return typeof hash === "string" && FILEN_SHA512_HEX_REGEX.test(hash);
}

export function normalizeFilenHash(hash: string): string {
	return hash.toLowerCase();
}

const toArrayBuffer = (data: Uint8Array | ArrayBuffer): ArrayBuffer => {
	if (data instanceof ArrayBuffer) return data;
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
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
	const digest = await subtle.digest("SHA-256", toArrayBuffer(data));
	return bufferToHex(new Uint8Array(digest));
}

export async function sha512Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
	const subtle = getSubtleCrypto();
	const digest = await subtle.digest("SHA-512", toArrayBuffer(data));
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

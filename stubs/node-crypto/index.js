// Stand-in for Node's `crypto` (replaces the ~1.9 MB crypto-browserify polyfill).
// Obsidian runs @filen/sdk in its "browser" environment, which uses WebCrypto and
// @noble/hashes. The only Node crypto call left on those paths is createHash("md5")
// in the legacy v1 EVP_BytesToKey decrypt. Hashing, HMAC and randomness are provided;
// ciphers, RSA and key derivation are node-only in the SDK and throw loudly if that changes.
const { Buffer } = require("buffer");
const { md5, sha1 } = require("@noble/hashes/legacy");
const { sha256 } = require("@noble/hashes/sha256");
const { sha512 } = require("@noble/hashes/sha512");
const { hmac } = require("@noble/hashes/hmac");

const hashes = { md5, sha1, sha256, sha512 };

function getHash(algorithm) {
	const hash = hashes[String(algorithm).toLowerCase()];
	if (!hash) throw new Error(`crypto hash "${algorithm}" is not available in the Obsidian build`);
	return hash;
}

function toBytes(data, encoding) {
	if (typeof data === "string") return Buffer.from(data, encoding || "utf8");
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data))
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	throw new TypeError("crypto: data must be a string, Buffer, TypedArray or ArrayBuffer");
}

function wrapHasher(state) {
	let finished = false;
	const hasher = {
		update(data, encoding) {
			if (finished) throw new Error("crypto: digest already called");
			state.update(toBytes(data, encoding));
			return hasher;
		},
		digest(encoding) {
			if (finished) throw new Error("crypto: digest already called");
			finished = true;
			const out = Buffer.from(state.digest());
			return encoding ? out.toString(encoding) : out;
		},
	};
	return hasher;
}

function createHash(algorithm) {
	return wrapHasher(getHash(algorithm).create());
}

function createHmac(algorithm, key) {
	return wrapHasher(hmac.create(getHash(algorithm), toBytes(key)));
}

function getRandomValues(array) {
	return globalThis.crypto.getRandomValues(array);
}

function randomBytes(size, callback) {
	const bytes = Buffer.alloc(size);
	// getRandomValues fills at most 65536 bytes per call.
	for (let offset = 0; offset < size; offset += 65536) {
		getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, size)));
	}
	if (typeof callback === "function") {
		callback(null, bytes);
		return undefined;
	}
	return bytes;
}

function randomUUID() {
	return globalThis.crypto.randomUUID();
}

function unavailable(name) {
	return () => {
		throw new Error(`crypto.${name} is not available in the Obsidian build`);
	};
}

module.exports = {
	createHash,
	createHmac,
	getRandomValues,
	randomBytes,
	randomUUID,
	get webcrypto() {
		return globalThis.crypto;
	},
	get subtle() {
		return globalThis.crypto.subtle;
	},
	constants: { RSA_PKCS1_OAEP_PADDING: 4 },
	createCipheriv: unavailable("createCipheriv"),
	createDecipheriv: unavailable("createDecipheriv"),
	publicEncrypt: unavailable("publicEncrypt"),
	privateDecrypt: unavailable("privateDecrypt"),
	pbkdf2: unavailable("pbkdf2"),
	pbkdf2Sync: unavailable("pbkdf2Sync"),
	hkdf: unavailable("hkdf"),
	generateKeyPair: unavailable("generateKeyPair"),
};
module.exports.default = module.exports;

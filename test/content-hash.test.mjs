import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { build } from "esbuild";

let hashes;
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

before(async () => {
	// Compile in memory so this focused suite leaves no generated artifacts.
	const result = await build({
		entryPoints: ["src/sync/content-hash.ts"],
		bundle: true,
		format: "esm",
		platform: "browser",
		write: false,
	});
	hashes = await import(
		`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
	);
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
});

after(() => {
	if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
	else delete globalThis.crypto;
});

for (const [name, algorithm] of [
	["sha256Hex", "sha256"],
	["sha512Hex", "sha512"],
]) {
	const expected = (bytes) => createHash(algorithm).update(bytes).digest("hex");

	test(`${name} hashes whole buffers and exact subview bounds without mutation`, async () => {
		const bytes = new TextEncoder().encode("prefix:abc:suffix");
		const original = new Uint8Array(bytes);
		for (const input of [
			bytes.buffer,
			bytes,
			new Uint8Array(bytes.buffer, 7, 3),
			new Uint8Array(bytes.buffer, 7),
			new Uint8Array(bytes.buffer, 7, 0),
			new ArrayBuffer(0),
		]) {
			const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
			assert.equal(await hashes[name](input), expected(view));
			assert.deepEqual(bytes, original);
		}
	});

	test(`${name} passes supported backing buffers to WebCrypto without a content slice`, async (t) => {
		const bytes = new Uint8Array([99, 1, 2, 3, 88]);
		const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
		let received;
		t.mock.method(webcrypto.subtle, "digest", (algorithm, source) => {
			received = source;
			return digest(algorithm, source);
		});
		const noSlice = () => assert.fail("supported inputs must not be sliced");
		t.mock.method(bytes.buffer, "slice", noSlice);
		for (const input of [bytes.buffer, bytes, new Uint8Array(bytes.buffer, 1, 3)]) {
			if (ArrayBuffer.isView(input)) t.mock.method(input, "slice", noSlice);
			const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
			assert.equal(await hashes[name](input), expected(view));
			if (input instanceof ArrayBuffer) {
				assert.equal(received, input);
			} else {
				// Backing-buffer identity also rules out copies via constructors/set().
				assert.equal(received.buffer, input.buffer);
				assert.equal(received.byteOffset, input.byteOffset);
				assert.equal(received.byteLength, input.byteLength);
			}
		}
	});

	test(`${name} lets WebCrypto snapshot input before subsequent caller mutation`, async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const originalHash = expected(bytes);
		const pending = hashes[name](bytes);
		bytes.fill(9);
		assert.equal(await pending, originalHash);
		assert.deepEqual(bytes, new Uint8Array([9, 9, 9]));
	});

	test(`${name} copies shared-backed subviews to a supported BufferSource`, async (t) => {
		const bytes = new Uint8Array(new SharedArrayBuffer(5));
		bytes.set([99, 1, 2, 3, 88]);
		const input = new Uint8Array(bytes.buffer, 1, 3);
		const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
		t.mock.method(webcrypto.subtle, "digest", (algorithm, source) => {
			assert.ok(source.buffer instanceof ArrayBuffer);
			assert.notEqual(source.buffer, input.buffer);
			assert.deepEqual(source, new Uint8Array([1, 2, 3]));
			return digest(algorithm, source);
		});
		assert.equal(await hashes[name](input), expected(input));
		assert.deepEqual(bytes, new Uint8Array([99, 1, 2, 3, 88]));
	});
}

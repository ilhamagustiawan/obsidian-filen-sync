import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";

// Bundle in memory so this suite leaves no generated artifacts behind.
const bundle = await build({
	entryPoints: ["src/sync/chunk-transfers.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
	plugins: [
		{
			name: "observe-pool-results",
			setup(builder) {
				builder.onResolve({ filter: /^\.\/pool$/ }, () => ({
					path: "pool",
					namespace: "observe-pool",
				}));
				builder.onLoad({ filter: /.*/, namespace: "observe-pool" }, () => ({
					contents: `
					import { mapPool as original } from ${JSON.stringify(resolve("src/sync/pool.ts"))};
					export async function mapPool(...args) {
						const results = await original(...args);
						globalThis[Symbol.for("download-memory.pool-result-types")] = results.map(value => typeof value);
						return results;
					}
				`,
					loader: "js",
					resolveDir: resolve("src/sync"),
				}));
			},
		},
	],
});
const { downloadFileChunks, CHUNK_SIZE, CHUNK_CONCURRENCY } = await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const target = (size, overrides = {}) => ({
	uuid: "file",
	bucket: "bucket",
	region: "region",
	version: 2,
	size,
	chunks: Math.ceil(size / CHUNK_SIZE),
	key: "key",
	...overrides,
});

function sdkWith(fetch, decrypt = async ({ data }) => data) {
	return {
		getWorker: () => ({
			api: { v3: { file: { download: { chunk: { buffer: { fetch } } } } } },
			crypto: { decrypt: { data: decrypt } },
		}),
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("invalid download metadata fails before allocation or network requests", async () => {
	const invalid = [
		...[
			-1,
			0.5,
			NaN,
			Infinity,
			-Infinity,
			Number.MAX_SAFE_INTEGER + 1,
			"1",
			null,
			undefined,
		].map((size) => target(0, { size })),
		...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined].map(
			(chunks) => target(1, { chunks }),
		),
		target(0, { chunks: 1 }),
		target(1, { chunks: 0 }),
		target(CHUNK_SIZE + 1, { chunks: 1 }),
		target(CHUNK_SIZE, { chunks: 2 }),
		target(Number.MAX_SAFE_INTEGER, { chunks: 1 }),
	];
	const OriginalUint8Array = globalThis.Uint8Array;
	let allocations = 0;
	let requests = 0;
	globalThis.Uint8Array = new Proxy(OriginalUint8Array, {
		construct(Type, args) {
			allocations++;
			return new Type(...args);
		},
	});
	try {
		for (const metadata of invalid) {
			await assert.rejects(
				downloadFileChunks(
					sdkWith(async () => {
						requests++;
					}),
					metadata,
				),
				/Invalid download (file size|chunk count)/,
			);
		}
		assert.equal(allocations, 0);
		assert.equal(requests, 0);
	} finally {
		globalThis.Uint8Array = OriginalUint8Array;
	}
});

test("empty download returns an empty destination and reports zero progress", async () => {
	const progress = [];
	const result = await downloadFileChunks(
		sdkWith(async () => {
			assert.fail("empty file must not fetch");
		}),
		target(0),
		(...args) => progress.push(args),
	);
	assert.equal(result.byteLength, 0);
	assert.deepEqual(progress, [[0, 0, 0, 0]]);
});

test("out-of-order chunks copy directly into one destination with bounded concurrency", async () => {
	const size = CHUNK_SIZE * 4 + 7;
	const metadata = target(size, { version: undefined });
	const gates = Array.from({ length: metadata.chunks }, deferred);
	const copied = Array.from({ length: metadata.chunks }, deferred);
	// Non-zero byteOffset views ensure copying respects the decrypted view boundaries.
	const parts = gates.map((_, index) => {
		const length = Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE);
		return Buffer.alloc(length + 20, index + 1).subarray(10, 10 + length);
	});
	let active = 0;
	let peakActive = 0;
	const requested = [];
	const progress = [];
	const allocations = [];
	const copies = [];
	const OriginalUint8Array = globalThis.Uint8Array;
	const originalSet = OriginalUint8Array.prototype.set;
	globalThis.Uint8Array = new Proxy(OriginalUint8Array, {
		construct(Type, args) {
			const result = new Type(...args);
			allocations.push(result);
			return result;
		},
	});
	OriginalUint8Array.prototype.set = function (source, offset) {
		copies.push({ destination: this, source, offset });
		return originalSet.call(this, source, offset);
	};
	try {
		const download = downloadFileChunks(
			sdkWith(
				async (params) => {
					requested.push(params.chunk);
					assert.deepEqual(params, {
						uuid: "file",
						bucket: "bucket",
						region: "region",
						chunk: params.chunk,
						timeout: 60_000,
					});
					active++;
					peakActive = Math.max(peakActive, active);
					await gates[params.chunk].promise;
					active--;
					return parts[params.chunk];
				},
				async ({ data, key, version }) => {
					assert.equal(key, "key");
					assert.equal(version, 2);
					return data;
				},
			),
			metadata,
			(...args) => {
				progress.push(args);
				const index = parts.indexOf(copies.at(-1).source);
				copied[index].resolve();
			},
		);
		assert.deepEqual(requested, [0, 1, 2]);
		for (const index of [2, 3, 4, 1, 0]) {
			gates[index].resolve();
			await copied[index].promise;
			assert.equal(allocations.length, 1, "no completed-chunk copies are allocated");
			assert.equal(
				allocations[0][index * CHUNK_SIZE],
				index + 1,
				"destination is populated immediately, before the download finishes",
			);
		}
		const result = await download;
		assert.equal(result, allocations[0]);
		assert.equal(result.byteLength, size);
		assert.deepEqual(
			globalThis[Symbol.for("download-memory.pool-result-types")],
			Array(metadata.chunks).fill("undefined"),
			"pool results must not retain decrypted chunks",
		);
		assert.equal(peakActive, CHUNK_CONCURRENCY);
		assert.deepEqual(
			copies.map(({ offset }) => offset),
			[2, 3, 4, 1, 0].map((i) => i * CHUNK_SIZE),
		);
		for (const { destination, source, offset } of copies) {
			assert.equal(destination, result);
			assert.equal(
				Buffer.compare(result.subarray(offset, offset + source.byteLength), source),
				0,
			);
		}
		assert.deepEqual(progress, [
			[1, 5, CHUNK_SIZE, size],
			[2, 5, CHUNK_SIZE * 2, size],
			[3, 5, CHUNK_SIZE * 2 + 7, size],
			[4, 5, CHUNK_SIZE * 3 + 7, size],
			[5, 5, size, size],
		]);
	} finally {
		globalThis.Uint8Array = OriginalUint8Array;
		OriginalUint8Array.prototype.set = originalSet;
	}
});

test("exact chunk boundaries and explicit encryption versions remain compatible", async () => {
	for (const version of [1, 2]) {
		const progress = [];
		const result = await downloadFileChunks(
			sdkWith(
				async () => Buffer.alloc(CHUNK_SIZE, 42),
				async ({ data, version: actual }) => {
					assert.equal(actual, version);
					return data;
				},
			),
			target(CHUNK_SIZE * 2, { version }),
			(...args) => progress.push(args),
		);
		assert.equal(result.byteLength, CHUNK_SIZE * 2);
		assert.ok(result.every((byte) => byte === 42));
		assert.deepEqual(progress.at(-1), [2, 2, CHUNK_SIZE * 2, CHUNK_SIZE * 2]);
	}
});

test("truncated, oversized, and inconsistently partitioned decrypted chunks are rejected", async () => {
	for (const [size, lengths] of [
		[3, [2]],
		[3, [4]],
		[3, [0]],
		[CHUNK_SIZE, [CHUNK_SIZE - 1]],
		[CHUNK_SIZE + 3, [CHUNK_SIZE - 1, 4]], // Same total length, wrong boundaries.
		[CHUNK_SIZE + 3, [CHUNK_SIZE + 1, 2]],
		[CHUNK_SIZE + 3, [CHUNK_SIZE, 2]],
		[CHUNK_SIZE + 3, [CHUNK_SIZE, 4]],
	]) {
		const progress = [];
		await assert.rejects(
			downloadFileChunks(
				sdkWith(async ({ chunk }) => Buffer.alloc(lengths[chunk])),
				target(size),
				(...args) => progress.push(args),
			),
			/Invalid download chunk size at index \d+: expected \d+, received \d+/,
		);
		assert.ok(progress.every(([, , bytes]) => bytes <= size));
		assert.ok(progress.every(([done]) => done < lengths.length));
	}
});

for (const failure of ["fetch", "decrypt", "size", "progress"]) {
	test(`${failure} failure drains in-flight chunks and stops scheduling`, async () => {
		const gates = Array.from({ length: 3 }, deferred);
		const requested = [];
		const finished = [];
		const progress = [];
		const error = new Error(`${failure} failed`);
		let settled = false;
		const download = downloadFileChunks(
			sdkWith(
				async ({ chunk }) => {
					requested.push(chunk);
					await gates[chunk].promise;
					finished.push(chunk);
					if (chunk === 0 && failure === "fetch") throw error;
					return Buffer.alloc(failure === "size" && chunk === 0 ? 1 : CHUNK_SIZE, chunk);
				},
				async ({ data }) => {
					if (data[0] === 0 && failure === "decrypt") throw error;
					return data;
				},
			),
			target(CHUNK_SIZE * 5),
			(...args) => {
				progress.push(args);
				if (failure === "progress" && args[0] === 1) throw error;
			},
		);
		const checked = assert.rejects(
			download,
			failure === "size" ? /Invalid download chunk size/ : error,
		);
		download.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		gates[0].resolve();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "failure must wait for the other two workers");
		assert.deepEqual(requested, [0, 1, 2]);
		gates[1].resolve();
		gates[2].resolve();
		await checked;
		assert.deepEqual(finished, [0, 1, 2]);
		assert.deepEqual(requested, [0, 1, 2]);
		assert.equal(progress.length, failure === "progress" ? 3 : 2);
	});
}

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

test("download byte progress counts short chunks correctly despite out-of-order completion", async () => {
	const dir = await mkdtemp(resolve("tmp/transfer-"));
	try {
		const outfile = join(dir, "chunks.mjs");
		await build({
			entryPoints: ["src/sync/chunk-transfers.ts"],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
		});
		const { downloadFileChunks, CHUNK_SIZE } = await import(pathToFileURL(outfile).href);
		const progress = [];
		const sdk = {
			getWorker: () => ({
				api: {
					v3: {
						file: {
							download: {
								chunk: {
									buffer: {
										fetch: async ({ chunk }) => {
											if (chunk === 0)
												await new Promise((r) => setTimeout(r, 10));
											return new Uint8Array(
												chunk === 0 ? CHUNK_SIZE : 3,
											).fill(chunk);
										},
									},
								},
							},
						},
					},
				},
				crypto: { decrypt: { data: async ({ data }) => data } },
			}),
		};
		const result = await downloadFileChunks(
			sdk,
			{ uuid: "file", size: CHUNK_SIZE + 3, chunks: 2, version: 2, key: "test" },
			(...args) => progress.push(args),
		);
		assert.deepEqual(progress, [
			[1, 2, 3, CHUNK_SIZE + 3],
			[2, 2, CHUNK_SIZE + 3, CHUNK_SIZE + 3],
		]);
		assert.equal(result.length, CHUNK_SIZE + 3);
		assert.equal(result[CHUNK_SIZE], 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

import type FilenSDK from "@filen/sdk";
import type { AuthVersion, FileEncryptionVersion } from "@filen/sdk";
import { mapPool } from "./pool";
import { sha512Hex } from "./content-hash";

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const CHUNK_CONCURRENCY = 3; // Fixed pool of 3 workers

export type ChunkTransferProgressCallback = (
	doneChunks: number,
	totalChunks: number,
	completedBytes: number,
	totalBytes: number,
) => void;

type UploadDoneParams = {
	uuid: string;
	name: string;
	nameHashed: string;
	size: string;
	chunks: number;
	mime: string;
	rm: string;
	metadata: string;
	version: FileEncryptionVersion;
	uploadKey: string;
};

type UploadEmptyParams = {
	uuid: string;
	name: string;
	nameHashed: string;
	size: string;
	parent: string;
	mime: string;
	metadata: string;
	version: FileEncryptionVersion;
};

type UploadChunkResponse = {
	bucket: string;
	region: string;
};

type SdkWithInternals = FilenSDK & {
	generateHMACKey: () => Promise<string>;
	_locks: {
		driveWrite: {
			acquire: () => Promise<void>;
			release: () => Promise<void>;
		};
	};
	getWorker: () => {
		crypto: {
			encrypt: {
				data: (p: { data: Uint8Array | Buffer; key: string }) => Promise<Buffer>;
				metadata: (p: { metadata: string; key: string }) => Promise<string>;
			};
			decrypt: {
				data: (p: {
					data: Uint8Array | Buffer;
					key: string;
					version: FileEncryptionVersion;
				}) => Promise<Buffer>;
			};
			utils: {
				generateEncryptionKey: (type: string) => Promise<string>;
				generateRandomString: (length: number) => Promise<string>;
				hashFileName: (p: {
					name: string;
					authVersion: AuthVersion;
					hmacKey: string;
				}) => Promise<string>;
			};
		};
		api: {
			v3: {
				file: {
					upload: {
						chunk: {
							buffer: {
								fetch: (p: {
									uuid: string;
									index: number;
									parent: string;
									uploadKey: string;
									buffer: unknown;
									timeout: number;
									maxRetries: number;
									retryTimeout: number;
								}) => Promise<UploadChunkResponse>;
							};
						};
					};
					download: {
						chunk: {
							buffer: {
								fetch: (p: {
									uuid: string;
									bucket: string;
									region: string;
									chunk: number;
									timeout: number;
								}) => Promise<Buffer>;
							};
						};
					};
				};
			};
		};
	};
	api: (version: number) => {
		upload: () => {
			done: (p: UploadDoneParams) => Promise<unknown>;
			empty: (p: UploadEmptyParams) => Promise<unknown>;
		};
	};
};

/**
 * Upload a file by chunking into 1 MiB pieces and transferring via a fixed pool of 3 workers.
 * Chunks are index-addressed; any chunk failure fails the entire upload.
 */
export async function uploadFileChunks(
	sdk: FilenSDK,
	parentUuid: string,
	fileName: string,
	bytes: Uint8Array,
	mtime: number,
	ctime: number,
	mimeType: string = "application/octet-stream",
	onProgress?: ChunkTransferProgressCallback,
	beforeCommit?: () => Promise<void>,
): Promise<{ uuid: string; size: number; chunks: number; hash: string }> {
	const client = sdk as unknown as SdkWithInternals;
	const fileSize = bytes.byteLength;
	const cryptoObj =
		globalThis.crypto ?? (typeof window !== "undefined" ? window.crypto : undefined);
	const fileUUID = cryptoObj!.randomUUID();
	const key = await client.getWorker().crypto.utils.generateEncryptionKey("file");

	if (fileSize === 0) {
		const [nameEncrypted, mimeEncrypted, sizeEncrypted, metadata, nameHashed] =
			await Promise.all([
				client.getWorker().crypto.encrypt.metadata({ metadata: fileName, key }),
				client.getWorker().crypto.encrypt.metadata({ metadata: mimeType, key }),
				client.getWorker().crypto.encrypt.metadata({ metadata: "0", key }),
				client.getWorker().crypto.encrypt.metadata({
					metadata: JSON.stringify({
						name: fileName,
						size: 0,
						mime: mimeType,
						key,
						lastModified: mtime,
						creation: ctime,
						hash: "",
					}),
				}),
				client.getWorker().crypto.utils.hashFileName({
					name: fileName,
					authVersion: (client.config.authVersion ?? 1) as AuthVersion,
					hmacKey: await client.generateHMACKey(),
				}),
			]);

		await beforeCommit?.();
		await client.api(3).upload().empty({
			uuid: fileUUID,
			name: nameEncrypted,
			nameHashed,
			size: sizeEncrypted,
			parent: parentUuid,
			mime: mimeEncrypted,
			metadata,
			version: 2,
		});

		onProgress?.(0, 0, 0, 0);
		return { uuid: fileUUID, size: 0, chunks: 0, hash: "" };
	}

	const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);
	const rm = await client.getWorker().crypto.utils.generateRandomString(32);
	const uploadKey = await client.getWorker().crypto.utils.generateRandomString(32);

	const hashHex = await sha512Hex(bytes);

	let completedChunks = 0;
	let completedBytes = 0;
	const chunkIndices = Array.from({ length: chunkCount }, (_, i) => i);
	await mapPool(chunkIndices, CHUNK_CONCURRENCY, async (index) => {
		const start = index * CHUNK_SIZE;
		const end = Math.min((index + 1) * CHUNK_SIZE, fileSize);
		const chunkData = bytes.subarray(start, end);
		const encryptedChunk = await client.getWorker().crypto.encrypt.data({
			data: Buffer.from(chunkData) as unknown as Buffer,
			key,
		});

		const response = await client.getWorker().api.v3.file.upload.chunk.buffer.fetch({
			uuid: fileUUID,
			index,
			parent: parentUuid,
			uploadKey,
			buffer: Buffer.from(encryptedChunk) as unknown as Buffer,
			timeout: 180_000,
			// The SDK treats zero as its 3,600-retry default. One attempt avoids
			// automatic mutation retries after an adapter timeout/abort.
			maxRetries: 1,
			retryTimeout: 1,
		});

		completedChunks += 1;
		completedBytes += end - start;
		onProgress?.(completedChunks, chunkCount, completedBytes, fileSize);
		return response;
	});

	const [nameEncrypted, mimeEncrypted, sizeEncrypted, metadata, nameHashed] = await Promise.all([
		client.getWorker().crypto.encrypt.metadata({ metadata: fileName, key }),
		client.getWorker().crypto.encrypt.metadata({ metadata: mimeType, key }),
		client.getWorker().crypto.encrypt.metadata({ metadata: String(fileSize), key }),
		client.getWorker().crypto.encrypt.metadata({
			metadata: JSON.stringify({
				name: fileName,
				size: fileSize,
				mime: mimeType,
				key,
				lastModified: mtime,
				creation: ctime,
				hash: hashHex,
			}),
		}),
		client.getWorker().crypto.utils.hashFileName({
			name: fileName,
			authVersion: (client.config.authVersion ?? 1) as AuthVersion,
			hmacKey: await client.generateHMACKey(),
		}),
	]);

	await client._locks.driveWrite.acquire();
	try {
		await beforeCommit?.();
		await client.api(3).upload().done({
			uuid: fileUUID,
			name: nameEncrypted,
			nameHashed,
			size: sizeEncrypted,
			chunks: chunkCount,
			mime: mimeEncrypted,
			rm,
			metadata,
			version: 2,
			uploadKey,
		});
	} finally {
		await client._locks.driveWrite.release().catch(() => {});
	}

	return { uuid: fileUUID, size: fileSize, chunks: chunkCount, hash: hashHex };
}

export type FileDownloadTarget = {
	uuid: string;
	bucket: string;
	region: string;
	version: number;
	size: number;
	chunks: number;
	key: string;
};

/**
 * Download a file by fetching 1 MiB chunks in parallel through a fixed pool of 3 workers.
 * Chunks are index-addressed so completion order does not matter; any failed chunk fails the download.
 * Only the destination and in-flight chunks retain file bytes, not the pool's results.
 */
export async function downloadFileChunks(
	sdk: FilenSDK,
	target: FileDownloadTarget,
	onProgress?: ChunkTransferProgressCallback,
): Promise<Uint8Array> {
	const client = sdk as unknown as SdkWithInternals;
	const { size, chunks } = target;
	if (!Number.isSafeInteger(size) || size < 0) {
		throw new Error("Invalid download file size: expected a non-negative safe integer.");
	}
	if (!Number.isSafeInteger(chunks) || chunks < 0 || chunks !== Math.ceil(size / CHUNK_SIZE)) {
		throw new Error("Invalid download chunk count: inconsistent with file size.");
	}
	const fullBuffer = new Uint8Array(size);
	if (size === 0) {
		onProgress?.(0, 0, 0, 0);
		return fullBuffer;
	}

	let completedChunks = 0;
	let completedBytes = 0;
	const chunkIndices = Array.from({ length: chunks }, (_, i) => i);
	await mapPool(chunkIndices, CHUNK_CONCURRENCY, async (index) => {
		const encryptedBuffer = await client.getWorker().api.v3.file.download.chunk.buffer.fetch({
			uuid: target.uuid,
			bucket: target.bucket,
			region: target.region,
			chunk: index,
			timeout: 60_000,
		});

		const decryptedBuffer = await client.getWorker().crypto.decrypt.data({
			data: encryptedBuffer,
			key: target.key,
			version: (target.version ?? 2) as FileEncryptionVersion,
		});

		const offset = index * CHUNK_SIZE;
		const expectedSize = Math.min(CHUNK_SIZE, size - offset);
		if (decryptedBuffer.byteLength !== expectedSize) {
			throw new Error(
				`Invalid download chunk size at index ${index}: expected ${expectedSize}, received ${decryptedBuffer.byteLength}.`,
			);
		}
		fullBuffer.set(decryptedBuffer, offset);
		completedChunks += 1;
		completedBytes += decryptedBuffer.byteLength;
		onProgress?.(completedChunks, chunks, completedBytes, size);
	});

	return fullBuffer;
}

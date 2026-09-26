import { FilenSDK } from "@filen/sdk";
import { createObsidianAxiosLike } from "./obsidian-axios-adapter";
import type { FilenAuth } from "./settings";
import { downloadFileChunks, uploadFileChunks } from "./sync/chunk-transfers";
import { isValidFilenSha512, normalizeFilenHash } from "./sync/content-hash";
import { validateRemoteRoot, validateSyncPath } from "./sync/path-validation";

export type RemoteEntry = {
	path: string;
	mtime: number;
	size: number;
	isDir: boolean;
	uuid?: string;
	remoteHash?: string;
};

export type RemoteTargetIdentity = { userId: number; rootUuid: string };

export type RemoteFileVersion = {
	uuid: string;
	version: number;
	timestamp: number; // normalized to ms
	bucket: string;
	region: string;
	chunks: number;
};

export type RemoteFs = {
	walk(): Promise<RemoteEntry[]>;
	readFile(
		path: string,
		expectedRemoteUuid?: string,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<Uint8Array>;
	writeFile(
		path: string,
		bytes: Uint8Array,
		mtime: number,
		ctime: number,
		expectedRemoteUuid?: string,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<RemoteEntry>;
	rm(path: string, expectedRemoteUuid?: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	checkConnect(): Promise<void>;
	getFileVersions(path: string): Promise<RemoteFileVersion[]>;
	readFileVersion(version: RemoteFileVersion): Promise<Uint8Array>;
	restoreFileVersion(path: string, versionUuid: string): Promise<void>;
	stat?(path: string): Promise<RemoteEntry | null>;
	close(): void;
	checkEvents?(watermarkMs: number): Promise<{ hasChanges: boolean; newWatermarkMs: number }>;
	withMutationSession?<T>(fn: () => Promise<T>): Promise<T>;
};

type FilenRemoteFsConfig = {
	email: string;
	password: string;
	twoFactorCode: string;
	remoteRoot: string;
	auth: FilenAuth | null;
	saveAuth: (auth: FilenAuth) => Promise<void>;
};

export class FilenRemoteFs implements RemoteFs {
	private client: FilenSDK | null = null;
	private verifiedRootForSync: FilenSDK | null = null;
	private scannedDirectoryUuids: Map<string, string> | null = null;
	private createdDirectoryPaths = new Set<string>();
	private inMutationSession = false;

	constructor(private readonly config: FilenRemoteFsConfig) {}

	async withMutationSession<T>(fn: () => Promise<T>): Promise<T> {
		this.inMutationSession = true;
		try {
			return await fn();
		} finally {
			this.inMutationSession = false;
			this.verifiedRootForSync = null;
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
			if (this.client !== null) {
				this.client.init(this.client.config);
				configureSdkRetryBounds(this.client);
			}
		}
	}

	async walk(): Promise<RemoteEntry[]> {
		this.verifiedRootForSync = null;
		this.scannedDirectoryUuids = null;
		this.createdDirectoryPaths.clear();
		try {
			const rootUuid = await this.getParentUuid("");
			const client = await this.getClient();
			const entries = this.sortEntries(await this.walkTree(rootUuid, client.cloud()));
			const directoryUuids = new Map<string, string>([["", rootUuid]]);
			for (const entry of entries) {
				if (entry.isDir && entry.uuid !== undefined) {
					directoryUuids.set(normalizeRemotePath(entry.path), entry.uuid);
				}
			}
			this.scannedDirectoryUuids = directoryUuids;
			return entries;
		} catch (error) {
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
			throw error;
		}
	}

	/** Resolve the authenticated account and effective mirror directory before DB binding. */
	async getTargetIdentity(): Promise<RemoteTargetIdentity> {
		this.verifiedRootForSync = null;
		this.scannedDirectoryUuids = null;
		this.createdDirectoryPaths.clear();
		const client = await this.getClient();
		// Flush the SDK's in-memory directory cache so a replaced root cannot reuse
		// an earlier UUID as the database binding.
		client.init(client.config);
		configureSdkRetryBounds(client);
		const userId = client.config.userId;
		if (typeof userId !== "number" || !Number.isFinite(userId) || userId <= 0) {
			throw new Error("Filen did not provide a valid authenticated user identity.");
		}
		try {
			const rootUuid = await this.getParentUuid("");
			this.verifiedRootForSync = client;
			return { userId, rootUuid };
		} catch (error) {
			this.verifiedRootForSync = null;
			throw error;
		}
	}

	private async walkTree(
		rootUuid: string,
		cloud: ReturnType<FilenSDK["cloud"]>,
	): Promise<RemoteEntry[]> {
		const tree = await cloud.getDirectoryTree({ uuid: rootUuid, skipCache: true });
		const entries: RemoteEntry[] = [];

		for (const [treePath, item] of Object.entries(tree)) {
			if (treePath === "/" || item.parent === "base") {
				continue;
			}

			const path = validateSyncPath(treePath.startsWith("/") ? treePath.slice(1) : treePath);

			const rawHash =
				typeof (item as { hash?: unknown }).hash === "string"
					? (item as { hash: string }).hash
					: undefined;
			const remoteHash =
				rawHash !== undefined && isValidFilenSha512(rawHash)
					? normalizeFilenHash(rawHash)
					: undefined;

			entries.push({
				path,
				mtime: normalizeRemoteTimestampMs(item.lastModified),
				size: item.size,
				isDir: item.type === "directory",
				uuid:
					typeof (item as { uuid?: unknown }).uuid === "string"
						? (item as { uuid: string }).uuid
						: undefined,
				remoteHash,
			});
		}

		return entries;
	}

	private sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
		return entries.sort((left, right) => left.path.localeCompare(right.path));
	}

	async readFile(
		path: string,
		expectedRemoteUuid?: string,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<Uint8Array> {
		this.verifiedRootForSync = null;
		validateSyncPath(path);
		const client = await this.getClient();
		const uuid = await client.fs().pathToItemUUID({ path: this.join(path), type: "file" });
		if (uuid === null) {
			throw new Error(`Remote file not found: ${path}`);
		}
		if (expectedRemoteUuid !== undefined && uuid !== expectedRemoteUuid) {
			throw new Error(`Remote file changed before download: ${path}. Replan the sync.`);
		}
		const file = await client.cloud().getFile({ uuid });
		return downloadFileChunks(
			client,
			{
				uuid: file.uuid,
				bucket: file.bucket,
				region: file.region,
				version: file.version,
				size: file.size,
				chunks: file.chunks,
				key: file.metadataDecrypted.key,
			},
			(_done, _total, completedBytes, totalBytes) => onProgress?.(completedBytes, totalBytes),
		);
	}

	async writeFile(
		path: string,
		bytes: Uint8Array,
		mtime: number,
		ctime: number,
		expectedRemoteUuid?: string,
		onProgress?: (completedBytes: number, totalBytes: number) => void,
	): Promise<RemoteEntry> {
		this.verifiedRootForSync = null;
		validateSyncPath(path);
		const client = await this.getClient();
		const normalized = normalizeRemotePath(path);
		const parent = normalized.includes("/")
			? normalized.slice(0, normalized.lastIndexOf("/"))
			: "";
		const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);

		let parentUuid: string;
		if (
			this.inMutationSession &&
			this.scannedDirectoryUuids !== null &&
			this.scannedDirectoryUuids.has(parent)
		) {
			parentUuid = this.scannedDirectoryUuids.get(parent)!;
		} else {
			parentUuid = await this.getParentUuid(parent);
		}

		if (this.inMutationSession) {
			const existing = await client
				.cloud()
				.fileExists({ name: fileName, parent: parentUuid });
			if (
				(expectedRemoteUuid === undefined && existing) ||
				(expectedRemoteUuid !== undefined &&
					(!existing ||
						(typeof existing === "object" && existing.uuid !== expectedRemoteUuid)))
			) {
				throw new Error(`Remote file changed before upload: ${path}. Replan the sync.`);
			}
		} else {
			const current = await this.stat(path);
			if (
				(expectedRemoteUuid === undefined && current !== null) ||
				(expectedRemoteUuid !== undefined && current?.uuid !== expectedRemoteUuid)
			) {
				throw new Error(`Remote file changed before upload: ${path}. Replan the sync.`);
			}
		}

		const uploaded = await uploadFileChunks(
			client,
			parentUuid,
			fileName,
			bytes,
			mtime,
			ctime,
			undefined,
			(_done, _total, completedBytes, totalBytes) => onProgress?.(completedBytes, totalBytes),
		);
		if (!this.inMutationSession) {
			this.verifiedRootForSync = null;
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
			client.init(client.config);
			configureSdkRetryBounds(client);
		}
		const rawHash = typeof uploaded.hash === "string" ? uploaded.hash : undefined;
		const remoteHash =
			rawHash !== undefined && isValidFilenSha512(rawHash)
				? normalizeFilenHash(rawHash)
				: undefined;
		return {
			path,
			mtime,
			size: uploaded.size,
			isDir: false,
			uuid: uploaded.uuid,
			remoteHash,
		};
	}

	async rm(path: string, expectedRemoteUuid?: string): Promise<void> {
		this.verifiedRootForSync = null;
		validateSyncPath(path);
		const client = await this.getClient();
		const current = await this.stat(path);
		if (
			current === null ||
			(expectedRemoteUuid !== undefined && current.uuid !== expectedRemoteUuid)
		) {
			throw new Error(`Remote file changed before deletion: ${path}. Replan the sync.`);
		}
		await client.cloud().trashFile({ uuid: current.uuid! });
		if (!this.inMutationSession) {
			this.verifiedRootForSync = null;
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
			client.init(client.config);
			configureSdkRetryBounds(client);
		}
	}

	async mkdir(path: string): Promise<void> {
		if (path.length > 0) validateSyncPath(path);
		const client = await this.getClient();
		if (path.length === 0) {
			const verified = this.verifiedRootForSync;
			this.verifiedRootForSync = null;
			if (verified === client) return;
		}

		const normalized = normalizeRemotePath(path);
		const directoryUuids = this.scannedDirectoryUuids;
		if (normalized.length > 0 && directoryUuids !== null) {
			const parentPath = normalized.includes("/")
				? normalized.slice(0, normalized.lastIndexOf("/"))
				: "";
			const parentUuid = directoryUuids.get(parentPath);
			if (parentUuid !== undefined) {
				try {
					if (!this.createdDirectoryPaths.has(parentPath)) {
						const currentParentUuid = await client
							.fs()
							.pathToItemUUID({ path: this.join(parentPath), type: "directory" });
						if (currentParentUuid !== parentUuid) {
							this.scannedDirectoryUuids = null;
							this.createdDirectoryPaths.clear();
							await client.fs().mkdir({ path: this.join(path) });
							return;
						}
					}
					const name = normalized.slice(normalized.lastIndexOf("/") + 1);
					const uuid = await client.cloud().createDirectory({ name, parent: parentUuid });
					directoryUuids.set(normalized, uuid);
					this.createdDirectoryPaths.add(normalized);
					return;
				} catch (error) {
					this.scannedDirectoryUuids = null;
					this.createdDirectoryPaths.clear();
					throw error;
				}
			}
		}
		if (normalized.length === 0) {
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
		}
		try {
			await client.fs().mkdir({ path: this.join(path) });
		} catch (error) {
			this.scannedDirectoryUuids = null;
			this.createdDirectoryPaths.clear();
			throw error;
		}
	}

	async checkEvents(
		watermarkMs: number,
	): Promise<{ hasChanges: boolean; newWatermarkMs: number }> {
		this.verifiedRootForSync = null;
		const client = await this.getClient();
		const lastTimestamp = Math.floor(watermarkMs / 1000);
		const rawEvents = await (
			client as unknown as {
				api: (version: number) => {
					user: () => {
						events: (p: {
							lastTimestamp: number;
							filter: string;
						}) => Promise<
							Array<{ id: number | string; type: string; timestamp: number }>
						>;
					};
				};
			}
		)
			.api(3)
			.user()
			.events({ lastTimestamp, filter: "all" });

		if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
			return { hasChanges: false, newWatermarkMs: watermarkMs };
		}

		let maxTimestampMs = watermarkMs;
		for (const event of rawEvents) {
			if (typeof event.timestamp === "number" && Number.isFinite(event.timestamp)) {
				const ms = event.timestamp < 1e11 ? event.timestamp * 1000 : event.timestamp;
				if (ms > maxTimestampMs) maxTimestampMs = ms;
			}
		}

		return { hasChanges: true, newWatermarkMs: maxTimestampMs };
	}

	async checkConnect(): Promise<void> {
		this.verifiedRootForSync = null;
		await this.ensureRoot();
		const testPath = `_connection_test_${window.crypto.randomUUID()}.txt`;
		const content = new TextEncoder().encode("filen-connection-check");
		let created = false;
		let primaryError: Error | null = null;
		let cleanupError: Error | null = null;

		try {
			created = true;
			await this.writeFile(testPath, content, Date.now(), Date.now());
			const downloaded = await this.readFile(testPath);
			if (
				downloaded.length !== content.length ||
				downloaded.some((byte, i) => byte !== content[i])
			) {
				throw new Error("Connection probe did not return the uploaded bytes.");
			}
		} catch (error) {
			primaryError = normalizeRemoteError(error);
		} finally {
			if (created) {
				try {
					await this.rm(testPath);
				} catch (error) {
					cleanupError = normalizeRemoteError(error);
				}
			}
		}

		if (primaryError !== null) {
			if (cleanupError !== null) {
				throw new Error(
					`${primaryError.message} Probe cleanup also failed: ${cleanupError.message}`,
				);
			}
			throw primaryError;
		}
		if (cleanupError !== null) {
			throw new Error(
				`Connection probe succeeded, but cleanup failed: ${cleanupError.message}`,
			);
		}
	}

	async stat(path: string): Promise<RemoteEntry | null> {
		this.verifiedRootForSync = null;
		validateSyncPath(path);
		const client = await this.getClient();
		const uuid = await client.fs().pathToItemUUID({ path: this.join(path), type: "file" });
		if (uuid === null) return null;
		const file = await client.cloud().getFile({ uuid });
		if (file.trash) return null;
		const rawHash =
			typeof file.metadataDecrypted?.hash === "string"
				? file.metadataDecrypted.hash
				: undefined;
		const remoteHash =
			rawHash !== undefined && isValidFilenSha512(rawHash)
				? normalizeFilenHash(rawHash)
				: undefined;
		return {
			path,
			mtime: normalizeRemoteTimestampMs(file.metadataDecrypted.lastModified),
			size: file.size,
			isDir: false,
			uuid: file.uuid,
			remoteHash,
		};
	}

	async getFileVersions(path: string): Promise<RemoteFileVersion[]> {
		this.verifiedRootForSync = null;
		validateSyncPath(path);
		const client = await this.getClient();
		const uuid = await client.fs().pathToItemUUID({ path: this.join(path), type: "file" });
		if (uuid === null) return [];
		const response = await client.cloud().fileVersions({ uuid });
		return response.versions.map((v) => ({
			uuid: v.uuid,
			version: v.version,
			timestamp: normalizeRemoteTimestampMs(v.timestamp),
			bucket: v.bucket,
			region: v.region,
			chunks: v.chunks,
		}));
	}

	async readFileVersion(version: RemoteFileVersion): Promise<Uint8Array> {
		this.verifiedRootForSync = null;
		const client = await this.getClient();
		const file = await client.cloud().getFile({ uuid: version.uuid });
		return downloadFileChunks(client, {
			uuid: version.uuid,
			bucket: version.bucket,
			region: version.region,
			version: file.version,
			size: file.size,
			chunks: version.chunks,
			key: file.metadataDecrypted.key,
		});
	}

	async restoreFileVersion(path: string, versionUuid: string): Promise<void> {
		this.verifiedRootForSync = null;
		const client = await this.getClient();
		const currentUuid = await client
			.fs()
			.pathToItemUUID({ path: this.join(path), type: "file" });
		if (currentUuid === null) {
			throw new Error("Remote file missing. Sync the file first, then try restore again.");
		}
		await client.cloud().restoreFileVersion({ uuid: versionUuid, currentUUID: currentUuid });
	}

	close(): void {
		this.inMutationSession = false;
		this.verifiedRootForSync = null;
		this.scannedDirectoryUuids = null;
		this.createdDirectoryPaths.clear();
		this.client?.logout();
		this.client = null;
	}

	private async ensureRoot(): Promise<void> {
		await this.getParentUuid("");
	}

	private async getClient(): Promise<FilenSDK> {
		if (this.client !== null) {
			return this.client;
		}

		const client = new FilenSDK(
			{
				metadataCache: true,
				connectToSocket: false,
				...this.config.auth,
			},
			undefined,
			// Route all SDK HTTP requests through Obsidian's requestUrl (Electron
			// main-process net module) to avoid ERR_CERT_AUTHORITY_INVALID that
			// XHR/fetch in the renderer raises for gateway.filen.net.
			createObsidianAxiosLike() as unknown as ConstructorParameters<typeof FilenSDK>[2],
		);
		configureSdkRetryBounds(client);

		if (this.config.auth === null) {
			try {
				await client.login({
					email: this.config.email,
					password: this.config.password,
					twoFactorCode: this.config.twoFactorCode || undefined,
				});
				await this.config.saveAuth(toFilenAuth(client.config));
			} catch (error) {
				throw normalizeRemoteError(error);
			}
		}

		this.client = client;
		return client;
	}

	private get root(): string {
		const value = this.config.remoteRoot.trim();
		const root = value.length === 0 ? "/Obsidian" : value.startsWith("/") ? value : `/${value}`;
		return validateRemoteRoot(root);
	}

	private join(path: string): string {
		const normalized = normalizeRemotePath(path);
		return normalized.length === 0
			? this.root
			: `${this.root.replace(/\/+$/, "")}/${normalized}`;
	}

	private async getParentUuid(path: string): Promise<string> {
		const client = await this.getClient();
		const fs = client.fs();
		const normalized = normalizeRemotePath(path);
		const targetPath = this.join(normalized);
		const existing = await fs.pathToItemUUID({ path: targetPath, type: "directory" });
		if (existing !== null) {
			return existing;
		}

		return fs.mkdir({ path: targetPath });
	}
}

const configureSdkRetryBounds = (sdk: FilenSDK): void => {
	const internal = sdk as unknown as {
		_api?: {
			apiClient?: {
				request: (params: Record<string, unknown>) => Promise<unknown>;
			};
		};
	};
	const apiClient = internal._api?.apiClient;
	if (apiClient === undefined) return;
	const originalRequest = apiClient.request.bind(apiClient);
	apiClient.request = (params) => {
		const endpoint = typeof params.endpoint === "string" ? params.endpoint : "";
		if (endpoint.startsWith("/v3/upload?")) {
			// Mutating chunk retries can outlive a timed-out request. Use one dispatch.
			return originalRequest({ ...params, maxRetries: 1, retryTimeout: 1 });
		}
		if (params.method === "GET" && /^\/[^/]+\/[^/]+\/[^/]+\/\d+$/u.test(endpoint)) {
			// This is the SDK's egest chunk endpoint: retain bounded safe-read retries.
			return originalRequest({ ...params, maxRetries: 3, retryTimeout: 500 });
		}
		return originalRequest(params);
	};
};

const normalizeRemotePath = (path: string): string => path.replace(/^\/+/, "").replace(/\/+$/, "");

const toFilenAuth = (config: unknown): FilenAuth => {
	if (!isRecord(config)) {
		throw new Error("Filen login returned invalid auth config.");
	}

	const authVersion = readAuthVersion(config.authVersion);
	if (authVersion === null) {
		throw new Error("Filen login returned incomplete auth config.");
	}

	const auth: FilenAuth = {
		email: readString(config.email),
		masterKeys: readStringArray(config.masterKeys),
		apiKey: readString(config.apiKey),
		publicKey: readString(config.publicKey),
		privateKey: readString(config.privateKey),
		authVersion,
		baseFolderUUID: readString(config.baseFolderUUID),
		userId: readNumber(config.userId),
	};

	if (
		auth.email.length === 0 ||
		auth.masterKeys.length === 0 ||
		auth.apiKey.length === 0 ||
		auth.publicKey.length === 0 ||
		auth.privateKey.length === 0 ||
		auth.baseFolderUUID.length === 0 ||
		auth.userId <= 0
	) {
		throw new Error("Filen login returned incomplete auth config.");
	}

	return auth;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown, fallback: string = ""): string =>
	typeof value === "string" ? value : fallback;

const readNumber = (value: unknown, fallback: number = 0): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const readStringArray = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const readAuthVersion = (value: unknown): 1 | 2 | 3 | null =>
	value === 1 || value === 2 || value === 3 ? value : null;

const normalizeRemoteTimestampMs = (timestamp: number): number =>
	timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;

const normalizeRemoteError = (error: unknown): Error => {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("Invalid API key")) {
		return new Error("Filen auth expired or invalid. Re-enter password, then sync again.");
	}

	return error instanceof Error ? error : new Error(message);
};

import { FilenSDK } from "@filen/sdk";
import { createObsidianAxiosLike } from "./obsidian-axios-adapter";
import type { FilenAuth } from "./settings";

export type RemoteEntry = {
	path: string;
	mtime: number;
	size: number;
	isDir: boolean;
};

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
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, bytes: Uint8Array, mtime: number, ctime: number): Promise<void>;
	rm(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	checkConnect(): Promise<void>;
	getFileVersions(path: string): Promise<RemoteFileVersion[]>;
	readFileVersion(version: RemoteFileVersion): Promise<Uint8Array>;
	restoreFileVersion(path: string, versionUuid: string): Promise<void>;
	close(): void;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
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

	constructor(private readonly config: FilenRemoteFsConfig) {}

	async walk(): Promise<RemoteEntry[]> {
		const rootUuid = await this.getParentUuid("");
		const cloud = (await this.getClient()).cloud();

		try {
			return this.sortEntries(await this.walkTree(rootUuid, cloud));
		} catch {
			return this.sortEntries(await this.walkRecursive(rootUuid, cloud));
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

			const path = treePath.startsWith("/") ? treePath.slice(1) : treePath;
			if (path.length === 0) {
				continue;
			}

			entries.push({
				path,
				mtime: item.lastModified,
				size: item.size,
				isDir: item.type === "directory",
			});
		}

		return entries;
	}

	private async walkRecursive(
		rootUuid: string,
		cloud: ReturnType<FilenSDK["cloud"]>,
	): Promise<RemoteEntry[]> {
		const visited = new Set<string>([rootUuid]);

		// Cap concurrent listDirectory calls to avoid hitting API rate limits.
		const MAX_CONCURRENT = 16;
		let active = 0;
		const waitQueue: Array<() => void> = [];
		const acquire = (): Promise<void> => {
			if (active < MAX_CONCURRENT) {
				active++;
				return Promise.resolve();
			}
			return new Promise((resolve) => waitQueue.push(resolve));
		};
		const release = (): void => {
			const next = waitQueue.shift();
			if (next) {
				next();
			} else {
				active--;
			}
		};

		const walkDir = async (uuid: string, pathPrefix: string): Promise<RemoteEntry[]> => {
			await acquire();
			let items;
			try {
				items = await cloud.listDirectory({ uuid });
			} finally {
				release();
			}

			const entries: RemoteEntry[] = [];
			const subDirPromises: Promise<RemoteEntry[]>[] = [];

			for (const item of items) {
				const path = pathPrefix.length > 0 ? `${pathPrefix}/${item.name}` : item.name;
				entries.push({
					path,
					mtime: item.lastModified,
					size: item.size,
					isDir: item.type === "directory",
				});
				if (item.type === "directory" && !visited.has(item.uuid)) {
					visited.add(item.uuid);
					subDirPromises.push(walkDir(item.uuid, path));
				}
			}

			const subResults = await Promise.all(subDirPromises);
			return entries.concat(...subResults);
		};

		return walkDir(rootUuid, "");
	}

	private sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
		return entries.sort((left, right) => left.path.localeCompare(right.path));
	}

	async readFile(path: string): Promise<Uint8Array> {
		const fs = (await this.getClient()).fs();
		const content = await fs.readFile({ path: this.join(path) });
		return new Uint8Array(content);
	}

	async writeFile(path: string, bytes: Uint8Array, mtime: number, _ctime: number): Promise<void> {
		const client = await this.getClient();
		const normalized = normalizeRemotePath(path);
		const parent = normalized.includes("/")
			? normalized.slice(0, normalized.lastIndexOf("/"))
			: "";
		const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);

		const parentUuid = await this.getParentUuid(parent);

		const file = new File([toArrayBuffer(bytes)], fileName, { lastModified: mtime });
		await client.cloud().uploadWebFile({
			file,
			parent: parentUuid,
			name: fileName,
		});
		client.init(client.config);
	}

	async rm(path: string): Promise<void> {
		const fs = (await this.getClient()).fs();
		await fs.unlink({ path: this.join(path), permanent: true });
	}

	async mkdir(path: string): Promise<void> {
		const fs = (await this.getClient()).fs();
		await fs.mkdir({ path: this.join(path) });
	}

	async checkConnect(): Promise<void> {
		await this.ensureRoot();
		const testPath = `_connection_test_${Date.now()}.txt`;
		const content = new TextEncoder().encode("ok");
		let created = false;

		try {
			await this.writeFile(testPath, content, Date.now(), Date.now());
			created = true;
		} catch (error) {
			throw normalizeRemoteError(error);
		} finally {
			if (created) {
				try {
					await this.rm(testPath);
				} catch {
					// best-effort cleanup
				}
			}
		}
	}

	async getFileVersions(path: string): Promise<RemoteFileVersion[]> {
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
		const client = await this.getClient();
		const file = await client.cloud().getFile({ uuid: version.uuid });
		const stream = client.cloud().downloadFileToReadableStream({
			uuid: version.uuid,
			bucket: version.bucket,
			region: version.region,
			version: file.version,
			key: file.metadataDecrypted.key,
			size: file.size,
			chunks: version.chunks,
		});
		const reader = stream.getReader();
		const buffers: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value !== undefined) {
				buffers.push(value);
				total += value.byteLength;
			}
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const buf of buffers) {
			out.set(buf, offset);
			offset += buf.byteLength;
		}
		return out;
	}

	async restoreFileVersion(path: string, versionUuid: string): Promise<void> {
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
		if (value.length === 0) {
			return "/Obsidian";
		}

		return value.startsWith("/") ? value : `/${value}`;
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

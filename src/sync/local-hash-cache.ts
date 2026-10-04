import type { TFile } from "obsidian";
import { sha256Hex, sha512Hex } from "./content-hash";

export const LOCAL_HASH_CACHE_TTL_MS = 5 * 60_000;

type Entry = {
	file: TFile;
	mtime: number;
	ctime: number;
	size: number;
	hash: string;
	/** SHA-512 of the exact same verified bytes as `hash`. Cached only when requested. */
	sha512?: string;
	checkedAt: number;
};

export type HashReadResult = {
	hash?: string;
	sha512?: string;
	fromCache: boolean;
};

/** Session cache. Vault events invalidate same-stat edits; periodic full hashing limits missed events. */
export class LocalHashCache {
	private entries = new Map<string, Entry>();
	private generation = 0;

	hashHits = 0;
	hashMisses = 0;
	reads = 0;
	/** Number of bytes read from vault content during hashing (including equality reads). */
	readBytes = 0;

	resetCounters(): void {
		this.hashHits = 0;
		this.hashMisses = 0;
		this.reads = 0;
		this.readBytes = 0;
	}

	invalidate(path: string): void {
		this.generation++;
		for (const key of this.entries.keys()) {
			if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
		}
	}

	clear(): void {
		this.generation++;
		this.entries.clear();
	}

	prune(paths: Set<string>): void {
		for (const key of this.entries.keys()) if (!paths.has(key)) this.entries.delete(key);
	}

	/** Returns the cached fingerprints without reading, if a fresh entry exists. */
	peek(path: string): { hash: string; sha512?: string } | undefined {
		const entry = this.entries.get(path);
		return entry === undefined ? undefined : { hash: entry.hash, sha512: entry.sha512 };
	}

	async read(
		file: TFile,
		readBinary: () => Promise<ArrayBuffer>,
		force: boolean,
	): Promise<string> {
		const result = await this.readBoth(file, readBinary, force, { withSha512: false });
		return result.hash ?? "";
	}

	/**
	 * Reads and hashes a file, optionally deriving SHA-256 and SHA-512 from one
	 * stable binary read so both fingerprints always refer to the same verified
	 * bytes. Cache hits skip the read; a cache entry carrying a SHA-512 is always
	 * paired with the SHA-256 computed from those same bytes.
	 */
	async readBoth(
		file: TFile,
		readBinary: () => Promise<ArrayBuffer>,
		force: boolean,
		opts: { withSha512: boolean },
	): Promise<HashReadResult> {
		const { path } = file;
		const { mtime, ctime, size } = file.stat;
		const cached = this.entries.get(path);
		if (
			!force &&
			cached?.file === file &&
			cached.mtime === mtime &&
			cached.ctime === ctime &&
			cached.size === size &&
			Date.now() - cached.checkedAt < LOCAL_HASH_CACHE_TTL_MS
		) {
			if (!opts.withSha512 || cached.sha512 !== undefined) {
				this.hashHits++;
				return { hash: cached.hash, sha512: cached.sha512, fromCache: true };
			}
			// SHA-512 was never computed for this entry: fall through to a fresh read.
		}
		this.hashMisses++;
		const generation = this.generation;
		const bytes = new Uint8Array(await readBinary());
		this.reads++;
		this.readBytes += size;
		const hash = await sha256Hex(bytes);
		const sha512 = opts.withSha512 ? await sha512Hex(bytes) : undefined;
		if (
			file.path !== path ||
			file.stat.mtime !== mtime ||
			file.stat.ctime !== ctime ||
			file.stat.size !== size
		) {
			throw new Error(`Local file changed while scanning: ${path}. Replan the sync.`);
		}
		if (generation === this.generation)
			this.entries.set(path, { file, mtime, ctime, size, hash, sha512, checkedAt: Date.now() });
		return { hash, sha512, fromCache: false };
	}
}
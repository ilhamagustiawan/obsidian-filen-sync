import type { TFile } from "obsidian";
import { sha256Hex } from "./executor";

export const LOCAL_HASH_CACHE_TTL_MS = 5 * 60_000;

type Entry = {
	file: TFile;
	mtime: number;
	ctime: number;
	size: number;
	hash: string;
	checkedAt: number;
};

/** Session cache. Vault events invalidate same-stat edits; periodic full hashing limits missed events. */
export class LocalHashCache {
	private entries = new Map<string, Entry>();
	private generation = 0;

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

	async read(
		file: TFile,
		readBinary: () => Promise<ArrayBuffer>,
		force: boolean,
	): Promise<string> {
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
		)
			return cached.hash;
		const generation = this.generation;
		const hash = await sha256Hex(new Uint8Array(await readBinary()));
		if (
			file.path !== path ||
			file.stat.mtime !== mtime ||
			file.stat.ctime !== ctime ||
			file.stat.size !== size
		) {
			throw new Error(`Local file changed while scanning: ${path}. Replan the sync.`);
		}
		if (generation === this.generation)
			this.entries.set(path, { file, mtime, ctime, size, hash, checkedAt: Date.now() });
		return hash;
	}
}

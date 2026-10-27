import type { App } from "obsidian";
import { normalizePath, TFile } from "obsidian";
import type { RemoteEntry, RemoteFs } from "../fs-remote";
import type { SyncedFileRecord } from "../settings";
import { isValidFilenSha512 } from "./content-hash";
import { sha256Hex, type LocalEntry } from "./executor";
import type { LocalHashCache } from "./local-hash-cache";
import { readLocalBytes } from "./local-io";

export type EqualityHashResult = {
	resolved: Map<string, string | undefined>;
	comparisons: number;
	downloads: number;
};

/**
 * Resolves equality fingerprints for eligible no-baseline candidates (equal
 * size/mtime with a validated Filen SHA-512). When feasible, local SHA-256 and
 * SHA-512 are derived from one stable binary read so the pair always refers to
 * the same verified bytes. Invalid/missing remote hashes retain the existing
 * equality fallback (remote download for SHA-256 comparison).
 */
export async function resolveEqualityHashes(
	app: App,
	remote: RemoteFs,
	localHashes: LocalHashCache,
	remoteEntries: Iterable<[string, RemoteEntry]>,
	localFiles: Map<string, LocalEntry>,
	prevRecords: Map<string, SyncedFileRecord>,
): Promise<EqualityHashResult> {
	const candidates: Array<{ path: string; entry: RemoteEntry; localEntry: LocalEntry }> = [];
	for (const [path, entry] of remoteEntries) {
		if (entry.isDir) continue;
		const localEntry = localFiles.get(path);
		if (
			localEntry !== undefined &&
			localEntry.size === entry.size &&
			(!prevRecords.has(path) ||
				entry.uuid !== prevRecords.get(path)?.remoteUuid ||
				entry.remoteHash !== prevRecords.get(path)?.remoteHash ||
				entry.mtime !==
					(prevRecords.get(path)?.remoteMtime ?? prevRecords.get(path)?.mtime))
		) {
			candidates.push({ path, entry, localEntry });
		}
	}

	const resolved = new Map<string, string | undefined>();
	let comparisons = 0;
	let downloads = 0;

	for (const { path, entry, localEntry } of candidates) {
		comparisons++;
		const applyFreshLocalHash = (hash?: string, sha512?: string): void => {
			if (hash !== undefined) {
				localEntry.hash = hash;
				localEntry.sha512 = sha512;
			}
		};

		if (entry.remoteHash !== undefined && isValidFilenSha512(entry.remoteHash)) {
			try {
				// Prefer the SHA-512 already derived from the same read as the local
				// SHA-256; otherwise do one fresh read for both fingerprints.
				let fp: { hash?: string; sha512?: string };
				if (localEntry.sha512 !== undefined) {
					fp = { hash: localEntry.hash, sha512: localEntry.sha512 };
				} else {
					const abstractFile = localEntry.adapterOnly
						? localEntry.file
						: app.vault.getAbstractFileByPath(normalizePath(path));
					if (abstractFile instanceof TFile) {
						const r = await localHashes.readBoth(
							abstractFile,
							() => readLocalBytes(app, localEntry),
							false,
							{ withSha512: true },
						);
						fp = { hash: r.hash, sha512: r.sha512 };
					} else {
						fp = { hash: localEntry.hash, sha512: localEntry.sha512 };
					}
				}
				if (fp.sha512 !== undefined && fp.hash !== undefined) {
					if (fp.sha512.toLowerCase() === entry.remoteHash.toLowerCase()) {
						applyFreshLocalHash(fp.hash, fp.sha512);
						resolved.set(path, fp.hash);
					} else {
						applyFreshLocalHash(fp.hash, fp.sha512);
						resolved.set(path, undefined);
					}
				} else {
					resolved.set(path, undefined);
				}
			} catch {
				// Fall through to remote download fallback
				const remoteBytes = await remote.readFile(path, entry.uuid);
				downloads++;
				const remoteSha256 = await sha256Hex(remoteBytes);
				const abstractFile = app.vault.getAbstractFileByPath(normalizePath(path));
				let localSha256: string | undefined = localEntry.hash;
				if (abstractFile instanceof TFile) {
					const r = await localHashes.readBoth(
						abstractFile,
						() => readLocalBytes(app, localEntry),
						false,
						{ withSha512: false },
					);
					localSha256 = r.hash ?? localEntry.hash;
					applyFreshLocalHash(localSha256, r.sha512);
				}
				if (localSha256 !== undefined && localSha256 === remoteSha256) {
					resolved.set(path, localSha256);
				} else {
					resolved.set(path, remoteSha256);
				}
			}
			continue;
		}

		// Fallback: download remote file and compute SHA-256 for the comparison
		const remoteBytes = await remote.readFile(path, entry.uuid);
		downloads++;
		const remoteSha256 = await sha256Hex(remoteBytes);
		const abstractFile = localEntry.adapterOnly
			? localEntry.file
			: app.vault.getAbstractFileByPath(normalizePath(path));
		let localSha256: string | undefined = localEntry.hash;
		if (abstractFile instanceof TFile) {
			const r = await localHashes.readBoth(
				abstractFile,
				() => readLocalBytes(app, localEntry),
				false,
				{ withSha512: false },
			);
			localSha256 = r.hash ?? localEntry.hash;
			applyFreshLocalHash(localSha256, r.sha512);
		}
		if (localSha256 !== undefined && localSha256 === remoteSha256) {
			resolved.set(path, localSha256);
		} else {
			resolved.set(path, remoteSha256);
		}
	}

	return { resolved, comparisons, downloads };
}

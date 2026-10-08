import type { DeletedMapping } from "../db";
import { validateSyncPath, assertNoPathCollisions } from "./path-validation";
export type TrashNode = {
	uuid: string;
	parent: string;
	name: string;
	isDir: boolean;
	size: number;
	deletedAt: number;
};
export type DeletedItem = TrashNode & { path: string; parentMissing: boolean };
/** Fail closed on unknown ancestry; historical membership is scoped by the bound database. */
export async function scopeTrash(
	rootUuid: string,
	nodes: TrashNode[],
	mappings: DeletedMapping[],
	getParent: (
		uuid: string,
	) => Promise<{ parent: string; name: string; trash: boolean } | undefined>,
): Promise<DeletedItem[]> {
	const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
	const mapped = new Map(mappings.map((m) => [m.uuid, m]));
	const result: DeletedItem[] = [];
	for (const node of nodes) {
		let parent = node.parent,
			missing = false;
		const parts = [node.name];
		const seen = new Set([node.uuid]);
		let owned = false;
		for (let depth = 0; depth < 64; depth++) {
			if (parent === rootUuid) {
				owned = true;
				break;
			}
			if (seen.has(parent)) break;
			seen.add(parent);
			const deletedParent = byUuid.get(parent);
			let info: { parent: string; name: string; trash: boolean } | undefined;
			if (deletedParent?.isDir) info = { ...deletedParent, trash: true };
			else {
				try {
					info = await getParent(parent);
				} catch {
					break;
				}
			}
			if (!info) break;
			missing ||= info.trash;
			parts.unshift(info.name);
			parent = info.parent;
		}
		const mapping = mapped.get(node.uuid);
		const path = owned ? parts.join("/") : mapping?.path;
		if (!path) continue;
		try {
			validateSyncPath(path);
			validateSyncPath(node.name);
			if (node.name.includes("/")) continue;
		} catch {
			continue;
		}
		result.push({ ...node, path, parentMissing: missing || !owned });
	}
	// Ambiguous destinations should not be offered as restore actions.
	const safe: DeletedItem[] = [];
	for (const item of result) {
		try {
			assertNoPathCollisions([...safe, item].map((n) => ({ path: n.path, isDir: n.isDir })));
			safe.push(item);
		} catch {
			/* exclude ambiguous entry */
		}
	}
	return safe;
}

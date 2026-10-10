// A durable-clone store and adapter surface for integration fixtures.
export function addConflictStorage(app, db, files) {
	const conflicts = new Map(),
		recoveryBytes = new Map(),
		recoveries = [];
	const clone = (value) => (value === undefined ? undefined : structuredClone(value));
	Object.assign(db, {
		targetKey: db.targetKey ?? "test-target",
		getConflict: async (path) => clone(conflicts.get(path)),
		getConflicts: async () =>
			new Map([...conflicts].map(([path, value]) => [path, clone(value)])),
		setConflict: async (record) => conflicts.set(record.path, clone(record)),
		deleteConflict: async (path) => conflicts.delete(path),
		addRecovery: db.addRecovery ?? (async (record) => recoveries.push(clone(record))),
	});
	const adapter = app.vault.adapter;
	const write = adapter.writeBinary;
	const read = adapter.readBinary;
	adapter.writeBinary = async (path, bytes, ...args) => {
		if (path.includes("/recovery/")) recoveryBytes.set(path, new Uint8Array(bytes).slice());
		else return write(path, bytes, ...args);
	};
	adapter.readBinary = async (path) => {
		if (recoveryBytes.has(path)) return recoveryBytes.get(path).slice().buffer;
		return read ? read(path) : files.get(path).content.slice().buffer;
	};
	adapter.stat ??= async (path) =>
		files.has(path) ? { type: "file", ...files.get(path).stat } : null;
	adapter.trashLocal ??= async (path) => files.delete(path);
	app.vault.getFiles ??= () => [...files.values()];
	return { conflicts, recoveryBytes, recoveries };
}

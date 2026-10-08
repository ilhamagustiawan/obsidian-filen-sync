/** Only object-based core settings and individual plugin data; never executable or workspace files. */
export function selectedSettingsPaths(
	configDir: string,
	pluginId: string,
	enabled = false,
	paths: string[] = [],
): string[] {
	if (!enabled) return [];
	return [
		...new Set(
			paths
				.filter(
					(p) =>
						/^(app|appearance|hotkeys)\.json$/.test(p) ||
						(/^plugins\/[a-zA-Z0-9_-]+\/data\.json$/.test(p) &&
							p !== `plugins/${pluginId}/data.json`),
				)
				.map((p) => `${configDir}/${p}`),
		),
	];
}

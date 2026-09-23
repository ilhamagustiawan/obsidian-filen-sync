export type FilenAuth = {
	email: string;
	masterKeys: string[];
	apiKey: string;
	publicKey: string;
	privateKey: string;
	authVersion: 1 | 2 | 3;
	baseFolderUUID: string;
	userId: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate serialized or freshly derived Filen credentials at the trust boundary. */
export const readFilenAuth = (value: unknown): FilenAuth | null => {
	if (!isRecord(value)) return null;
	const {
		email,
		masterKeys,
		apiKey,
		publicKey,
		privateKey,
		authVersion,
		baseFolderUUID,
		userId,
	} = value;
	if (
		typeof email !== "string" ||
		email.length === 0 ||
		!Array.isArray(masterKeys) ||
		masterKeys.length === 0 ||
		!masterKeys.every((key) => typeof key === "string") ||
		typeof apiKey !== "string" ||
		apiKey.length === 0 ||
		typeof publicKey !== "string" ||
		publicKey.length === 0 ||
		typeof privateKey !== "string" ||
		privateKey.length === 0 ||
		(authVersion !== 1 && authVersion !== 2 && authVersion !== 3) ||
		typeof baseFolderUUID !== "string" ||
		baseFolderUUID.length === 0 ||
		typeof userId !== "number" ||
		!Number.isFinite(userId) ||
		userId <= 0
	) {
		return null;
	}
	return {
		email,
		masterKeys,
		apiKey,
		publicKey,
		privateKey,
		authVersion,
		baseFolderUUID,
		userId,
	};
};

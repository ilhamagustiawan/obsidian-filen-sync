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

type AuthSecretStore = {
	getAuth(): FilenAuth | null;
	setAuth(auth: FilenAuth): void;
	clearAuth(): void;
	hasAuth(): boolean;
};

/**
 * Holds login state that must never be persisted (password, 2FA code, and
 * credentials for "don't remember me" sessions) next to the SecretStorage copy.
 */
export class AuthSession {
	password = "";
	twoFactorCode = "";
	legacyInvalid = false;
	private sessionAuth: FilenAuth | null = null;

	constructor(private readonly secrets: AuthSecretStore) {}

	get current(): FilenAuth | null {
		return this.secrets.getAuth() ?? this.sessionAuth;
	}

	hasAuth(): boolean {
		return this.secrets.hasAuth() || this.sessionAuth !== null;
	}

	/** Write credentials to SecretStorage and read them back to confirm the round trip. */
	persistVerified(auth: FilenAuth): void {
		this.secrets.setAuth(auth);
		if (JSON.stringify(this.secrets.getAuth()) !== JSON.stringify(auth)) {
			throw new Error("Could not verify Filen credentials in SecretStorage.");
		}
	}

	/** Move current credentials between SecretStorage and memory. Returns whether any exist. */
	setRemember(remember: boolean): boolean {
		const auth = this.current;
		if (remember) {
			if (auth !== null) this.persistVerified(auth);
			this.sessionAuth = null;
		} else {
			if (auth !== null) this.sessionAuth = auth;
			this.secrets.clearAuth();
		}
		return auth !== null;
	}

	/** Store freshly derived credentials and drop the one-time login secrets. */
	store(auth: FilenAuth, remember: boolean): void {
		if (remember) {
			this.persistVerified(auth);
			this.sessionAuth = null;
		} else {
			this.sessionAuth = auth;
		}
		this.legacyInvalid = false;
		this.password = "";
		this.twoFactorCode = "";
	}

	clear(): void {
		this.password = "";
		this.twoFactorCode = "";
		this.sessionAuth = null;
	}
}

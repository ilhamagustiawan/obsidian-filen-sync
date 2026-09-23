import { requestUrl } from "obsidian";

// Workaround: the Filen SDK detects Obsidian (Electron renderer) as a browser
// environment and routes all HTTP calls through the injected axiosInstance, which
// defaults to XMLHttpRequest. XHR in Electron's renderer process fails TLS
// certificate validation for gateway.filen.net (ERR_CERT_AUTHORITY_INVALID)
// because Chromium's renderer cert store does not trust that CA. Obsidian's
// requestUrl routes requests through the Electron main-process net module, which
// uses the OS certificate store and properly validates the cert.
//
// Additionally, the SDK's browser-mode buildHeaders() omits Content-Type and
// does not JSON-serialize the request body (real axios handles both via defaults
// and request transformers). This shim replicates that behaviour: it encodes
// JSON bodies as UTF-8 ArrayBuffers — ensuring byte-exact match with the SHA-512
// body checksum the SDK pre-computes — and injects Content-Type: application/json.

// Minimal subset of axios request config that the Filen SDK passes through.
type FilenRequestConfig = {
	headers?: Record<string, string | string[] | undefined>;
	signal?: AbortSignal;
	timeout?: number;
	responseType?: string;
	maxRedirects?: number;
	maxBodyLength?: number;
	maxContentLength?: number;
	onUploadProgress?: (event: { loaded: number }) => void;
	onDownloadProgress?: (event: { loaded: number }) => void;
};

type AxiosLikeResponse = {
	data: unknown;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	config: FilenRequestConfig;
	request: undefined;
};

/** Default deadline for requests where the SDK/caller does not supply one. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
let outstandingMutationRequests = 0;
let reconciliationRequired = false;
let uncertainMutationHandler: (() => Promise<void>) | null = null;

export const getOutstandingMutationRequests = (): number => outstandingMutationRequests;
export const needsRemoteReconciliation = (): boolean => reconciliationRequired;
export const setRemoteReconciliationRequired = (required: boolean): void => {
	reconciliationRequired = required;
};
export const setUncertainMutationHandler = (handler: (() => Promise<void>) | null): void => {
	uncertainMutationHandler = handler;
};

async function doRequest(
	url: string,
	method: string,
	data: unknown,
	config: FilenRequestConfig,
): Promise<AxiosLikeResponse> {
	const endpoint = new URL(url);
	if (endpoint.protocol !== "https:") {
		throw new Error("Filen requests must use HTTPS.");
	}
	if (config.signal?.aborted) throw new Error("Filen request was cancelled.");
	// Copy string-valued headers from config. The SDK (buildHeaders, browser mode)
	// does NOT include Content-Type — real axios adds it from defaults. We add it below.
	const headers: Record<string, string> = {};
	if (config.headers) {
		for (const k of Object.keys(config.headers)) {
			const v = config.headers[k];
			if (typeof v === "string") headers[k] = v;
		}
	}

	let body: ArrayBuffer | undefined;
	if (data !== null && data !== undefined) {
		if (data instanceof ArrayBuffer) {
			body = data;
		} else if (ArrayBuffer.isView(data)) {
			body = toArrayBuffer(data);
		} else {
			// Encode as UTF-8 ArrayBuffer. The Filen API validates a SHA-512 checksum
			// computed as Buffer.from(JSON.stringify(data), "utf-8") — sending as
			// ArrayBuffer guarantees byte-exact match regardless of how requestUrl
			// would otherwise encode a plain string body.
			const str = typeof data === "string" ? data : JSON.stringify(data);
			body = toArrayBuffer(new TextEncoder().encode(str));
			// Real axios injects Content-Type: application/json from its POST defaults.
			// Replicate that here so the server can parse the body correctly.
			if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
				headers["Content-Type"] = "application/json";
			}
		}
	}

	// requestUrl goes through Electron's main-process net module, which uses
	// the OS certificate store. This bypasses ERR_CERT_AUTHORITY_INVALID that
	// occurs when XHR/fetch in the renderer cannot validate gateway.filen.net.
	const request = requestUrl({
		url,
		method: method.toUpperCase(),
		headers,
		body,
		throw: false,
	});
	const timeoutMs =
		config.timeout === undefined
			? DEFAULT_REQUEST_TIMEOUT_MS
			: Number.isFinite(config.timeout) && config.timeout >= 0
				? config.timeout
				: DEFAULT_REQUEST_TIMEOUT_MS;
	const hasDeadline = timeoutMs > 0;
	const isMutation = method.toUpperCase() !== "GET";
	if (isMutation) outstandingMutationRequests += 1;
	let requestSettled = false;
	void request.then(
		() => {
			requestSettled = true;
			if (isMutation) outstandingMutationRequests -= 1;
		},
		() => {
			requestSettled = true;
			if (isMutation) outstandingMutationRequests -= 1;
		},
	);
	let timeoutId: number | undefined;
	let abortListener: (() => void) | undefined;
	const deadline = hasDeadline
		? new Promise<never>((_, reject) => {
				timeoutId = window.setTimeout(
					() => reject(new Error("Filen request timed out.")),
					timeoutMs,
				);
			})
		: new Promise<never>(() => {});
	const cancellation = config.signal
		? new Promise<never>((_, reject) => {
				abortListener = () => reject(new Error("Filen request was cancelled."));
				config.signal?.addEventListener("abort", abortListener, { once: true });
			})
		: new Promise<never>(() => {});
	let res: Awaited<typeof request>;
	try {
		res = await Promise.race([request, deadline, cancellation]);
	} catch (error) {
		if (isMutation && !requestSettled) {
			reconciliationRequired = true;
			await uncertainMutationHandler?.().catch(() => {});
			throw new Error(
				`Filen mutation result is uncertain (${error instanceof Error ? error.message : "request interrupted"}); reconcile before retrying.`,
			);
		}
		throw error;
	} finally {
		if (timeoutId !== undefined) window.clearTimeout(timeoutId);
		if (abortListener !== undefined) config.signal?.removeEventListener("abort", abortListener);
	}

	const rt = config.responseType ?? "json";
	const responseData: unknown =
		rt === "arraybuffer" || rt === "stream" ? res.arrayBuffer : (res.json ?? res.text);

	return {
		data: responseData,
		status: res.status,
		statusText: String(res.status),
		headers: res.headers,
		config,
		request: undefined,
	};
}
const toArrayBuffer = (bytes: ArrayBufferView): ArrayBuffer => {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	return buffer;
};

// Returns an axios-instance-compatible shim. The Filen SDK only calls .post()
// and .get() on the injected axiosInstance (see sdk/dist/browser/api/client.js),
// so we only need to implement those two methods.
export function createObsidianAxiosLike(): {
	post(url: string, data: unknown, config: FilenRequestConfig): Promise<AxiosLikeResponse>;
	get(url: string, config: FilenRequestConfig): Promise<AxiosLikeResponse>;
} {
	return {
		post: (url, data, config) => doRequest(url, "post", data, config),
		get: (url, config) => doRequest(url, "get", undefined, config),
	};
}

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

async function doRequest(
	url: string,
	method: string,
	data: unknown,
	config: FilenRequestConfig,
): Promise<AxiosLikeResponse> {
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
	if (data !== null) {
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
	const res = await requestUrl({
		url,
		method: method.toUpperCase(),
		headers,
		body,
		throw: false,
	});

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

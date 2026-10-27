// Stand-in for node-forge (~280 KB). @filen/sdk only touches forge on its react-native
// paths (RSA keygen and OAEP), never in the browser environment an Obsidian build uses.
// Throws loudly rather than silently misbehaving if that changes.
function unavailable() {
	throw new Error("node-forge is not available in the Obsidian build");
}

const forge = {};
for (const name of ["pki", "md", "util", "asn1", "cipher", "pkcs5", "random"]) {
	Object.defineProperty(forge, name, { get: unavailable, enumerable: false });
}
module.exports = forge;
module.exports.default = module.exports;

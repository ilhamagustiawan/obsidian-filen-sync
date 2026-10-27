// Stand-in for mime-types, which pulls in the ~135 KB mime-db table. @filen/sdk only looks up
// MIME types in uploadLocalFile, uploadWebFile and ChunkedUploadWriter, none of which this
// plugin calls (src/sync/chunk-transfers.ts uploads as application/octet-stream). Returning
// false makes any such lookup fall back to the same "application/octet-stream" default.
module.exports = {
	lookup: () => false,
	contentType: () => false,
	extension: () => false,
	charset: () => false,
	types: {},
	extensions: {},
};
module.exports.default = module.exports;

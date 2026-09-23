import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("manifest.json structure and validation", () => {
	assert.ok(existsSync("manifest.json"), "manifest.json exists");
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.equal(typeof manifest.id, "string");
	assert.ok(manifest.id.length > 0);
	assert.equal(typeof manifest.name, "string");
	assert.equal(typeof manifest.version, "string");
	assert.equal(typeof manifest.minAppVersion, "string");
	assert.equal(typeof manifest.description, "string");
	assert.equal(typeof manifest.isDesktopOnly, "boolean");
});

test("package.json and manifest.json versions match", () => {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.equal(
		pkg.version,
		manifest.version,
		"package.json version matches manifest.json version",
	);
});

test("versions.json contains current version entry", () => {
	assert.ok(existsSync("versions.json"), "versions.json exists");
	const versions = JSON.parse(readFileSync("versions.json", "utf8"));
	const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
	assert.ok(manifest.version in versions, `versions.json contains version ${manifest.version}`);
});

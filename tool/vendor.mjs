#!/usr/bin/env node
/**
 * Copies Entanglement into an app so the app builds and ships on its own,
 * with no path pointing back at this repository.
 *
 *   node tool/vendor.mjs --dart <dir>   Dart/Flutter packages as source
 *                                       (Dart has no compiled form)
 *   node tool/vendor.mjs --ts <dir>     TypeScript packages as built npm
 *                                       tarballs (dist/ + type declarations)
 *   node tool/vendor.mjs --sql <file>   the Supabase server SQL
 *   node tool/vendor.mjs --apps         every app in APPS below (Dart + TS)
 *   node tool/vendor.mjs --status       which apps are behind this repo's HEAD
 *
 * Options combine. Each target directory is replaced wholesale and gets a
 * VENDORED.md recording exactly what was copied, from which commit, and how
 * to update. The docs (docs/*.md) travel with every target.
 *
 * Vendoring refuses uncommitted changes, so the stamp always names a real
 * commit; pass --allow-dirty to try work in progress inside an app.
 *
 * --apps never writes SQL: an applied migration is never rewritten, so a
 * server change goes into a new numbered file, chosen by hand:
 *   node tool/vendor.mjs --sql ../quadra-app/supabase/migrations/NNNN_entanglement.sql
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
if (!args.dart && !args.ts && !args.sql && !args.apps && !args.status) {
	console.error(
		"Usage: node tool/vendor.mjs [--dart <dir>] [--ts <dir>] [--sql <file>] [--apps] [--status] [--allow-dirty]",
	);
	process.exit(1);
}

const stamp = versionStamp();
const DART_PACKAGES = ["entanglement", "entanglement_flutter", "entanglement_supabase"];
const TS_PACKAGES = ["core", "supabase", "expo-sqlite", "tauri-sqlite", "cloudflare"];
const SQL = path.join(root, "packages/entanglement_supabase/supabase/migrations/0001_entanglement.sql");

// Apps that vendor Entanglement, relative to this repo's root.
const APPS = [
	{ name: "quadra-app", kind: "dart", dir: "../quadra-app/vendor/entanglement" },
	{ name: "quadra", kind: "ts", dir: "../quadra/vendor/entanglement" },
	{ name: "trace", kind: "dart", dir: "../trace/vendor/entanglement" },
	{ name: "mille", kind: "ts", dir: "../mille/vendor/entanglement" },
];

if (args.status) {
	printStatus();
	if (!args.dart && !args.ts && !args.sql && !args.apps) process.exit(0);
}
if (stamp.dirty && !args["allow-dirty"]) {
	console.error("Entanglement has uncommitted changes. Commit them first, or pass --allow-dirty.");
	process.exit(1);
}
for (const dir of targets("dart")) vendorDart(dir);
for (const dir of targets("ts")) vendorTs(dir);

if (args.sql) {
	const target = path.resolve(args.sql);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const header =
		`-- Vendored from Entanglement (${stamp.describe}) by tool/vendor.mjs.\n` +
		`-- Do not edit here; change it in Entanglement and re-vendor.\n\n`;
	fs.writeFileSync(target, header + fs.readFileSync(SQL, "utf8"));
	console.log(`sql   -> ${target}`);
}

// ---------------------------------------------------------------------------

function vendorDart(target) {
	reset(target);
	for (const name of DART_PACKAGES) {
		const source = path.join(root, "packages", name);
		const dest = path.join(target, name);
		copyDir(path.join(source, "lib"), path.join(dest, "lib"));
		// Keep dependencies, drop dev-only ones: the app never runs these tests.
		const pubspec = fs.readFileSync(path.join(source, "pubspec.yaml"), "utf8");
		fs.writeFileSync(path.join(dest, "pubspec.yaml"), stripDevDependencies(pubspec));
		const migrations = path.join(source, "supabase");
		if (fs.existsSync(migrations)) copyDir(migrations, path.join(dest, "supabase"));
	}
	copyDocs(target);
	writeManifest(target, "Dart packages (source)", [
		...DART_PACKAGES.map((name) => `\`${name}/\``),
	], [
		"Depend on them by path from the app's pubspec.yaml, e.g.",
		"`entanglement: {path: vendor/entanglement/entanglement}`.",
		"Exclude this folder from the app's analyzer (`analyzer: exclude: [vendor/**]`):",
		"it is third-party code without its own resolved dependencies.",
	]);
	console.log(`dart  -> ${target}`);
}

function vendorTs(target) {
	const ts = path.join(root, "ts");
	run("npx tsc -b packages/core packages/supabase packages/expo-sqlite packages/tauri-sqlite packages/cloudflare", ts);
	reset(target);
	const files = [];
	for (const name of TS_PACKAGES) {
		const output = run(`npm pack --pack-destination "${target}"`, path.join(ts, "packages", name));
		files.push(output.trim().split(/\r?\n/).pop());
	}
	copyDocs(target);
	writeManifest(target, "npm packages (built tarballs)", files.map((file) => `\`${file}\``), [
		"Install them from here so package.json points inside the app:",
		"`npm install " + files.map((file) => `./${path.relative(path.dirname(target), path.join(target, file)).replace(/\\/g, "/")}`).join(" ") + " --force`",
		"(`--force` because a re-vendored tarball keeps its version but changes its contents).",
	]);
	console.log(`ts    -> ${target} (${files.join(", ")})`);
}

// ---------------------------------------------------------------------------

function copyDocs(target) {
	const docs = path.join(root, "docs");
	const dest = path.join(target, "docs");
	fs.mkdirSync(dest, { recursive: true });
	for (const file of fs.readdirSync(docs)) {
		if (file.endsWith(".md")) fs.copyFileSync(path.join(docs, file), path.join(dest, file));
	}
}

function writeManifest(target, kind, contents, usage) {
	const text = `# Vendored Entanglement

Copied from the Entanglement repository by \`tool/vendor.mjs\`. **Do not edit
anything in this folder**: change Entanglement and re-vendor, so every app
stays on the same code.

- Source: ${stamp.describe}
- Vendored: ${new Date().toISOString()}
- Kind: ${kind}
- Contents: ${contents.join(", ")}, \`docs/\`

## Using it

${usage.join("\n")}

## Updating

Commit the change in Entanglement, then from its root:

\`\`\`bash
node tool/vendor.mjs --apps     # re-vendor every app; --status shows who is behind
\`\`\`

Then re-resolve dependencies in the app, run its tests, and commit this folder
together with any app changes the new version needs.

Start with \`docs/how-it-works.md\`.
`;
	fs.writeFileSync(path.join(target, "VENDORED.md"), text);
}

function stripDevDependencies(pubspec) {
	const lines = pubspec.split(/\r?\n/);
	const out = [];
	let skipping = false;
	for (const line of lines) {
		if (/^dev_dependencies:/.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping && /^\S/.test(line)) skipping = false;
		if (!skipping) out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function versionStamp() {
	let commit = "no commits yet";
	let dirty = false;
	try {
		dirty = run("git status --porcelain", root).trim().length > 0;
		commit = run("git rev-parse --short HEAD", root).trim();
	} catch {
		// Not a git checkout, or no commits yet.
	}
	return { commit, dirty, describe: `Entanglement @ ${commit}${dirty ? " + uncommitted changes" : ""}` };
}

/** The directories to vendor [kind] into: any given explicitly, plus the apps. */
function targets(kind) {
	const dirs = args[kind] ? [args[kind]] : [];
	if (args.apps) dirs.push(...APPS.filter((app) => app.kind === kind).map((app) => path.join(root, app.dir)));
	return dirs.map((dir) => path.resolve(dir));
}

function printStatus() {
	console.log(`Entanglement is at ${stamp.describe.replace("Entanglement @ ", "")}`);
	for (const app of APPS) {
		const manifest = path.join(root, app.dir, "VENDORED.md");
		const source = fs.existsSync(manifest)
			? /^- Source: Entanglement @ (.+)$/m.exec(fs.readFileSync(manifest, "utf8"))?.[1]
			: undefined;
		const state = !source
			? "not vendored"
			: source === stamp.commit && !stamp.dirty
				? "up to date"
				: `vendored from ${source}; run --apps to update`;
		console.log(`  ${app.name.padEnd(12)} ${state}`);
	}
}

function reset(target) {
	fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(target, { recursive: true });
}

function copyDir(from, to) {
	fs.cpSync(from, to, { recursive: true });
}

function run(command, cwd) {
	return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseArgs(argv) {
	const FLAGS = new Set(["apps", "status", "allow-dirty"]);
	const out = {};
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index].replace(/^--/, "");
		out[key] = FLAGS.has(key) ? true : argv[++index];
	}
	return out;
}

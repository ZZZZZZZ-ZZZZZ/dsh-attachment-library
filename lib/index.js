import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { dshCachePath, dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { canOpenNativePath, nativeFileApplications, nativeFileManager, openNativeFileApplication, revealNativePath } from "@deepseek-ai/dsh-native-command";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
//#region src/library.ts
const ATTACHMENT_ID$1 = /^sha256:([0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PREFIX = /^[0-9a-f]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING_FILE = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const GENERATION = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
/** Bytes read from an image object to find its dimensions. */
const PROBE_BYTES = 65536;
/** Nesting depth the reference scan descends into one event. */
const MAX_DEPTH = 64;
/** Identity of one stored attachment: its kind and content digest. */
function attachmentKey(kind, sha256) {
	return `${kind}:${sha256}`;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function count(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function referenceOf(value) {
	const kind = value.type;
	if (kind !== "image" && kind !== "file") return void 0;
	const attachment = value.attachment;
	if (!isRecord(attachment) || typeof attachment.attachmentId !== "string") return void 0;
	const sha256 = ATTACHMENT_ID$1.exec(attachment.attachmentId)?.[1];
	if (sha256 === void 0) return void 0;
	const name = typeof attachment.name === "string" && attachment.name !== "" ? attachment.name : void 0;
	const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType : void 0;
	const width = positiveInteger(attachment.width);
	const height = positiveInteger(attachment.height);
	const bytes = count(attachment.bytes);
	return {
		kind,
		sha256,
		...name === void 0 ? {} : { name },
		...kind === "image" && mediaType !== void 0 ? { mediaType } : {},
		...kind === "image" && width !== void 0 && height !== void 0 ? {
			width,
			height
		} : {},
		...bytes === void 0 ? {} : { bytes }
	};
}
/** Accumulates references and the latest title over a log's events in order. */
var LogScanner = class {
	refs = /* @__PURE__ */ new Map();
	title;
	/**
	* Scan one event (or physical row) for attachment references and titles.
	* @param event - a parsed event value.
	*/
	add(event) {
		if (isRecord(event) && event.type === "session/title" && isRecord(event.data) && typeof event.data.title === "string" && event.data.title !== "") this.title = event.data.title;
		const stack = [{
			value: event,
			depth: 0
		}];
		while (stack.length > 0) {
			const { value, depth } = stack.pop();
			if (depth > MAX_DEPTH || typeof value !== "object" || value === null) continue;
			if (Array.isArray(value)) {
				for (const item of value) stack.push({
					value: item,
					depth: depth + 1
				});
				continue;
			}
			const record = value;
			const ref = referenceOf(record);
			if (ref !== void 0) {
				const key = attachmentKey(ref.kind, ref.sha256);
				if (!this.refs.has(key)) this.refs.set(key, ref);
				continue;
			}
			for (const child of Object.values(record)) stack.push({
				value: child,
				depth: depth + 1
			});
		}
	}
	/** @returns the facts gathered so far. */
	result() {
		return {
			refs: [...this.refs.values()],
			...this.title === void 0 ? {} : { title: this.title }
		};
	}
};
/**
* Scan a complete event list.
* @param events - events in log order.
* @returns references and the latest title.
*/
function scanEvents(events) {
	const scanner = new LogScanner();
	for (const event of events) scanner.add(event);
	return scanner.result();
}
function isErrno(error, ...codes) {
	return codes.includes(error?.code ?? "");
}
async function listDir(path) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (isErrno(error, "ENOENT", "ENOTDIR")) return [];
		throw error;
	}
}
const ZSTD_MAGIC = 4247762216;
/**
* End offset of the Zstandard frame starting at `start`, found from the frame
* and block headers without decompressing; `undefined` when the buffer ends
* inside the frame or the header is not a frame.
*/
function zstdFrameEnd(buffer, start) {
	let offset = start;
	if (offset + 4 > buffer.length) return void 0;
	const magic = buffer.readUInt32LE(offset);
	offset += 4;
	if ((magic & 4294967280) === 407710288) {
		if (offset + 4 > buffer.length) return void 0;
		const end = offset + 4 + buffer.readUInt32LE(offset);
		return end <= buffer.length ? end : void 0;
	}
	if (magic !== ZSTD_MAGIC || offset >= buffer.length) return void 0;
	const descriptor = buffer[offset];
	offset += 1;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryBytes = [
		0,
		1,
		2,
		4
	][descriptor & 3];
	const contentSizeBytes = [
		singleSegment ? 1 : 0,
		2,
		4,
		8
	][descriptor >> 6];
	offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	for (;;) {
		if (offset + 3 > buffer.length) return void 0;
		const header = buffer.readUIntLE(offset, 3);
		offset += 3;
		const type = header >> 1 & 3;
		if (type === 3) return void 0;
		offset += type === 1 ? 1 : header >> 3;
		if (offset > buffer.length) return void 0;
		if ((header & 1) !== 0) break;
	}
	offset += checksum ? 4 : 0;
	return offset <= buffer.length ? offset : void 0;
}
/**
* Decode a concatenated-frame Zstandard log frame by frame. A final frame cut
* short (an interrupted append) or a frame that fails its checksum ends the
* readable part.
*/
function decodeZstd(buffer) {
	const parts = [];
	let offset = 0;
	while (offset < buffer.length) {
		const end = zstdFrameEnd(buffer, offset);
		if (end === void 0) return {
			text: Buffer.concat(parts),
			complete: false
		};
		try {
			parts.push(zstdDecompressSync(buffer.subarray(offset, end)));
		} catch {
			return {
				text: Buffer.concat(parts),
				complete: false
			};
		}
		offset = end;
	}
	return {
		text: Buffer.concat(parts),
		complete: true
	};
}
/**
* Read one raw or Zstandard-compressed JSONL session log and scan its rows.
* @param path - the log file.
* @returns references, title, and how much could not be read.
*/
async function scanLogFile(path) {
	const bytes = await readFile(path);
	const decoded = path.endsWith(".zstd") ? decodeZstd(bytes) : {
		text: bytes,
		complete: true
	};
	const scanner = new LogScanner();
	let skippedLines = 0;
	const lines = decoded.text.toString("utf8").split("\n");
	const last = lines.pop();
	if (last !== void 0 && last.trim() !== "") skippedLines += 1;
	for (const line of lines) {
		if (line.trim() === "") continue;
		try {
			scanner.add(JSON.parse(line));
		} catch {
			skippedLines += 1;
		}
	}
	return {
		...scanner.result(),
		skippedLines,
		truncated: !decoded.complete
	};
}
/**
* Pick the log the session backend would read: the highest canonical generation.
* @param dir - a session directory.
* @returns the log path, or `undefined` when the directory holds none.
*/
async function currentGeneration(dir) {
	let best;
	for (const entry of await listDir(dir)) {
		if (!entry.isFile()) continue;
		const match = GENERATION.exec(entry.name);
		if (match === null) continue;
		const version = match[1] === void 0 ? 0 : Number(match[1]);
		const compressed = match[2] !== void 0;
		if (best === void 0 || version > best.version || version === best.version && compressed && !best.compressed) best = {
			version,
			compressed,
			name: entry.name
		};
	}
	return best === void 0 ? void 0 : join(dir, best.name);
}
/** Change token for a file: equal tokens mean an unchanged file. */
async function fileToken(path) {
	const info = await stat(path, { bigint: true });
	return `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
}
/**
* Read PNG, JPEG, WebP, or GIF dimensions from the first bytes of an image.
* @param header - leading bytes of the image.
* @returns the format and size, or `undefined` when the header is not recognized.
*/
function probeImage(header) {
	const sized = (mediaType, width, height) => width > 0 && height > 0 ? {
		mediaType,
		width,
		height
	} : void 0;
	if (header.length >= 24 && header.readUInt32BE(0) === 2303741511 && header.readUInt32BE(4) === 218765834) return sized("image/png", header.readUInt32BE(16), header.readUInt32BE(20));
	if (header.length >= 10 && header.toString("latin1", 0, 4) === "GIF8") return sized("image/gif", header.readUInt16LE(6), header.readUInt16LE(8));
	if (header.length >= 30 && header.toString("latin1", 0, 4) === "RIFF" && header.toString("latin1", 8, 12) === "WEBP") {
		const chunk = header.toString("latin1", 12, 16);
		if (chunk === "VP8 ") return sized("image/webp", header.readUInt16LE(26) & 16383, header.readUInt16LE(28) & 16383);
		if (chunk === "VP8L" && header[20] === 47) {
			const bits = header.readUInt32LE(21);
			return sized("image/webp", (bits & 16383) + 1, (bits >>> 14 & 16383) + 1);
		}
		if (chunk === "VP8X") return sized("image/webp", header.readUIntLE(24, 3) + 1, header.readUIntLE(27, 3) + 1);
		return;
	}
	if (header.length >= 4 && header[0] === 255 && header[1] === 216) {
		let offset = 2;
		while (offset + 9 <= header.length) {
			if (header[offset] !== 255) return void 0;
			const marker = header[offset + 1];
			if (marker === 255) {
				offset += 1;
				continue;
			}
			if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
				offset += 2;
				continue;
			}
			if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) return sized("image/jpeg", header.readUInt16BE(offset + 7), header.readUInt16BE(offset + 5));
			offset += 2 + header.readUInt16BE(offset + 2);
		}
	}
}
/**
* Read an image file's header and recognize its format and size.
* @param path - the image file.
* @returns the probe, or `undefined` when the header is not a supported format.
*/
async function imageHeader(path) {
	return probeImage(await readHead(path));
}
async function readHead(path) {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(PROBE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, PROBE_BYTES, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}
async function objectsIn(storeDir) {
	const found = [];
	for (const prefix of await listDir(storeDir)) {
		if (!prefix.isDirectory() || !PREFIX.test(prefix.name)) continue;
		for (const entry of await listDir(join(storeDir, prefix.name))) {
			if (!entry.isFile() || !HEX64.test(entry.name) || !entry.name.startsWith(prefix.name)) continue;
			found.push({
				sha256: entry.name,
				path: join(storeDir, prefix.name, entry.name)
			});
		}
	}
	return found;
}
/**
* Stat an image object and read its header, reusing a cached probe while the
* file is unchanged.
* @param path - the object path.
* @param probes - header-probe cache.
* @returns the facts, or `undefined` when the path is absent or not a plain file.
*/
async function inspectImage(path, probes) {
	let info;
	try {
		info = await lstat(path, { bigint: true });
	} catch (error) {
		if (isErrno(error, "ENOENT", "ENOTDIR")) return void 0;
		throw error;
	}
	if (!info.isFile()) return void 0;
	const token = `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
	let cached = probes.get(path);
	if (cached?.token !== token) {
		let probe;
		try {
			probe = probeImage(await readHead(path));
		} catch (error) {
			if (!isErrno(error, "ENOENT", "EACCES", "EPERM")) throw error;
		}
		cached = {
			token,
			probe
		};
		probes.set(path, cached);
	}
	return {
		sizeBytes: Number(info.size),
		storedAt: Number(info.mtimeMs),
		...cached.probe === void 0 ? {} : { probe: cached.probe }
	};
}
/** Whether `child` is strictly inside `parent` (both absolute). */
function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/** A path that exists as a plain file (not a link), below plain directories (not links), inside `root`. */
async function plainFileInside(root, path) {
	try {
		if (!(await lstat(path)).isFile()) return false;
		for (let dir = dirname(path); isInside(root, dir); dir = dirname(dir)) if (!(await lstat(dir)).isDirectory()) return false;
		const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
		return isInside(realRoot, realPath);
	} catch (error) {
		if (isErrno(error, "ENOENT", "ENOTDIR")) return false;
		throw error;
	}
}
/**
* The file to show in a file manager for one stored attachment, derived from
* its kind and digest only. An image is its object; a file is its first
* display-name link (so the file manager shows the real name), or the
* canonical object when no link exists.
* @param root - `<DSH_HOME>/attachments/v1`.
* @param kind - image or file store.
* @param sha256 - 64 lowercase hex digits.
* @returns the absolute path of a plain file inside `root`, or `undefined` when none is stored.
*/
async function revealTarget(root, kind, sha256) {
	if (!HEX64.test(sha256)) return void 0;
	const prefix = sha256.slice(0, 2);
	const candidates = [];
	if (kind === "image") candidates.push(join(root, "objects", prefix, sha256));
	else {
		const aliases = join(root, "files", prefix, sha256);
		for (const entry of (await listDir(aliases)).filter((item) => item.isFile()).map((item) => item.name).sort()) candidates.push(join(aliases, entry));
		candidates.push(join(root, "file-objects", prefix, sha256));
	}
	for (const candidate of candidates) if (await plainFileInside(root, candidate)) return candidate;
}
/**
* List every image and file object under an attachment root. Missing
* directories count as empty; entries that are not plain files are skipped.
* @param root - `<DSH_HOME>/attachments/v1`.
* @param probes - header-probe cache reused across scans.
* @returns the stored objects.
*/
async function listStoredObjects(root, probes = /* @__PURE__ */ new Map()) {
	const objects = [];
	const seen = /* @__PURE__ */ new Set();
	for (const { sha256, path } of await objectsIn(join(root, "objects"))) {
		const image = await inspectImage(path, probes);
		if (image === void 0) continue;
		seen.add(path);
		objects.push({
			kind: "image",
			sha256,
			sizeBytes: image.sizeBytes,
			storedAt: image.storedAt,
			names: [],
			...image.probe === void 0 ? {} : { probe: image.probe }
		});
	}
	for (const path of [...probes.keys()]) if (!seen.has(path)) probes.delete(path);
	for (const { sha256, path } of await objectsIn(join(root, "file-objects"))) {
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (isErrno(error, "ENOENT")) continue;
			throw error;
		}
		if (!info.isFile()) continue;
		const names = (await listDir(join(root, "files", sha256.slice(0, 2), sha256))).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
		objects.push({
			kind: "file",
			sha256,
			sizeBytes: info.size,
			storedAt: info.mtimeMs,
			names
		});
	}
	return objects;
}
/**
* Total bytes of plain files below a directory (symbolic links are not followed).
* @param dir - the directory; a missing one counts as 0.
* @returns byte total.
*/
async function directoryBytes(dir) {
	let total = 0;
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of await listDir(current)) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) try {
				total += (await lstat(path)).size;
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			}
		}
	}
	return total;
}
function isSegment(value) {
	return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}
function parseManifest(value, entryId, entryDir) {
	if (!isRecord(value) || value.version !== 1 || value.entryId !== entryId) throw new Error("unrecognized manifest");
	if (typeof value.sessionId !== "string" || value.sessionId === "" || typeof value.title !== "string") throw new Error("manifest lacks the conversation");
	const deletedAt = count(value.deletedAt);
	if (deletedAt === void 0 || !Array.isArray(value.sessions)) throw new Error("manifest lacks its sessions");
	const sessions = value.sessions.map((item) => {
		if (!isRecord(item) || typeof item.sessionId !== "string" || !isSegment(item.project) || !isSegment(item.dirName)) throw new Error("manifest has an invalid session record");
		return {
			sessionId: item.sessionId,
			dir: join(entryDir, item.project, item.dirName)
		};
	});
	return {
		entryId,
		sessionId: value.sessionId,
		title: value.title,
		deletedAt,
		sessions
	};
}
/**
* Read the trash entries and pending moves of `dsh-plugin-session-trash`.
* A missing directory is an empty trash.
* @param trashRoot - the trash directory.
* @returns entries, pending moves, and unreadable items.
*/
async function readTrash(trashRoot) {
	const entries = [];
	const pending = [];
	const problems = [];
	for (const item of await listDir(trashRoot)) {
		const pendingId = PENDING_FILE.exec(item.name)?.[1];
		try {
			if (pendingId !== void 0 && item.isFile()) {
				const record = JSON.parse(await readFile(join(trashRoot, item.name), "utf8"));
				if (!isRecord(record) || typeof record.sessionId !== "string" || typeof record.title !== "string") throw new Error("unrecognized pending move");
				pending.push({
					sessionId: record.sessionId,
					title: record.title
				});
			} else if (UUID.test(item.name) && item.isDirectory()) {
				const dir = join(trashRoot, item.name);
				entries.push(parseManifest(JSON.parse(await readFile(join(dir, "entry.json"), "utf8")), item.name, dir));
			}
		} catch (error) {
			problems.push({
				id: pendingId ?? item.name,
				reason: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return {
		entries,
		pending,
		problems
	};
}
//#endregion
//#region src/catalog.ts
const STATUS_ORDER = {
	normal: 0,
	archived: 1,
	"pending-trash": 2,
	trash: 3
};
function usageOf(references) {
	if (references.length === 0) return "unreferenced";
	return references.some((reference) => reference.status !== "trash") ? "active" : "trash-only";
}
function add(bucket, bytes) {
	bucket.count += 1;
	bucket.bytes += bytes;
}
/**
* Build the library rows: every stored object, plus every referenced
* attachment the store lacks. A conversation appears once per attachment
* even when several of its sessions (subagents, forks) reference it.
* @param objects - stored image and file objects.
* @param logs - references of each scanned session log.
* @returns rows (newest first) and totals.
*/
function buildCatalog(objects, logs) {
	const rows = /* @__PURE__ */ new Map();
	const row = (kind, sha256) => {
		const key = attachmentKey(kind, sha256);
		let found = rows.get(key);
		if (found === void 0) {
			found = {
				kind,
				sha256,
				names: /* @__PURE__ */ new Set(),
				refs: /* @__PURE__ */ new Map()
			};
			rows.set(key, found);
		}
		return found;
	};
	for (const object of objects) {
		const target = row(object.kind, object.sha256);
		target.stored = object;
		for (const name of object.names) target.names.add(name);
	}
	for (const log of logs) for (const ref of log.refs) {
		const target = row(ref.kind, ref.sha256);
		target.first ??= ref;
		if (ref.name !== void 0) target.names.add(ref.name);
		if (!target.refs.has(log.conversation.key)) target.refs.set(log.conversation.key, log.conversation.view);
	}
	const totals = {
		total: {
			count: 0,
			bytes: 0
		},
		images: {
			count: 0,
			bytes: 0
		},
		files: {
			count: 0,
			bytes: 0
		},
		active: {
			count: 0,
			bytes: 0
		},
		trashOnly: {
			count: 0,
			bytes: 0
		},
		unreferenced: {
			count: 0,
			bytes: 0
		}
	};
	let missing = 0;
	const attachments = [];
	for (const item of rows.values()) {
		const references = [...item.refs.values()].sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || (left.title ?? "").localeCompare(right.title ?? ""));
		const usage = usageOf(references);
		const stored = item.stored;
		const size = stored?.sizeBytes ?? item.first?.bytes ?? 0;
		if (stored === void 0) missing += 1;
		else {
			add(totals.total, size);
			add(item.kind === "image" ? totals.images : totals.files, size);
			add(usage === "active" ? totals.active : usage === "trash-only" ? totals.trashOnly : totals.unreferenced, size);
		}
		const mediaType = item.first?.mediaType ?? stored?.probe?.mediaType;
		const width = item.first?.width ?? stored?.probe?.width;
		const height = item.first?.height ?? stored?.probe?.height;
		attachments.push({
			kind: item.kind,
			attachmentId: `sha256:${item.sha256}`,
			names: [...item.names].sort(),
			sizeBytes: size,
			...stored === void 0 ? {} : { storedAt: Math.floor(stored.storedAt) },
			...item.kind === "image" && mediaType !== void 0 ? { mediaType } : {},
			...item.kind === "image" && width !== void 0 && height !== void 0 ? {
				width,
				height
			} : {},
			missing: stored === void 0,
			usage,
			references
		});
	}
	attachments.sort((left, right) => (right.storedAt ?? 0) - (left.storedAt ?? 0) || left.attachmentId.localeCompare(right.attachmentId));
	return {
		attachments,
		...totals,
		missing
	};
}
//#endregion
//#region src/preview.ts
/**
* Read-only copies of stored images for "Open in Preview". DSH stores an image
* as `objects/<prefix>/<sha256>`: no extension, so macOS cannot tell it is an
* image, and the object belongs to DSH. Preview therefore opens a copy, never
* the object: the copy has the extension of its format, is read-only (0400),
* and lives in a private temporary directory (0700) this plugin creates
* outside DSH data. That directory is the plugin's only write anywhere, and it
* is removed when the plugin stops.
*/
const EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif"
};
/**
* File extension for an image format.
* @param mediaType - format read from the image header.
* @returns the extension without a dot, or `undefined` for other formats.
*/
function previewExtension(mediaType) {
	return EXTENSIONS[mediaType];
}
/** Copies for Preview inside one private temporary directory. */
var PreviewCopies = class {
	parent;
	directory;
	/** @param parent - directory to create the private temporary directory in. */
	constructor(parent) {
		this.parent = parent;
	}
	/**
	* Copy one stored image, verifying that its bytes match its digest. An
	* earlier copy of the same image is reused.
	* @param source - the stored object (already checked to be a plain file in the store).
	* @param sha256 - the object's digest.
	* @param mediaType - format read from the object's header.
	* @returns the read-only copy's path.
	*/
	async copy(source, sha256, mediaType) {
		const extension = previewExtension(mediaType);
		if (extension === void 0) throw new Error(`unsupported image format ${mediaType}`);
		this.directory ??= mkdir(this.parent, { recursive: true }).then(() => mkdtemp(join(this.parent, "dsh-attachment-preview-")));
		const target = join(await this.directory, `${sha256.slice(0, 16)}.${extension}`);
		try {
			if ((await lstat(target)).isFile()) return target;
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const data = await readFile(source);
		if (createHash("sha256").update(data).digest("hex") !== sha256) throw new Error("stored image does not match its digest");
		await writeFile(target, data, {
			flag: "wx",
			mode: 256
		});
		return target;
	}
	/** The private directory, once created. */
	async location() {
		return this.directory;
	}
	/** Remove the private directory and every copy in it. */
	async dispose() {
		const directory = this.directory;
		this.directory = void 0;
		if (directory === void 0) return;
		await rm(await directory, {
			recursive: true,
			force: true
		});
	}
};
//#endregion
//#region src/protocol.ts
/** Typert namespace and Cordis service key of the library service. */
const ATTACHMENT_LIBRARY_NAMESPACE = "attachmentLibrary";
/** npm package that owns the Remote methods. */
const ATTACHMENT_LIBRARY_PACKAGE = "dsh-plugin-attachment-library";
function strict(typeSymbol, parse) {
	const schema = { parse };
	return {
		mode: "strict",
		typeSymbol,
		create: () => schema
	};
}
function record(value, what) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
	return value;
}
function exactKeys(value, required, optional, what) {
	for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`);
	for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`);
}
function text(value, what, maxLength, allowEmpty = false) {
	if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.length > maxLength) throw new TypeError(`${what} must be a string of at most ${String(maxLength)} characters`);
	return value;
}
function integer(value, what) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${what} must be a non-negative integer`);
	return value;
}
function time(value, what) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${what} must be a non-negative number`);
	return value;
}
function array(value, what, parse) {
	if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
	return value.map((item, index) => parse(item, `${what}[${String(index)}]`));
}
function oneOf(value, allowed, what) {
	if (!allowed.includes(value)) throw new TypeError(`${what} must be one of ${allowed.join(", ")}`);
	return value;
}
const ATTACHMENT_ID = /^sha256:[0-9a-f]{64}$/;
const STATUSES = [
	"normal",
	"archived",
	"pending-trash",
	"trash"
];
const USAGES = [
	"active",
	"trash-only",
	"unreferenced"
];
function parseReference(value, what) {
	const body = record(value, what);
	exactKeys(body, ["sessionId", "status"], ["title", "deletedAt"], what);
	return {
		sessionId: text(body.sessionId, `${what}.sessionId`, 512),
		...body.title === void 0 ? {} : { title: text(body.title, `${what}.title`, 1e3) },
		status: oneOf(body.status, STATUSES, `${what}.status`),
		...body.deletedAt === void 0 ? {} : { deletedAt: time(body.deletedAt, `${what}.deletedAt`) }
	};
}
function parseAttachment(value, what) {
	const body = record(value, what);
	exactKeys(body, [
		"kind",
		"attachmentId",
		"names",
		"sizeBytes",
		"missing",
		"usage",
		"references"
	], [
		"storedAt",
		"mediaType",
		"width",
		"height"
	], what);
	if (typeof body.attachmentId !== "string" || !ATTACHMENT_ID.test(body.attachmentId)) throw new TypeError(`${what}.attachmentId must be a sha256 id`);
	if (typeof body.missing !== "boolean") throw new TypeError(`${what}.missing must be a boolean`);
	return {
		kind: oneOf(body.kind, ["image", "file"], `${what}.kind`),
		attachmentId: body.attachmentId,
		names: array(body.names, `${what}.names`, (item, label) => text(item, label, 1e3)),
		sizeBytes: integer(body.sizeBytes, `${what}.sizeBytes`),
		...body.storedAt === void 0 ? {} : { storedAt: time(body.storedAt, `${what}.storedAt`) },
		...body.mediaType === void 0 ? {} : { mediaType: text(body.mediaType, `${what}.mediaType`, 100) },
		...body.width === void 0 ? {} : { width: integer(body.width, `${what}.width`) },
		...body.height === void 0 ? {} : { height: integer(body.height, `${what}.height`) },
		missing: body.missing,
		usage: oneOf(body.usage, USAGES, `${what}.usage`),
		references: array(body.references, `${what}.references`, parseReference)
	};
}
function parseBucket(value, what) {
	const body = record(value, what);
	exactKeys(body, ["count", "bytes"], [], what);
	return {
		count: integer(body.count, `${what}.count`),
		bytes: integer(body.bytes, `${what}.bytes`)
	};
}
function parseSummary(value) {
	const body = record(value, "summary");
	const buckets = [
		"total",
		"images",
		"files",
		"active",
		"trashOnly",
		"unreferenced"
	];
	const numbers = [
		"missing",
		"requestCacheBytes",
		"liveSessions",
		"trashSessions"
	];
	exactKeys(body, [...buckets, ...numbers], [], "summary");
	return {
		total: parseBucket(body.total, "summary.total"),
		images: parseBucket(body.images, "summary.images"),
		files: parseBucket(body.files, "summary.files"),
		active: parseBucket(body.active, "summary.active"),
		trashOnly: parseBucket(body.trashOnly, "summary.trashOnly"),
		unreferenced: parseBucket(body.unreferenced, "summary.unreferenced"),
		missing: integer(body.missing, "summary.missing"),
		requestCacheBytes: integer(body.requestCacheBytes, "summary.requestCacheBytes"),
		liveSessions: integer(body.liveSessions, "summary.liveSessions"),
		trashSessions: integer(body.trashSessions, "summary.trashSessions")
	};
}
function parseProblem(value, what) {
	const body = record(value, what);
	exactKeys(body, [
		"id",
		"where",
		"reason"
	], [], what);
	return {
		id: text(body.id, `${what}.id`, 512),
		where: oneOf(body.where, ["live", "trash"], `${what}.where`),
		reason: text(body.reason, `${what}.reason`, 4e3, true)
	};
}
/**
* Validate a scan result from the wire.
* @param value - untrusted value.
* @returns the result.
*/
function parseLibraryResult(value) {
	const body = record(value, "result");
	exactKeys(body, [
		"summary",
		"attachments",
		"problems",
		"scannedAt",
		"reread"
	], [], "result");
	const reread = record(body.reread, "result.reread");
	exactKeys(reread, ["live", "trash"], [], "result.reread");
	return {
		summary: parseSummary(body.summary),
		attachments: array(body.attachments, "result.attachments", parseAttachment),
		problems: array(body.problems, "result.problems", parseProblem),
		scannedAt: time(body.scannedAt, "result.scannedAt"),
		reread: {
			live: integer(reread.live, "result.reread.live"),
			trash: integer(reread.trash, "result.reread.trash")
		}
	};
}
/**
* Validate an attachment id: exactly `sha256:` and 64 lowercase hex digits,
* so it can never name a path.
* @param value - untrusted value.
* @returns the id.
*/
function parseAttachmentId(value) {
	if (typeof value !== "string" || !ATTACHMENT_ID.test(value)) throw new TypeError("attachmentId must be \"sha256:\" followed by 64 lowercase hex digits");
	return value;
}
function parseRevealRequest(value) {
	const body = record(value, "request");
	exactKeys(body, ["kind", "attachmentId"], [], "request");
	return {
		kind: oneOf(body.kind, ["image", "file"], "request.kind"),
		attachmentId: parseAttachmentId(body.attachmentId)
	};
}
function parseRevealResult(value) {
	const body = record(value, "result");
	exactKeys(body, ["revealed"], [], "result");
	if (body.revealed !== true) throw new TypeError("result.revealed must be true");
	return { revealed: true };
}
function parseRevealAvailability(value) {
	const body = record(value, "result");
	exactKeys(body, ["available", "preview"], [], "result");
	if (typeof body.available !== "boolean" || typeof body.preview !== "boolean") throw new TypeError("result.available and result.preview must be booleans");
	return {
		available: body.available,
		preview: body.preview
	};
}
function parsePreviewRequest(value) {
	const body = record(value, "request");
	exactKeys(body, ["attachmentId"], [], "request");
	return { attachmentId: parseAttachmentId(body.attachmentId) };
}
function parsePreviewResult(value) {
	const body = record(value, "result");
	exactKeys(body, ["opened"], [], "result");
	if (body.opened !== true) throw new TypeError("result.opened must be true");
	return { opened: true };
}
const T = `${ATTACHMENT_LIBRARY_PACKAGE}/types`;
function descriptor(method, parameters, result, cancellable = false) {
	return {
		id: `${ATTACHMENT_LIBRARY_PACKAGE}#${ATTACHMENT_LIBRARY_NAMESPACE}/${method}`,
		service: ATTACHMENT_LIBRARY_NAMESPACE,
		namespace: ATTACHMENT_LIBRARY_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: parameters.map((parameter) => ({
			name: parameter.name,
			wire: parameter.name,
			source: "json",
			codec: parameter.codec
		})),
		...cancellable ? { cancellation: { parameter: "signal" } } : {},
		result,
		sourceLocation: {
			file: `${ATTACHMENT_LIBRARY_PACKAGE}/lib/index.js`,
			line: 1,
			column: 1
		}
	};
}
/** The Remote methods, in one list shared by the Host registration and the Client mount. */
const ATTACHMENT_LIBRARY_DESCRIPTORS = [
	descriptor("scan", [], strict(`${T}#LibraryResult`, parseLibraryResult)),
	descriptor("revealAvailability", [], strict(`${T}#RevealAvailability`, parseRevealAvailability)),
	descriptor("reveal", [{
		name: "request",
		codec: strict(`${T}#RevealRequest`, parseRevealRequest)
	}], strict(`${T}#RevealResult`, parseRevealResult), true),
	descriptor("openInPreview", [{
		name: "request",
		codec: strict(`${T}#PreviewRequest`, parsePreviewRequest)
	}], strict(`${T}#PreviewResult`, parsePreviewResult), true)
];
//#endregion
//#region src/index.ts
/**
* Host half of `dsh-plugin-attachment-library`: the read-only
* `attachmentLibrary` service and its `scan` Remote method. A scan lists the
* attachment store, reads every session log the session backend lists (through
* read handles) and every log held by the session trash (directly from disk),
* and reports which conversations reference each stored attachment. Logs whose
* revision or file is unchanged since the previous scan are not read again.
* `reveal` shows one stored attachment in the Host's file manager through
* DSH's own `revealNativePath` (Finder `open -R`, Explorer `/select`), with
* the path derived from the attachment id on the Host. `openInPreview` opens
* a read-only copy of a stored image in macOS Preview (see `preview.ts`;
* that private temporary copy is the plugin's only write). DSH data is never
* written, moved, opened, or deleted. See `library.ts` for the on-disk layouts.
*/
/** Session logs read at the same time. */
const READ_CONCURRENCY = 4;
/** Problems reported per scan; the rest are counted in the last one. */
const MAX_PROBLEMS = 100;
/** Longest wait for the file manager to accept a reveal when the caller passes no signal. */
const REVEAL_TIMEOUT_MS = 15e3;
function message(error) {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}
async function eachLimited(items, limit, run) {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const item = items[next];
			next += 1;
			await run(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
/**
* The conversation each session belongs to: subagent sessions climb their
* `parentSession` chain to the conversation that started them. Forks are
* conversations of their own.
* @param headers - every listed session header.
* @returns conversation id per session id.
*/
function conversationRoots(headers) {
	const byId = new Map(headers.map((header) => [String(header.id), header]));
	const roots = /* @__PURE__ */ new Map();
	for (const header of headers) {
		let current = header;
		const visited = /* @__PURE__ */ new Set([String(current.id)]);
		while (current.origin === "subagent" && current.parentSession !== void 0) {
			const parent = byId.get(String(current.parentSession));
			if (parent === void 0 || visited.has(String(parent.id))) break;
			visited.add(String(parent.id));
			current = parent;
		}
		roots.set(String(header.id), String(current.id));
	}
	return roots;
}
/**
* The attachment library service (`ctx.attachmentLibrary`). Scans run one at a
* time; a call made while a scan runs receives that scan's result.
*/
var AttachmentLibrary = class extends TypertRemoteService {
	static inject = [
		"sessionPersistence",
		"workspaceRegistry",
		"typert"
	];
	static Config = z.object({
		attachmentDirectory: z.string().description("Attachment store root; default `<DSH home>/attachments/v1`."),
		trashDirectory: z.string().description("Session trash directory; default `<DSH home>/session-trash`."),
		requestCacheDirectory: z.string().description("Request-image cache; default `<DSH home>/cache/attachments/request-images`."),
		previewDirectory: z.string().description("Parent of the private temporary directory holding Preview copies; default the system temporary directory.")
	});
	attachmentDirectory;
	trashDirectory;
	requestCacheDirectory;
	liveCache = /* @__PURE__ */ new Map();
	liveCacheOwner;
	trashCache = /* @__PURE__ */ new Map();
	probes = /* @__PURE__ */ new Map();
	running;
	previews;
	/**
	* @param ctx - Host context with session persistence, the Workspace registry, and the Typert registry.
	* @param config - plugin configuration.
	*/
	constructor(ctx, config = {}) {
		super(ctx, ATTACHMENT_LIBRARY_NAMESPACE);
		this.attachmentDirectory = config.attachmentDirectory ?? dshHomePath("attachments", "v1");
		this.trashDirectory = config.trashDirectory ?? dshHomePath("session-trash");
		this.requestCacheDirectory = config.requestCacheDirectory ?? dshCachePath("attachments", "request-images");
		this.previews = new PreviewCopies(config.previewDirectory ?? tmpdir());
	}
	[Service.init]() {
		const dispose = this.ctx.typert.register({
			package: ATTACHMENT_LIBRARY_PACKAGE,
			face: "host",
			schemas: [],
			model: {
				services: [],
				events: [],
				objects: []
			},
			invocations: ATTACHMENT_LIBRARY_DESCRIPTORS
		});
		this.ctx.effect(() => dispose, "attachment-library: Remote methods");
		this.ctx.effect(() => () => {
			this.previews.dispose().catch((error) => {
				this.ctx.logger.warn(`attachment-library: removing Preview copies failed: ${String(error)}`);
			});
		}, "attachment-library: Preview copies");
	}
	/**
	* Scan the attachment store and every session log, reusing the facts of
	* logs that have not changed since the previous scan.
	* @returns the library rows, totals, and logs that could not be read.
	*/
	scan() {
		this.running ??= this.runScan().finally(() => {
			this.running = void 0;
		});
		return this.running;
	}
	/**
	* Whether this Host can show files in a desktop file manager (Finder,
	* Explorer, or a Linux desktop's default file manager), by the same checks
	* DSH uses for its own "reveal" actions.
	* @returns availability.
	*/
	revealAvailability() {
		const available = nativeFileManager() !== null && canOpenNativePath();
		return {
			available,
			preview: available && nativeFileManager() === "finder"
		};
	}
	/**
	* Open one stored image in macOS Preview. The image is derived from the id
	* only and must be a plain file in the image store; Preview receives a
	* read-only copy with the right extension (DSH's object has none), opened
	* through DSH's `openNativeFileApplication` (`open -a <Preview.app> <copy>`,
	* no shell) after DSH confirms Preview is registered for the copy.
	* @param request - the image id.
	* @param signal - caller lifetime; abort stops the native commands.
	* @returns acknowledgement once Preview accepted the image.
	*/
	async openInPreview(request, signal = AbortSignal.timeout(REVEAL_TIMEOUT_MS)) {
		const attachmentId = parseAttachmentId(request.attachmentId);
		const sha256 = attachmentId.slice(7);
		if (!this.revealAvailability().preview) throw new RemoteError("attachment-library/unavailable", "Preview is available only on a macOS Host", { reason: "Preview is available only on a macOS Host" });
		const failed = (error) => new RemoteError("attachment-library/open-failed", message(error), {
			attachmentId,
			reason: message(error)
		}, { cause: error });
		let source;
		try {
			source = await revealTarget(this.attachmentDirectory, "image", sha256);
		} catch (error) {
			throw failed(error);
		}
		if (source === void 0) throw new RemoteError("attachment-library/not-found", `no stored image "${attachmentId}"`, { attachmentId });
		try {
			const probe = await imageHeader(source);
			if (probe === void 0) throw new Error("unrecognized image format");
			const copy = await this.previews.copy(source, sha256, probe.mediaType);
			const preview = (await nativeFileApplications(copy, signal)).find((app) => /\/Preview\.app\/?$/.test(app.id));
			if (preview === void 0) throw new Error("Preview is not registered for this image");
			await openNativeFileApplication(copy, preview.id, signal);
		} catch (error) {
			throw failed(error);
		}
		return { opened: true };
	}
	/**
	* Show one stored attachment in the Host's file manager. The path is derived
	* from the kind and digest only: an image's object, or a file's first
	* display-name link. It must be a plain file (not a link) inside the
	* attachment store. The file is selected, never opened or executed.
	* @param request - kind and attachment id.
	* @param signal - caller lifetime; abort stops the file-manager command.
	* @returns acknowledgement once the file manager accepted the request.
	*/
	async reveal(request, signal = AbortSignal.timeout(REVEAL_TIMEOUT_MS)) {
		const attachmentId = parseAttachmentId(request.attachmentId);
		if (!this.revealAvailability().available) throw new RemoteError("attachment-library/unavailable", "this Host has no desktop file manager", { reason: "this Host has no desktop file manager" });
		let path;
		try {
			path = await revealTarget(this.attachmentDirectory, request.kind, attachmentId.slice(7));
		} catch (error) {
			throw new RemoteError("attachment-library/reveal-failed", message(error), {
				attachmentId,
				reason: message(error)
			}, { cause: error });
		}
		if (path === void 0) throw new RemoteError("attachment-library/not-found", `no stored ${request.kind} "${attachmentId}"`, { attachmentId });
		try {
			await revealNativePath(path, signal);
		} catch (error) {
			throw new RemoteError("attachment-library/reveal-failed", message(error), {
				attachmentId,
				reason: message(error)
			}, { cause: error });
		}
		return { revealed: true };
	}
	async runScan() {
		try {
			return await this.collect();
		} catch (error) {
			throw new RemoteError("attachment-library/scan-failed", message(error), { reason: message(error) }, { cause: error });
		}
	}
	async collect() {
		const problems = [];
		const logs = [];
		const reread = {
			live: 0,
			trash: 0
		};
		const trash = await readTrash(this.trashDirectory);
		for (const problem of trash.problems) problems.push({
			id: problem.id,
			where: "trash",
			reason: problem.reason
		});
		const pendingTitles = new Map(trash.pending.map((record) => [record.sessionId, record.title]));
		const persistence = this.ctx.sessionPersistence;
		if (this.liveCacheOwner !== persistence.identity) {
			this.liveCache.clear();
			this.liveCacheOwner = persistence.identity;
		}
		const snapshots = await persistence.list();
		const listed = new Set(snapshots.map((snapshot) => String(snapshot.header.id)));
		for (const id of [...this.liveCache.keys()]) if (!listed.has(id)) this.liveCache.delete(id);
		const facts = /* @__PURE__ */ new Map();
		await eachLimited(snapshots, READ_CONCURRENCY, async (snapshot) => {
			const id = String(snapshot.header.id);
			const cached = this.liveCache.get(id);
			if (cached?.revision === snapshot.revision) {
				facts.set(id, cached.facts);
				return;
			}
			reread.live += 1;
			try {
				const read = await this.readLive(snapshot.header.id);
				this.liveCache.set(id, {
					revision: snapshot.revision,
					facts: read
				});
				facts.set(id, read);
			} catch (error) {
				this.liveCache.delete(id);
				problems.push({
					id,
					where: "live",
					reason: message(error)
				});
			}
		});
		const roots = conversationRoots(snapshots.map((snapshot) => snapshot.header));
		const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(String));
		const liveConversation = (rootId) => {
			const pendingTitle = pendingTitles.get(rootId);
			const status = pendingTitle !== void 0 ? "pending-trash" : archived.has(rootId) ? "archived" : "normal";
			const title = facts.get(rootId)?.title ?? pendingTitle;
			return {
				key: `live:${rootId}`,
				view: {
					sessionId: rootId,
					...title === void 0 ? {} : { title },
					status
				}
			};
		};
		for (const [id, read] of facts) logs.push({
			conversation: liveConversation(roots.get(id) ?? id),
			refs: read.refs
		});
		const trashLogs = [];
		for (const entry of trash.entries) {
			const conversation = {
				key: `trash:${entry.entryId}`,
				view: {
					sessionId: entry.sessionId,
					...entry.title === "" ? {} : { title: entry.title },
					status: "trash",
					deletedAt: entry.deletedAt
				}
			};
			for (const session of entry.sessions) trashLogs.push({
				conversation,
				sessionId: session.sessionId,
				dir: session.dir
			});
		}
		const seenFiles = /* @__PURE__ */ new Set();
		await eachLimited(trashLogs, READ_CONCURRENCY, async ({ conversation, sessionId, dir }) => {
			try {
				const info = await lstat(dir);
				if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`"${dir}" is not a plain directory`);
				const path = await currentGeneration(dir);
				if (path === void 0) throw new Error(`no session log in "${dir}"`);
				seenFiles.add(path);
				const token = await fileToken(path);
				let cached = this.trashCache.get(path);
				if (cached?.token !== token) {
					reread.trash += 1;
					const read = await scanLogFile(path);
					cached = {
						token,
						facts: read,
						...read.truncated || read.skippedLines > 0 ? { problem: `log is incomplete (${read.truncated ? "damaged compressed frame" : `${String(read.skippedLines)} unreadable line(s)`})` } : {}
					};
					this.trashCache.set(path, cached);
				}
				if (cached.problem !== void 0) problems.push({
					id: sessionId,
					where: "trash",
					reason: cached.problem
				});
				logs.push({
					conversation,
					refs: cached.facts.refs
				});
			} catch (error) {
				problems.push({
					id: sessionId,
					where: "trash",
					reason: message(error)
				});
			}
		});
		for (const path of [...this.trashCache.keys()]) if (!seenFiles.has(path)) this.trashCache.delete(path);
		const catalog = buildCatalog(await listStoredObjects(this.attachmentDirectory, this.probes), logs);
		const requestCacheBytes = await directoryBytes(this.requestCacheDirectory);
		const reported = problems.length > MAX_PROBLEMS ? [...problems.slice(0, 99), {
			id: "more",
			where: "live",
			reason: `${String(problems.length - MAX_PROBLEMS + 1)} more`
		}] : problems;
		return {
			summary: {
				total: catalog.total,
				images: catalog.images,
				files: catalog.files,
				active: catalog.active,
				trashOnly: catalog.trashOnly,
				unreferenced: catalog.unreferenced,
				missing: catalog.missing,
				requestCacheBytes,
				liveSessions: snapshots.length,
				trashSessions: trashLogs.length
			},
			attachments: catalog.attachments,
			problems: reported,
			scannedAt: Date.now(),
			reread
		};
	}
	async readLive(id) {
		const handle = await this.ctx.sessionPersistence.open(id, "read");
		try {
			return scanEvents((await handle.read()).events);
		} finally {
			await handle.close();
		}
	}
};
//#endregion
export { AttachmentLibrary, AttachmentLibrary as default, buildCatalog, conversationRoots, listStoredObjects, probeImage, readTrash, scanEvents, scanLogFile };

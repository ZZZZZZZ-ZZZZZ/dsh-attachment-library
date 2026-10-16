# dsh-plugin-attachment-library · Attachment library

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that adds **Settings → Attachment library**: every image and file attachment stored on this machine, the space it takes, and which conversations still use it (active, archived, moving to the trash, or in the trash).

**Read-only.** Nothing is deleted: the plugin never creates, changes, moves, or deletes an attachment, a session log, a trash file, or a cache entry; "Show in Finder" only selects a file and never opens or runs it. The plugin's only write is the read-only copy "Open in Preview" places in the system temporary directory (outside DSH data), removed when the plugin stops. Its purpose is to check the reference counts before any cleanup is considered.

- DSH 0.2.x (`engines.dsh: >=0.2.0-rc.2 <0.3.0`, including the 0.2.1 alpha previews)
- Trash statistics work with [`dsh-plugin-session-trash`](https://github.com/ZZZZZZZ-ZZZZZ/dsh-session-trash); without it only existing conversations are counted

## Install

**Desktop**: open **Plugins** in the sidebar → **Add plugin**, enter one of the following, click **Install**, then **Enable now** (new plugins start disabled):

- GitHub: `https://github.com/ZZZZZZZ-ZZZZZ/dsh-attachment-library`, or a version such as `github:ZZZZZZZ-ZZZZZ/dsh-attachment-library#v0.4.1`
- npm: `dsh-plugin-attachment-library`
- An absolute path to a local package, for example `/path/to/dsh-plugin-attachment-library-0.4.1.tgz` (made with `pnpm pack`)

Do not enter the source directory: its `node_modules` holds development copies of DSH packages that conflict with DSH's own.

**Command line** (optional): quit DSH, then run `dsh plugin --profile desktop add dsh-plugin-attachment-library`.

**Uninstall**: uninstall "Attachment library" on the **Plugins** page. The plugin stores no data; attachments are not affected.

## What the page shows

- **Totals**: all attachments (count and size); images and files; used by existing conversations, used only by conversations in the trash, and not used by any conversation (count and size each); attachments referenced but missing from the store; the size of the regenerable resize cache.
- **List**: a type icon (an image icon for images, an icon by extension for files), type, file names (every name stored for the same content), size, image dimensions and format, store time, and each referencing conversation with its title and status. An attachment shared by several conversations lists all of them.
- **Open in Preview** (macOS only): an arrow icon button on stored image rows (tooltip "Open in Preview") opens the image in Preview on the Host. Preview gets a read-only copy with the right extension, not DSH's own file (see below). File rows have no such button.
- **Show in Finder**: a folder icon button at the right of each stored row (tooltip "Show in Finder") selects the file in the Host's Finder (Windows Explorer, or the default Linux file manager): a file attachment shows under its real file name, an image as its content-named object file. It appears only when the page talks to the local DSH, the Host has a desktop file manager, and DSH allows desktop handoff; a failure is shown under the row.
- **Rescan**: the refresh icon button at the top right (tooltip "Rescan"); it is disabled while a scan runs, and "Rescanning…" is shown.
- **Filters**: type (all / images / files) and references (all / existing / trash only / unused); **sort** by time or by size (newest or largest first). The list shows 100 rows at a time.
- **Incomplete logs**: session logs that could not be read in full (damaged, cut short) are listed with a note that the "unused" counts may be too high.

## Why Finder shows no preview for images

DSH stores each image under its SHA-256 digest (for example `attachments/v1/objects/3f/3f9a…`) with **no file extension**, read-only (0400). The content is an ordinary normalized JPEG, WebP, PNG, or GIF, not encrypted; macOS decides the file type from the extension, so Finder shows no thumbnail and a double-click does not open it as an image. File attachments differ: each also has a read-only hard link under its real file name, which Finder shows normally.

## Counting rules

| Rule | Meaning |
|---|---|
| Identity | DSH stores attachments once per content digest (SHA-256); images and files are stored separately, so the same bytes stored as an image and as a file are two rows |
| References | Every `{ type: 'image' \| 'file', attachment: { attachmentId } }` in a session log counts: user prompts, tool results, and system messages |
| Conversations | A subagent session's references count for the conversation that started it; a fork is its own conversation (it inherits its parent's prefix, so both are listed) |
| Existing conversations | Every session the session backend lists, read through the official read-only handle; status active, archived, or moving to the trash |
| Trash | Logs inside the trash directory are read directly (raw JSONL or Zstandard frames); the title is the one recorded when the conversation was moved |
| In use / trash only / unused | Any conversation outside the trash (including one waiting to move) makes it "in use"; only trashed conversations make it "trash only"; none makes it "unused" |
| Size | Each image object and file object counts once; file names are hard links and take no extra space; missing attachments add no size |
| Store time | The modification time of the stored object (when this content was first stored) |

## Cache

The first scan reads every session log and can be slow with many logs. After that:

- existing sessions are read again only when the session backend's revision changed;
- trashed sessions are read again only when the log file's device, inode, size, or modification time changed;
- image dimensions are cached by the same file facts.

The cache lives in the DSH process memory only and is never written to disk; the first scan after a DSH restart reads every log again.

## Configuration

Every DSH directory is only read.

| Field | Default | Meaning |
|---|---|---|
| `attachmentDirectory` | `<DSH home>/attachments/v1` | Attachment store; set it when `dsh-attachment-local` has its own `dshHome` |
| `trashDirectory` | `<DSH home>/session-trash` | Session trash; keep it equal to `dsh-plugin-session-trash`'s `trashDirectory` |
| `requestCacheDirectory` | `<DSH home>/cache/attachments/request-images` | Regenerable per-model resize cache; only its size is measured |
| `previewDirectory` | system temporary directory | Where the private temporary directory for "Open in Preview" copies is created; the only place the plugin writes |

## How "Show in Finder" works

- It uses DSH's own capability: the Host calls `revealNativePath` from the official `@deepseek-ai/dsh-native-command` (`open -R` on macOS, Explorer `/select` on Windows, the containing directory on Linux), the same function behind DSH's built-in reveal actions. Availability uses the same checks (`nativeFileManager()`, `canOpenNativePath()`); the browser also requires `ctx.remote.$host.isLoopback` and follows DSH's `session.canOpenWorkspacePath()` switch.
- The official `session.openWorkspacePath` is not reused directly: it takes an absolute path from the browser and only accepts paths mapped into the workspace filesystem, which the attachment store is not.
- The browser sends only the attachment kind and id (`sha256:` and 64 lowercase hex digits); the authenticated `/api` gateway validates them strictly and rejects any extra field, a path included.
- The Host derives the path from the id: a file is `attachments/v1/files/<prefix>/<digest>/<name>` (the first name in sorted order, or the `file-objects` object when none exists), an image `attachments/v1/objects/<prefix>/<sha256>`. The target must be a plain file inside the attachment store with no symbolic link on the way; anything else is "not found".

## How "Open in Preview" works

- The browser sends only the image id (`sha256:` and 64 lowercase hex digits); the gateway validates it strictly and rejects any extra field, a path included. The Host finds `attachments/v1/objects/<prefix>/<sha256>` and requires a plain file inside the attachment store with no symbolic link on the way; file attachments, missing images, and links are "not found".
- The Host reads the image header for its format and copies the image into a private temporary directory (`<previewDirectory>/dsh-attachment-preview-<random>/`, mode 0700) as the first 16 digest digits plus the extension (`.jpg`, `.webp`, `.png`, `.gif`), mode 0400. The bytes are checked against the digest first; opening the same image again reuses its copy.
- Preview opens the copy rather than the object because the object has no extension, and although it is read-only (0400), its owner can still "unlock" and edit it in Preview, and opening a file can attach metadata to it; the copy leaves DSH's file untouched.
- Opening uses DSH's official `@deepseek-ai/dsh-native-command`: `nativeFileApplications` confirms Preview is registered for the copy, then `openNativeFileApplication` runs the fixed `open -a /System/Applications/Preview.app <copy>` through `execFile`, with no shell.
- It is offered only on a macOS Host with Finder, when the page talks to the local DSH and DSH allows desktop handoff. The private directory is removed when the plugin stops.

## Local data only

The library lists only what is stored on this machine, and removing a local copy (for example by permanently deleting a conversation with Session Trash) does not remove what DSH has already sent to DeepSeek:

- With the official DeepSeek API, DSH uploads the session log along with each request by default (the official `@deepseek-ai/dsh-session-log-deepseek` plugin). Turning off **Settings → General → Upload Session Log when using the official model API** stops later uploads only; turning it back on also uploads what was recorded while it was off.
- Images sent to the official API are uploaded as files that DSH asks DeepSeek to expire after 7 days; DSH does not guarantee their remote deletion.

This plugin makes no network requests and sends nothing anywhere; the page receives attachment names, sizes, and conversation titles through DSH's authenticated `/api`, never file paths.

## Known limitations

- Images uploaded to the DeepSeek service (indexed in `<DSH home>/llm-deepseek/files-v3.json`) are not counted and cannot be managed.
- Only the DSH 0.2.x attachment layout (v1) and the `dsh-plugin-session-trash` trash format (manifest version 1) are understood; a later major DSH version needs to be checked again.
- Attachment contents are not re-hashed; only presence and size are used. Attachments referenced but missing are shown separately.
- Sessions the backend cannot read (written by a newer DSH, or damaged) add no references and are listed under "incomplete logs".
- One scan returns the whole list; with tens of thousands of attachments the response is large and the first scan slow.
- When Finder shows an attachment folder, Finder itself may write a `.DS_Store` (view state) file there; that is Finder's behavior, and the plugin writes nothing.
- On Linux only the containing directory opens; the file is not selected. The button is hidden when DSH is opened through remote access.
- "Open in Preview" is macOS only. Copies stay until the plugin stops (or the system cleans its temporary directory); after a DSH crash they may remain in the system temporary directory.
- Tested on macOS only; the plugin only reads DSH data, so Linux and Windows are expected to work as well.

## Related plugin

**[Session Trash · dsh-plugin-session-trash](https://github.com/ZZZZZZZ-ZZZZZ/dsh-session-trash)**: adds "Move to trash" to each session's sidebar menu; trashed sessions can be restored or deleted permanently after a second confirmation, and a session opened in this run is hidden first and moved at the next start. With both plugins installed, the library shows which attachments only conversations in the trash still use.

Install: in **Plugins → Add plugin**, enter `github:ZZZZZZZ-ZZZZZ/dsh-session-trash#v0.2.1`.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test        # builds lib/, then runs every test
```

`lib/` is committed so GitHub installs need no build; run `pnpm run build` after changing the source and commit `lib/` with it.

Tests use the DSH 0.2.0-rc.2 packages published on npm: real JSONL session storage, the real Workspace registry, and the real Typert gateway. Attachments are laid out exactly as `dsh-attachment-local` stores them (hard-linked file names included) and trash entries exactly as `dsh-plugin-session-trash` writes them (multi-frame Zstandard logs, a cut frame, and a torn line included), all in a temporary directory; every scenario checks that the attachment, session, and trash directories are byte-for-byte and inode-for-inode unchanged by scans, reveals, and Preview opens. Tests replace the official `revealNativePath` with a recorder; "Open in Preview" runs the real official `nativeFileApplications` / `openNativeFileApplication` with only their command runner replaced by a recorder, asserting the exact argv, so neither Finder nor Preview opens. Client tests load the real UI components from the neighbouring `../dsh-0.2.0-rc.2` source tree (see `tests/primitives-shim.ts`).

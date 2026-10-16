# Changelog

## 0.4.1

- README: the library covers local data only; DSH uploads the session log to the official DeepSeek API by default and how to turn that off; images uploaded to DeepSeek are not deleted remotely by DSH.

## 0.4.0

- "Open in Preview" icon button on stored image rows (macOS only, local Host, same availability checks as "Show in Finder"). A new Remote method, `openInPreview`, takes only an image id; the Host finds the image object (a plain file inside the store, no symbolic link), copies it after checking its digest into a private temporary directory as a read-only file with the extension of its format, and opens the copy through DSH's official `nativeFileApplications` + `openNativeFileApplication` (`open -a /System/Applications/Preview.app <copy>`, `execFile`, no shell). DSH's own object is never opened.
- The copy directory (in the system temporary directory, configurable as `previewDirectory`) is the plugin's only write and is removed when the plugin stops.
- `revealAvailability` now also reports `preview`.
- README explains why images appear without a preview in Finder: DSH stores them under their digest with no extension.

## 0.3.0

- Removed thumbnails: the `readThumbnail` Remote method, the browser's lazy loading and canvas scaling, and their tests. Rows show a type icon again (an image icon, or an icon by file extension).
- "Show in Finder" icon button on each stored row. The Host derives the file from the attachment kind and id only (a file's display-name link, or an image's object), requires a plain file inside the attachment store with no symbolic link, and selects it through DSH's official `revealNativePath` (Finder `open -R`, Explorer `/select`, the containing directory on Linux); nothing is opened or run. New Remote methods `revealAvailability` and `reveal`; the request accepts no path.
- The button appears only for a local Host (`$host.isLoopback`) with a desktop file manager, and when DSH's `session.canOpenWorkspacePath()` allows desktop handoff. Failures are shown in the row.
- New peer dependency `@deepseek-ai/dsh-native-command` (part of DSH).

## 0.2.0

- Thumbnails for image attachments, including unused and trash-only images. A new read-only Remote method, `readThumbnail`, takes only an attachment id (validated at the gateway), refuses ids that are not a stored image, and returns the image verified by DSH's `ctx.attachments.readImage`. Nothing is cached or written on the Host.
- The browser loads a thumbnail only when its row comes into view, at most 3 at a time, scales it to a 96-pixel longest edge on a canvas, keeps only the small copy, and releases the full-size data. Placeholders show while loading, on failure, and for missing images; file attachments show an icon by extension.
- The "Rescan" text button is now an icon-only refresh button with the same label as its accessible name and tooltip; it is disabled while a scan runs and a "Rescanning…" status is shown.

## 0.1.0

First release (npm package `dsh-plugin-attachment-library`). Read-only: nothing is changed or deleted.

- Settings → Attachment library: totals of all attachments, images, and files, and of attachments used by existing conversations, used only by conversations in the session trash, and used by none; attachments referenced but missing; the regenerable resize-cache size.
- Attachment list with type, file names, size, image dimensions, store time, and every referencing conversation with its status (active, archived, moving to the trash, in the trash). Filters by type and by references; sort by time or size.
- Subagent references count for their conversation; trashed logs (raw or Zstandard) are read directly from the trash of `dsh-plugin-session-trash`.
- Logs that cannot be read in full are listed with a warning instead of failing the scan.
- In-memory cache: unchanged sessions (backend revision) and unchanged trash logs (file identity) are not read again.
- Calls go through the authenticated `/api` gateway.
- DSH 0.2.x (`>=0.2.0-rc.2 <0.3.0`); tested with 0.2.0-rc.2 and 0.2.1-alpha.4.

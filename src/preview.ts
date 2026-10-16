/**
 * Read-only copies of stored images for "Open in Preview". DSH stores an image
 * as `objects/<prefix>/<sha256>`: no extension, so macOS cannot tell it is an
 * image, and the object belongs to DSH. Preview therefore opens a copy, never
 * the object: the copy has the extension of its format, is read-only (0400),
 * and lives in a private temporary directory (0700) this plugin creates
 * outside DSH data. That directory is the plugin's only write anywhere, and it
 * is removed when the plugin stops.
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}

/**
 * File extension for an image format.
 * @param mediaType - format read from the image header.
 * @returns the extension without a dot, or `undefined` for other formats.
 */
export function previewExtension(mediaType: string): string | undefined {
  return EXTENSIONS[mediaType]
}

/** Copies for Preview inside one private temporary directory. */
export class PreviewCopies {
  private directory: Promise<string> | undefined

  /** @param parent - directory to create the private temporary directory in. */
  constructor(private readonly parent: string) {}

  /**
   * Copy one stored image, verifying that its bytes match its digest. An
   * earlier copy of the same image is reused.
   * @param source - the stored object (already checked to be a plain file in the store).
   * @param sha256 - the object's digest.
   * @param mediaType - format read from the object's header.
   * @returns the read-only copy's path.
   */
  async copy(source: string, sha256: string, mediaType: string): Promise<string> {
    const extension = previewExtension(mediaType)
    if (extension === undefined) throw new Error(`unsupported image format ${mediaType}`)
    this.directory ??= mkdir(this.parent, { recursive: true }).then(() => mkdtemp(join(this.parent, 'dsh-attachment-preview-')))
    const target = join(await this.directory, `${sha256.slice(0, 16)}.${extension}`)
    try {
      if ((await lstat(target)).isFile()) return target
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    const data = await readFile(source)
    if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('stored image does not match its digest')
    await writeFile(target, data, { flag: 'wx', mode: 0o400 })
    return target
  }

  /** The private directory, once created. */
  async location(): Promise<string | undefined> {
    return this.directory
  }

  /** Remove the private directory and every copy in it. */
  async dispose(): Promise<void> {
    const directory = this.directory
    this.directory = undefined
    if (directory === undefined) return
    await rm(await directory, { recursive: true, force: true })
  }
}

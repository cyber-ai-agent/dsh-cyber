/**
 * Server-side authority for avatar bitmaps offered by the character generator.
 *
 * Everything reaching this module is untrusted: the declared `file.type`, the
 * declared file name and the declared extension are all attacker controlled.
 * The only evidence that counts is the bytes, so the media type is sniffed from
 * the container header and the caller must use the returned type rather than
 * anything the client claimed.
 */

/** The only bitmap containers the character generator will ever store. */
export type AvatarMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export const AVATAR_MEDIA_TYPES: readonly AvatarMediaType[] = ['image/png', 'image/jpeg', 'image/webp']
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
/**
 * Base64 expands 3 bytes into 4 characters, so this is the largest encoded
 * payload that can still decode inside the byte budget. Checking the encoded
 * length first keeps an oversized upload from being materialized at all.
 */
export const AVATAR_MAX_BASE64_CHARACTERS = Math.ceil(AVATAR_MAX_BYTES / 3) * 4
export const AVATAR_MIN_BYTES = 1
export const AVATAR_MAX_FILE_NAME_CHARACTERS = 180
/**
 * Decompression-bomb guard. V1 deliberately ships no image decoder, so the
 * declared canvas in the container header is the sanity check: a pixel surface
 * this far past any avatar is refused before the bytes are ever stored, and a
 * file that fits both the byte budget and this surface cannot expand into a
 * memory blow-up in a downstream viewer.
 */
export const AVATAR_MAX_DIMENSION = 8192
export const AVATAR_MAX_PIXELS = 16 * 1024 * 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IHDR = Buffer.from([0x49, 0x48, 0x44, 0x52])
const RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46])
const WEBP = Buffer.from([0x57, 0x45, 0x42, 0x50])
const WEBP_VP8X = Buffer.from([0x56, 0x50, 0x38, 0x58])
const WEBP_VP8L = Buffer.from([0x56, 0x50, 0x38, 0x4c])
const WEBP_VP8 = Buffer.from([0x56, 0x50, 0x38, 0x20])
const PNG_BIT_DEPTHS = new Set([1, 2, 4, 8, 16])
const PNG_COLOUR_TYPES = new Set([0, 2, 3, 4, 6])
const JPEG_MAX_SEGMENTS = 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
/** Device names DOS reserved; still special on Windows with any extension. */
const RESERVED_FILE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

export class AvatarImageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AvatarImageError'
    this.code = code
  }
}

export interface SniffedAvatarImage {
  mediaType: AvatarMediaType
  /** Absent only when the container is valid but declares no readable canvas. */
  width?: number
  height?: number
}

/**
 * Decode a base64 avatar payload, refusing anything past the byte budget before
 * the buffer is allocated rather than after.
 */
export function decodeAvatarBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AvatarImageError('character_avatar_data_invalid', '角色预览图片数据无效。')
  }
  if (value.length > AVATAR_MAX_BASE64_CHARACTERS) {
    throw new AvatarImageError('character_avatar_size_invalid', '角色预览图片不能超过 5 MiB。')
  }
  // Canonical base64 only: no whitespace, no URL-safe alphabet, no stray
  // padding. Node's decoder silently skips what it cannot read, so a lenient
  // check here would let the stored bytes differ from what was submitted.
  if (!BASE64.test(value)) {
    throw new AvatarImageError('character_avatar_data_invalid', '角色预览图片数据无效。')
  }
  const bytes = Buffer.from(value, 'base64')
  assertAvatarByteBudget(bytes)
  return bytes
}

export function assertAvatarByteBudget(bytes: Buffer): void {
  if (bytes.byteLength < AVATAR_MIN_BYTES || bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new AvatarImageError('character_avatar_size_invalid', '角色预览图片不能超过 5 MiB。')
  }
}

/**
 * Resolve the media type from the container header alone. Returns `undefined`
 * when the bytes are not a PNG, JPEG or WebP the server is willing to store.
 */
export function sniffAvatarImage(bytes: Buffer): SniffedAvatarImage | undefined {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes)
}

/**
 * The single decision point for stored avatar bytes: budget, real container,
 * and a sane canvas. Returns the sniffed media type, which is the only type the
 * caller may use for the stored extension or the served content type.
 */
export function assertAvatarImage(bytes: Buffer): AvatarMediaType {
  assertAvatarByteBudget(bytes)
  const sniffed = sniffAvatarImage(bytes)
  if (sniffed === undefined) {
    throw new AvatarImageError('character_avatar_signature_invalid', '角色预览必须是 PNG、JPEG 或 WebP 图片。')
  }
  const { width, height } = sniffed
  if (width !== undefined && height !== undefined) {
    if (width < 1 || height < 1 || width > AVATAR_MAX_DIMENSION || height > AVATAR_MAX_DIMENSION || width * height > AVATAR_MAX_PIXELS) {
      throw new AvatarImageError('character_avatar_dimensions_invalid', '角色预览图片尺寸超出允许范围。')
    }
  }
  return sniffed.mediaType
}

/**
 * Cross-check a client declared media type against the sniffed one. The sniffed
 * type stays authoritative; this only refuses a payload whose declaration
 * disagrees with its own bytes, so a mislabelled upload is never stored under
 * the label the client asked for.
 */
export function assertDeclaredAvatarMediaType(declared: unknown, sniffed: AvatarMediaType): void {
  if (declared === undefined || declared === null) return
  if (typeof declared !== 'string' || !(AVATAR_MEDIA_TYPES as readonly string[]).includes(declared)) {
    throw new AvatarImageError('character_avatar_mime_invalid', '角色预览图片格式不受支持。')
  }
  if (declared !== sniffed) {
    throw new AvatarImageError('character_avatar_mime_mismatch', '角色预览图片的声明格式与实际内容不一致。')
  }
}

/**
 * Validate an uploaded file name and return its normalized form.
 *
 * Nothing derived from this value is ever joined into a path — the stored file
 * is always `preview.<sniffed extension>` under a host generated directory —
 * but a name that only becomes safe after rewriting is a name the client had no
 * business sending, so hostile shapes are refused instead of silently mangled.
 */
export function normalizeAvatarFileName(value: unknown): string {
  if (typeof value !== 'string') throw invalidFileName()
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > AVATAR_MAX_FILE_NAME_CHARACTERS) throw invalidFileName()
  if (Buffer.byteLength(normalized, 'utf8') > AVATAR_MAX_FILE_NAME_CHARACTERS * 4) throw invalidFileName()
  // C0/C1 controls, DEL, bidi overrides, zero-width and other invisible format
  // characters all let a name render as something other than what it is.
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u.test(normalized)) throw invalidFileName()
  // Any path separator, drive letter, relative segment or reserved device name.
  if (/[\\/]/u.test(normalized) || /^[A-Za-z]:/u.test(normalized)) throw invalidFileName()
  if (normalized.startsWith('.') || normalized.endsWith('.')) throw invalidFileName()
  if (RESERVED_FILE_NAMES.test(normalized)) throw invalidFileName()
  return normalized
}

function invalidFileName(): AvatarImageError {
  return new AvatarImageError('character_avatar_filename_invalid', '上传的角色预览文件名无效。')
}

export function avatarFileExtension(mediaType: AvatarMediaType): 'png' | 'jpg' | 'webp' {
  return mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp'
}

function sniffPng(bytes: Buffer): SniffedAvatarImage | undefined {
  // Signature, then a complete IHDR chunk: 8 + length(4) + type(4) + 13 + crc(4).
  if (bytes.byteLength < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  if (bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(PNG_IHDR)) return undefined
  if (!PNG_BIT_DEPTHS.has(bytes[24]!) || !PNG_COLOUR_TYPES.has(bytes[25]!)) return undefined
  return { mediaType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Walk the JPEG marker segments to the start-of-frame header. A JPEG without a
 * readable frame is not an image, so the absence of a SOF is a rejection rather
 * than an unknown canvas.
 */
function sniffJpeg(bytes: Buffer): SniffedAvatarImage | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  for (let segment = 0; segment < JPEG_MAX_SEGMENTS && offset + 4 <= bytes.byteLength; segment += 1) {
    if (bytes[offset] !== 0xff) return undefined
    // Markers may be preceded by any number of 0xff fill bytes.
    let markerOffset = offset + 1
    while (markerOffset < bytes.byteLength && bytes[markerOffset] === 0xff) markerOffset += 1
    const marker = bytes[markerOffset]
    if (marker === undefined) return undefined
    // Standalone markers carry no payload length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset = markerOffset + 1
      continue
    }
    // End of image, or entropy coded data the marker walk cannot cross.
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (markerOffset + 3 > bytes.byteLength) return undefined
    const segmentLength = bytes.readUInt16BE(markerOffset + 1)
    if (segmentLength < 2) return undefined
    if (isStartOfFrame(marker)) {
      if (segmentLength < 8 || markerOffset + 8 > bytes.byteLength) return undefined
      return {
        mediaType: 'image/jpeg',
        height: bytes.readUInt16BE(markerOffset + 4),
        width: bytes.readUInt16BE(markerOffset + 6),
      }
    }
    offset = markerOffset + 1 + segmentLength
  }
  return undefined
}

/** SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function sniffWebp(bytes: Buffer): SniffedAvatarImage | undefined {
  // Byte comparison, never `toString('ascii')`: Node's ascii decoder masks the
  // high bit, so 0xd2 0xc9 0xc6 0xc6 would read back as "RIFF".
  if (bytes.byteLength < 20 || !bytes.subarray(0, 4).equals(RIFF) || !bytes.subarray(8, 12).equals(WEBP)) return undefined
  const riffSize = bytes.readUInt32LE(4)
  if (riffSize < 12 || riffSize + 8 > bytes.byteLength) return undefined
  const chunk = bytes.subarray(12, 16)
  const chunkSize = bytes.readUInt32LE(16)
  if (chunkSize < 1 || 20 + chunkSize > bytes.byteLength) return undefined
  if (chunk.equals(WEBP_VP8X)) {
    if (chunkSize < 10) return undefined
    return { mediaType: 'image/webp', width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 }
  }
  if (chunk.equals(WEBP_VP8L)) {
    if (chunkSize < 5 || bytes[20] !== 0x2f) return undefined
    const header = bytes.readUInt32LE(21)
    return { mediaType: 'image/webp', width: (header & 0x3fff) + 1, height: ((header >>> 14) & 0x3fff) + 1 }
  }
  if (chunk.equals(WEBP_VP8)) {
    if (chunkSize < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    return { mediaType: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  }
  // A WebP file always opens with one of the three bitstream chunks above.
  return undefined
}

// What the assistant composer accepts (bead 2by.10). One place for types, sizes,
// count, model support and the content check, so the picker, drop, paste, the
// server route and the tests agree.

export const MAX_ATTACHMENTS = 4;
/**
 * 3.75 MB decoded, so the base64 an image travels as stays within 5,242,880 bytes:
 * Anthropic's per-image limit, the tightest among the catalog's image models.
 */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** By extension: browsers often give `.md` (and sometimes `.csv`) no usable type. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
};

export const ATTACHMENT_PRIVACY_NOTE =
  "Attachments go to OpenRouter with your message and stay in this conversation until you clear it.";

const NO_VISION =
  "This model cannot read images. Choose one that can in Settings → AI assistant, or attach a .txt, .csv or .md file.";

export type AttachmentVerdict =
  | { ok: true; kind: "image" | "text"; mimeType: string }
  | { ok: false; message: string };

export function acceptFor(imageInput: boolean): string {
  return [...(imageInput ? IMAGE_TYPES : []), ...Object.keys(TEXT_TYPES)].join(",");
}

export function wrongTypeMessage(name: string): string {
  return `"${name}" cannot be attached. Attach a PNG, JPEG, WebP or GIF image, or a .txt, .csv or .md file.`;
}

export function checkAttachment(
  file: { name: string; type: string; size: number },
  imageInput: boolean,
  queued: number,
): AttachmentVerdict {
  if (queued >= MAX_ATTACHMENTS) {
    return { ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} files to one message.` };
  }
  const dot = file.name.lastIndexOf(".");
  const text = dot < 0 ? undefined : TEXT_TYPES[file.name.slice(dot).toLowerCase()];
  if (text) {
    return file.size > MAX_TEXT_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 200 KB.` }
      : { ok: true, kind: "text", mimeType: text };
  }
  if (IMAGE_TYPES.includes(file.type)) {
    if (!imageInput) return { ok: false, message: NO_VISION };
    return file.size > MAX_IMAGE_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 3.75 MB.` }
      : { ok: true, kind: "image", mimeType: file.type };
  }
  return { ok: false, message: wrongTypeMessage(file.name) };
}

const startsWith = (data: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, i) => data[at + i] === byte);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * Whether the bytes are what the declared type says: an image's magic number, or
 * UTF-8 text with no NUL byte. The type a browser or a request claims is never
 * trusted on its own; both the composer and the server run this.
 */
export function contentMatches(mimeType: string, data: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(data, ascii("GIF87a")) || startsWith(data, ascii("GIF89a"));
    case "image/webp":
      return startsWith(data, ascii("RIFF")) && startsWith(data, ascii("WEBP"), 8);
    case "text/plain":
    case "text/csv":
    case "text/markdown":
      if (data.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** The largest a single attachment of this type may be, or null for an unknown type. */
export function maxBytesFor(mimeType: string): number | null {
  if (IMAGE_TYPES.includes(mimeType)) return MAX_IMAGE_BYTES;
  return Object.values(TEXT_TYPES).includes(mimeType) ? MAX_TEXT_BYTES : null;
}

// What the assistant composer accepts (bead 2by.10). One place for types, sizes,
// count, model support and the content check, so the picker, drop, paste, the
// server route and the tests agree.

export const MAX_ATTACHMENTS = 4;
/**
 * 3.75 MB decoded, so the base64 an image travels as stays within 5,242,880 bytes:
 * Anthropic's per-image limit, the tightest among the catalog's image models.
 */
export const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024;
/** An image as picked; the composer shrinks one over {@link MAX_IMAGE_BYTES} (j6dk). */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
/** An .xlsx as picked; what is sent is its text, which {@link MAX_TEXT_BYTES} bounds. */
export const MAX_XLSX_BYTES = 10 * 1024 * 1024;

/** Base64 characters one full-size image travels as. */
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
/**
 * The image base64 one run may carry: one message's worth of full-size images. Older
 * images beyond it are named instead of re-sent, which is what keeps a thread's runs
 * under {@link MAX_RUN_REQUEST_BYTES}.
 */
export const IMAGE_REQUEST_BUDGET_CHARS = MAX_ATTACHMENTS * MAX_IMAGE_BASE64;
/**
 * The largest run request the server reads: the image budget (~21 MB) plus room for
 * the text history, the schedule context and the tool list.
 */
export const MAX_RUN_REQUEST_BYTES = 32 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** By extension: browsers often give `.md` (and sometimes `.csv`) no usable type. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
};
/** Converted to CSV text in the browser (xlsx-text.ts, bead 6eli). */
const XLSX = ".xlsx";

export const ATTACHMENT_PRIVACY_NOTE =
  "Attachments go to OpenRouter with your message and stay in this conversation until you clear it.";

const NO_VISION =
  "This model cannot read images. Choose one that can in Settings → AI assistant, or attach a .txt, .csv, .md or .xlsx file.";

export type AttachmentVerdict =
  | { ok: true; kind: "image" | "text"; mimeType: string; from?: "xlsx" }
  | { ok: false; message: string };

export function acceptFor(imageInput: boolean): string {
  return [...(imageInput ? IMAGE_TYPES : []), ...Object.keys(TEXT_TYPES), XLSX].join(",");
}

export function wrongTypeMessage(name: string): string {
  return `"${name}" cannot be attached. Attach a PNG, JPEG, WebP or GIF image, or a .txt, .csv, .md or .xlsx file.`;
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
  const extension = dot < 0 ? "" : file.name.slice(dot).toLowerCase();
  if (extension === XLSX) {
    return file.size > MAX_XLSX_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 10 MB.` }
      : { ok: true, kind: "text", mimeType: TEXT_TYPES[".csv"], from: "xlsx" };
  }
  const text = TEXT_TYPES[extension];
  if (text) {
    return file.size > MAX_TEXT_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 200 KB.` }
      : { ok: true, kind: "text", mimeType: text };
  }
  if (IMAGE_TYPES.includes(file.type)) {
    if (!imageInput) return { ok: false, message: NO_VISION };
    return file.size > MAX_IMAGE_SOURCE_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 20 MB.` }
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

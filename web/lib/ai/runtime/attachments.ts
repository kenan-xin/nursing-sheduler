// The server's own check on user-message attachments, and the text-file rewrite
// (bead 2by.10). Server-only: it decodes with Buffer.
//
// The composer already applies the same rules, but a request is untrusted input, so
// every image and document part is checked again here: a data source only (no URL for
// the provider to fetch), a known type, the size limit on the DECODED bytes, the
// per-message count, and the bytes' own signature. A failure throws an app code and
// nothing else, so no attachment content can reach a RUN_ERROR body or a log.
//
// Text files then become plain text parts: the OpenAI-compatible chat provider takes
// images but rejects a text/* file part, and a text file is only text anyway.

import type { Message } from "@ag-ui/client";

import { MAX_ATTACHMENTS, contentMatches, maxBytesFor } from "@/lib/ai/assistant/attachment-rules";

import { AI_ERROR_ATTACHMENT_REJECTED } from "./containment";

type Part = {
  type?: unknown;
  source?: { type?: unknown; value?: unknown; mimeType?: unknown };
  metadata?: { filename?: unknown };
};

export class AttachmentRejectedError extends Error {
  constructor() {
    super(AI_ERROR_ATTACHMENT_REJECTED);
    this.name = "AttachmentRejectedError";
  }
}

const isAttachment = (part: Part) => part?.type === "image" || part?.type === "document";

function checkedBytes(part: Part): Buffer {
  const source = part.source;
  if (source?.type !== "data" || typeof source.value !== "string") {
    throw new AttachmentRejectedError();
  }
  const mimeType = typeof source.mimeType === "string" ? source.mimeType : "";
  const max = maxBytesFor(mimeType);
  const isImage = mimeType.startsWith("image/");
  if (max === null || isImage !== (part.type === "image")) throw new AttachmentRejectedError();
  // Cheap bound before decoding: base64 is 4 characters per 3 bytes.
  if (source.value.length > Math.ceil(max / 3) * 4 + 4) throw new AttachmentRejectedError();
  const bytes = Buffer.from(source.value, "base64");
  if (bytes.length > max || !contentMatches(mimeType, bytes)) throw new AttachmentRejectedError();
  return bytes;
}

/**
 * Validate every attachment and turn each text file into a text part.
 * Throws {@link AttachmentRejectedError} on the first part that fails.
 */
export function prepareAttachments(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const parts = message.content as Part[];
    const attachments = parts.filter(isAttachment);
    if (attachments.length === 0) return message;
    if (message.role !== "user" || attachments.length > MAX_ATTACHMENTS) {
      throw new AttachmentRejectedError();
    }
    const content = parts.map((part) => {
      if (!isAttachment(part)) return part;
      const bytes = checkedBytes(part);
      if (part.type === "image") return part;
      const name =
        typeof part.metadata?.filename === "string" ? part.metadata.filename : "attachment";
      return { type: "text", text: `Attached file "${name}":\n${bytes.toString("utf8")}` };
    });
    return { ...message, content } as Message;
  });
}

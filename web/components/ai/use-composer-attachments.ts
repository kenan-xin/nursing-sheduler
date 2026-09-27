"use client";

// The composer's attachments (2by.10): CopilotKit's own `useAttachments` (queue,
// picker, drag and drop, paste) with this app's rules from attachment-rules.ts. The
// bytes are checked here as well as on the server, so a renamed file is refused at
// once with a reason rather than failing the whole turn later.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAttachments, type Attachment } from "@copilotkit/react-core/v2";
import {
  MAX_IMAGE_BYTES,
  acceptFor,
  checkAttachment,
  contentMatches,
  wrongTypeMessage,
} from "@/lib/ai/assistant/attachment-rules";
import type { AssistantAttachmentV1 } from "@/lib/ai/assistant/records";

function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function useComposerAttachments(imageInput: boolean) {
  const [error, setError] = useState<string | null>(null);
  // Files accepted so far, counting a batch's own earlier files: `onUpload` runs once
  // per file, in turn, before the queue re-renders. Re-synced from the queue whenever
  // no upload is running, so a removed chip frees its place.
  const queued = useRef(0);
  const uploading = useRef(0);
  const state = useAttachments({
    config: {
      enabled: true,
      accept: acceptFor(imageInput),
      maxSize: MAX_IMAGE_BYTES,
      onUpload: async (file) => {
        const verdict = checkAttachment(file, imageInput, queued.current);
        if (!verdict.ok) throw new Error(verdict.message);
        queued.current += 1;
        uploading.current += 1;
        try {
          const bytes = await readBytes(file);
          if (!contentMatches(verdict.mimeType, bytes)) {
            queued.current -= 1;
            throw new Error(wrongTypeMessage(file.name));
          }
          setError(null);
          return {
            type: "data",
            value: toBase64(bytes),
            mimeType: verdict.mimeType,
            metadata: { kind: verdict.kind },
          };
        } finally {
          uploading.current -= 1;
        }
      },
      // The library's own messages list MIME types; the app's rules say it plainly.
      onUploadFailed: ({ file, message, reason }) => {
        if (reason === "upload-failed") return setError(message);
        const verdict = checkAttachment(file, imageInput, 0);
        setError(verdict.ok ? wrongTypeMessage(file.name) : verdict.message);
      },
    },
  });
  if (uploading.current === 0) queued.current = state.attachments.length;

  const { attachments, consumeAttachments, containerRef } = state;
  // The library's chips carry no tooltip and globals.css §7 cuts a long name short,
  // so the full name goes on each chip here. The queue renders one chip per
  // attachment, in order.
  useEffect(() => {
    const queue = containerRef.current?.querySelector('[data-testid="copilot-attachment-queue"]');
    Array.from(queue?.children ?? []).forEach((chip, i) => {
      const name = attachments[i]?.filename;
      if (name) chip.setAttribute("title", name);
    });
  }, [attachments, containerRef]);
  const ready = useCallback(
    (): AssistantAttachmentV1[] =>
      attachments.flatMap((a: Attachment): AssistantAttachmentV1[] =>
        a.status === "ready" && a.source.type === "data"
          ? [
              {
                kind: a.metadata?.kind === "image" ? "image" : "text",
                filename: a.filename ?? "attachment",
                mimeType: a.source.mimeType,
                data: a.source.value,
              },
            ]
          : [],
      ),
    [attachments],
  );
  const consume = useCallback(() => {
    consumeAttachments();
    setError(null);
  }, [consumeAttachments]);

  return { ...state, error, accept: acceptFor(imageInput), ready, consume };
}

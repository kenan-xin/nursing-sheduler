# 2by.10: image and text attachments in the assistant (Implementation Plan)

Confidence: 6.8/10

The pieces this plan needs are already installed and I read them. CopilotKit 1.66.2 ships `useAttachments`, and `CopilotChatView` takes `attachments`, `onAddFile` and the drag and drop props. The CopilotKit runtime's `convertUserMessageContent` turns AG-UI `image` parts into AI SDK image parts and `document` parts into file parts. AG-UI 0.0.57 keeps `metadata.filename` on each part. OpenRouter's live `/models` lists `architecture.input_modalities`. On 2026-09-27, 262 of 390 tool-capable models included `"image"`, among them all 5 fallback models. What lowers the score:
- The app renders `CopilotChatView` directly, not `CopilotChat`. So it wires `useAttachments` and the hidden file input itself. No example of that exists in the repo.
- The size of an image request through the CopilotKit runtime route is untested. Base64 turns a 5 MB image into about 6.7 MB of JSON.
- Chip layout for long filenames inside the library's composer is unmeasured.
- `@ai-sdk/openai` rejects a `text/plain` file part, so text files are turned into text on the server. That step is new code.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the assistant panel, a user can attach up to 4 files to a message. A file is an image (PNG, JPEG, WebP, GIF) or a text file (.txt, .csv, .md). Images need a model that reads images. Attachments are stored with the conversation, replayed on reload, and deleted by Clear conversation history.

**Architecture:** The composer uses CopilotKit's own `useAttachments` hook with app rules: types, sizes, count and model support, all from one pure module. A composer send passes the ready attachments to `session.send(text, { attachments })`, which builds an AG-UI user message with `text` + `image`/`document` parts. `messages.ts`, the one transport adapter, now keeps attachments on `AssistantMessageV1.attachments`, so history replays them. On the server, `openrouter-agent.ts` turns each text-file part into a plain text part before `convertMessagesToVercelAISDKMessages`. Images go through unchanged. Whether the model reads images comes from OpenRouter's catalog (`architecture.input_modalities`), through the existing `/api/ai/openrouter/models` route.

**Tech Stack:** TypeScript, React 19, `@copilotkit/react-core/v2` 1.66.2 (`useAttachments`, `CopilotChatView`), `@ag-ui/client` 0.0.57, `ai` 6.0.104, `@ai-sdk/openai` 3.0.36, Dexie 4, Vitest, Testing Library, Playwright.

**Spec:** bead `nursing-sheduler-2by.10`. Its acceptance criteria:
- Only a Ready assistant sends attachments.
- The UI enforces size and type limits.
- A non-vision model disables image attach with a reason.
- Attachments are stored with the conversation and cleared by Clear history.

User decision (D8, 2026-09-26): build image and text-file attachments. PDF, XLSX and dictation stay deferred. Source: `docs/research/2026-09-25-v1-sync/06-frontend-gap.md` A02.

Docs checked (2026-09-27):
- OpenRouter [image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding) accepts `image/png`, `image/jpeg`, `image/webp` and `image/gif`, as a URL or a base64 data URL.
- `GET https://openrouter.ai/api/v1/models` rows carry `architecture.input_modalities`, for example `["text","image","file"]`.

## Global Constraints

- **Branch.** From `/home/kenan/work/nursing-sheduler`, run `wt switch --create feat/2by10-attachments --base develop --no-cd`. The worktree is `/home/kenan/work/nursing-sheduler.feat-2by10-attachments` (`$WT`). Do not push. Merging needs the user's approval.
- **Web gate, before every commit** (from `$WT/web`): `pnpm vitest run <focused files>`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`. Task 6 also runs its Playwright spec.
- **Library-first (repo CLAUDE.md, memory `prefer-maintained-libraries-over-reimplementation`).** Use CopilotKit's `useAttachments` and its chips, and do not hand-roll a picker or a drop zone. `useAttachments` is not in `.oxlintrc.json`'s restricted `@copilotkit/react-core/v2` names, so it is allowed. Do not import `@copilotkit/shared` (a transitive dependency, not a direct one).
- **Privacy.** Attachments go to OpenRouter with the message, like typed text. No attachment is ever read by the server beyond decoding a text file for that one request. Nothing is logged.
- **Long user text (memory `long-user-text-no-overflow`).** A long filename ends in an ellipsis inside its chip and in the error line. Its full text stays available (`title`).
- **Design (DESIGN.md).** The error line uses `text-meta text-errorink`, the same as `RefusalNotice`. The privacy line uses `text-meta text-ink2`. The library's chips keep their look, and only overflow is fixed.
- **Commits:** conventional messages ending `(2by.10)`. Run `bd update nursing-sheduler-2by.10 --claim` first, and `bd close` at the end.

## Decisions taken (minor, delegated)

- **Types:** images `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Text files are `.txt`, `.csv` and `.md` (`text/plain`, `text/csv`, `text/markdown`). The match is by extension, because browsers often report `.md` with an empty type.
- **Limits:** an image is at most 5 MB, a text file at most 200 KB, and a message holds at most 4 attachments. A message still needs some typed text.
- **No vision:** the file picker's `accept` leaves images out. An image dropped or pasted anyway is refused with the reason line.
- **Copy** (app strings):
  - no vision: `This model cannot read images. Choose one that can in Settings → AI assistant, or attach a .txt, .csv or .md file.`
  - wrong type: `"<name>" cannot be attached. Attach a PNG, JPEG, WebP or GIF image, or a .txt, .csv or .md file.`
  - too large: `"<name>" is larger than 5 MB.` / `"<name>" is larger than 200 KB.`
  - too many: `You can attach up to 4 files to one message.`
  - privacy line, shown while files are queued: `Attachments go to OpenRouter with your message and stay in this conversation until you clear it.`
- **Unknown model support** (a custom slug, or a model missing from the catalog) counts as "no images".
- **The attach control** keeps the library's own label ("Add attachments").
- **Text-file framing for the model:** `Attached file "<name>":` then the file text.

## Review Focus

- A reload replays an image message: the chip is still in the panel, and the next turn resends the image part.
- The non-vision path: the picker offers no images, and a dropped image shows the reason and is not queued.
- A refused send (busy) keeps the queued files. An accepted send clears them.
- Clear conversation history deletes attachment data: no base64 is left in `assistantMessages`.
- A text file never reaches the provider as a `file` part (which `@ai-sdk/openai` rejects). It arrives as text.

## Interfaces fixed by this plan

```ts
// web/lib/ai/openrouter/catalog.ts (Task 1)
// CatalogModel gains: imageInput: boolean;

// web/lib/ai/assistant/attachment-rules.ts (Task 2)
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
export const ATTACHMENT_PRIVACY_NOTE: string;
export function acceptFor(imageInput: boolean): string;
export type AttachmentVerdict =
  | { ok: true; kind: "image" | "text"; mimeType: string }
  | { ok: false; message: string };
export function checkAttachment(
  file: { name: string; type: string; size: number }, imageInput: boolean, queued: number,
): AttachmentVerdict;

// web/lib/ai/assistant/records.ts (Task 3)
export interface AssistantAttachmentV1 {
  kind: "image" | "text";
  filename: string;
  mimeType: string;
  /** Base64 without a data-URL prefix. */
  data: string;
}
// AssistantMessageV1 gains: attachments?: AssistantAttachmentV1[] | null;

// web/lib/ai/assistant/messages.ts (Task 3)
export function toUserContent(text: string, attachments: readonly AssistantAttachmentV1[] | null): UserMessage["content"];

// web/lib/ai/runtime/attachments.ts (Task 4)
export function inlineTextAttachments(messages: readonly Message[]): Message[];

// web/components/ai/use-assistant-session.ts (Task 5)
// AssistantSendOptions gains: attachments?: readonly AssistantAttachmentV1[];

// web/components/ai/use-composer-attachments.ts (Task 6)
export function useComposerAttachments(imageInput: boolean): ComposerAttachments;
// web/components/ai/use-model-image-input.ts (Task 6)
export function useModelImageInput(): boolean;
```

---

### Task 1: The catalog says which models read images

**Files:**
- Modify: `web/lib/ai/openrouter/catalog.ts` (`CatalogModel`, `RawModel`, `selectToolCapableModels`, `FALLBACK_MODELS`, `FALLBACK_CATALOG_VERSION`)
- Test: `web/lib/ai/openrouter/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("marks the models that read images (2by.10)", () => {
  const models = selectToolCapableModels({
    data: [
      { id: "a/vision", name: "Vision", supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"] } },
      { id: "b/text", name: "Text", supported_parameters: ["tools"], architecture: { input_modalities: ["text"] } },
      { id: "c/old", name: "Old", supported_parameters: ["tools"] },
    ],
  });
  expect(Object.fromEntries(models.map((m) => [m.id, m.imageInput]))).toEqual({
    "a/vision": true,
    "b/text": false,
    "c/old": false,
  });
  expect(FALLBACK_MODELS.every((m) => m.imageInput)).toBe(true);
});
```

(Import `FALLBACK_MODELS` alongside the existing imports.)

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/openrouter/catalog.test.ts`
Expected: FAIL (`imageInput` is undefined).

- [ ] **Step 3: Implement**

```ts
export interface CatalogModel {
  id: string;
  name: string;
  /** Context window in tokens, when OpenRouter reports one. */
  contextLength: number | null;
  /** OpenRouter lists "image" in `architecture.input_modalities` (2by.10). */
  imageInput: boolean;
}
```

Add `architecture?: unknown;` to `RawModel`. In `selectToolCapableModels`, push:

```ts
      imageInput: (() => {
        const modalities = (row.architecture as { input_modalities?: unknown } | undefined)
          ?.input_modalities;
        return Array.isArray(modalities) && modalities.includes("image");
      })(),
```

Add `imageInput: true` to each `FALLBACK_MODELS` row (all five take images, checked on the live catalog on 2026-09-27). Bump `FALLBACK_CATALOG_VERSION` to `2`. Fix any other test fixture that builds a `CatalogModel` literal (`pnpm typecheck` names them).

- [ ] **Step 4: Run it and see it pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/openrouter components/settings && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments && git add web/lib/ai/openrouter web/components/settings
git commit -m "feat(assistant): note which catalog models read images (2by.10)"
```

### Task 2: One module owns the attachment rules

**Files:**
- Create: `web/lib/ai/assistant/attachment-rules.ts`
- Test: `web/lib/ai/assistant/attachment-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  acceptFor,
  checkAttachment,
} from "./attachment-rules";

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe("attachment rules (2by.10)", () => {
  it("takes the four image types for a vision model, and text files for any model", () => {
    expect(checkAttachment(file("ward.png", "image/png"), true, 0)).toEqual({ ok: true, kind: "image", mimeType: "image/png" });
    expect(checkAttachment(file("notes.md", ""), false, 0)).toEqual({ ok: true, kind: "text", mimeType: "text/markdown" });
    expect(checkAttachment(file("leave.CSV", "application/vnd.ms-excel"), false, 0)).toEqual({ ok: true, kind: "text", mimeType: "text/csv" });
  });

  it("refuses an image for a model that cannot read one, with the way out", () => {
    const verdict = checkAttachment(file("ward.png", "image/png"), false, 0);
    expect(verdict).toEqual({
      ok: false,
      message:
        "This model cannot read images. Choose one that can in Settings → AI assistant, or attach a .txt, .csv or .md file.",
    });
  });

  it("enforces type, size and count", () => {
    expect(checkAttachment(file("rota.pdf", "application/pdf"), true, 0)).toMatchObject({ ok: false, message: expect.stringMatching(/^"rota.pdf" cannot be attached\./) });
    expect(checkAttachment(file("big.jpg", "image/jpeg", MAX_IMAGE_BYTES + 1), true, 0)).toEqual({ ok: false, message: '"big.jpg" is larger than 5 MB.' });
    expect(checkAttachment(file("big.txt", "text/plain", MAX_TEXT_BYTES + 1), true, 0)).toEqual({ ok: false, message: '"big.txt" is larger than 200 KB.' });
    expect(checkAttachment(file("a.txt", "text/plain"), true, MAX_ATTACHMENTS)).toEqual({ ok: false, message: "You can attach up to 4 files to one message." });
  });

  it("offers images in the picker only to a vision model", () => {
    expect(acceptFor(true)).toContain("image/png");
    expect(acceptFor(false)).not.toContain("image/");
    expect(acceptFor(false)).toContain(".md");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/assistant/attachment-rules.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `attachment-rules.ts`**

```ts
// What the assistant composer accepts (bead 2by.10). One place for types, sizes,
// count and model support, so the picker, drop, paste and the tests agree.

export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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

export function checkAttachment(
  file: { name: string; type: string; size: number },
  imageInput: boolean,
  queued: number,
): AttachmentVerdict {
  if (queued >= MAX_ATTACHMENTS) {
    return { ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} files to one message.` };
  }
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const text = TEXT_TYPES[extension];
  if (text) {
    return file.size > MAX_TEXT_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 200 KB.` }
      : { ok: true, kind: "text", mimeType: text };
  }
  if (IMAGE_TYPES.includes(file.type)) {
    if (!imageInput) return { ok: false, message: NO_VISION };
    return file.size > MAX_IMAGE_BYTES
      ? { ok: false, message: `"${file.name}" is larger than 5 MB.` }
      : { ok: true, kind: "image", mimeType: file.type };
  }
  return {
    ok: false,
    message: `"${file.name}" cannot be attached. Attach a PNG, JPEG, WebP or GIF image, or a .txt, .csv or .md file.`,
  };
}
```

- [ ] **Step 4: Run it and see it pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments && git add web/lib/ai/assistant/attachment-rules.ts web/lib/ai/assistant/attachment-rules.test.ts
git commit -m "feat(assistant): attachment type, size and count rules (2by.10)"
```

### Task 3: Store attachments with the conversation

**Files:**
- Modify: `web/lib/ai/assistant/records.ts` (`AssistantAttachmentV1`, `AssistantMessageV1.attachments?`)
- Modify: `web/lib/ai/assistant/messages.ts` (header comment, `toCanonical`, `toTransport`, new `toUserContent`)
- Modify: `web/lib/ai/assistant/history-repo.ts` (`persistThreadMessages` prior-row merge, ~line 326)
- Modify: `web/lib/ai/assistant/transcript.ts` (`TranscriptMessage.attachments?`, one line per attachment)
- Test: `web/lib/ai/assistant/messages-attachments.test.ts` (new), `web/lib/ai/assistant/history-repo.test.ts`, `web/lib/ai/assistant/transcript.test.ts`

No Dexie version bump is needed: `attachments` is not indexed. Clear already deletes every message row of a cleared thread (`clear-repo.ts` ~line 1005), so the data goes with them.

- [ ] **Step 1: Write the failing tests**

`messages-attachments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import { toCanonical, toTransport, toUserContent } from "./messages";
import type { AssistantMessageV1 } from "./records";

const png = { kind: "image" as const, filename: "ward.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
const csv = { kind: "text" as const, filename: "leave.csv", mimeType: "text/csv", data: "QW5hLDMgTm92" };
const ctx = { threadId: "t", scenarioId: "s", modelId: null, turnId: "turn", createdAt: "x", globalGeneration: 0, scenarioGeneration: 0 };

describe("attachments through the transport adapter (2by.10)", () => {
  it("builds text + image + document parts, and a plain string when there are none", () => {
    expect(toUserContent("hi", null)).toBe("hi");
    expect(toUserContent("What is this?", [png, csv])).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", source: { type: "data", value: png.data, mimeType: "image/png" }, metadata: { filename: "ward.png" } },
      { type: "document", source: { type: "data", value: csv.data, mimeType: "text/csv" }, metadata: { filename: "leave.csv" } },
    ]);
  });

  it("round-trips a user message with attachments through the durable record", () => {
    const message = { id: "m1", role: "user", content: toUserContent("What is this?", [png, csv]) } as Message;
    const record = { ...toCanonical(message, ctx)!, seq: 0 } as AssistantMessageV1;
    expect(record.content).toBe("What is this?");
    expect(record.attachments).toEqual([png, csv]);
    expect(toTransport(record)).toEqual(message);
  });

  it("keeps an old record with no attachments field as plain text", () => {
    const record = { ...toCanonical({ id: "m2", role: "user", content: "hi" } as Message, ctx)!, seq: 1 } as AssistantMessageV1;
    delete (record as Partial<AssistantMessageV1>).attachments;
    expect(toTransport(record)).toEqual({ id: "m2", role: "user", content: "hi" });
  });
});
```

`history-repo.test.ts`, a new case:

```ts
it("keeps attachments when a message is re-persisted as text only (2by.10)", async () => {
  const harness = createAssistantHarness();
  const thread = await selectActiveThread("scenario-a", harness.config);
  const withImage: Message = {
    id: "m1",
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" }, metadata: { filename: "ward.png" } },
    ],
  } as Message;
  await persistThreadMessages([withImage], context(harness, thread.threadId, "scenario-a"), harness.config);
  // A later boundary re-publishes the same message as text only; the attachment must survive.
  await persistThreadMessages([userMessage("m1", "look")], context(harness, thread.threadId, "scenario-a"), harness.config);
  const [row] = await readThreadMessages(thread.threadId, harness.config);
  expect(row.attachments).toEqual([{ kind: "image", filename: "ward.png", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
});
```

`clear-repo.test.ts`, a new case in `describe("clear history")` (the file already imports `beginClear`, `finishClear`, `persistThreadMessages`, `selectActiveThread` and the harness. Add `dumpDatabase` from `./test-support`):

```ts
it("deletes attachment data with the messages (2by.10)", async () => {
  const harness = createAssistantHarness();
  const thread = await selectActiveThread("scenario-a", harness.config);
  await persistThreadMessages(
    [{ id: "m1", role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "data", value: "QVRUQUNITUVOVC1EQVRB", mimeType: "image/png" }, metadata: { filename: "ward.png" } },
    ] } as Message],
    { threadId: thread.threadId, scenarioId: "scenario-a", modelId: TEST_MODEL, turnId: "turn-1", globalGeneration: 0, scenarioGeneration: 0, createdAt: harness.now().toISOString() },
    harness.config,
  );
  expect(JSON.stringify(await dumpDatabase(harness.db))).toContain("QVRUQUNITUVOVC1EQVRB");
  await finishClear(await beginClear("history", "scenario-a", harness.config), harness.config);
  expect(JSON.stringify(await dumpDatabase(harness.db))).not.toContain("QVRUQUNITUVOVC1EQVRB");
});
```

`transcript.test.ts`, a new case:

```ts
it("lists attachments by name and type, never their data (2by.10)", () => {
  const md = buildTranscriptMarkdown({
    messages: [{ role: "user", content: "look", toolCalls: null, createdAt: "t",
      attachments: [{ kind: "image", filename: "ward.png", mimeType: "image/png", data: "SECRETDATA" }] }],
    receipts: [], appVersion: "v", exportedAt: new Date("2026-09-27T00:00:00Z"),
  });
  expect(md).toContain("Attached: ward.png (image/png)");
  expect(md).not.toContain("SECRETDATA");
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/assistant/messages-attachments.test.ts lib/ai/assistant/history-repo.test.ts lib/ai/assistant/clear-repo.test.ts lib/ai/assistant/transcript.test.ts`
Expected: FAIL. The clear case may pass already, because Clear deletes whole rows. Keep it anyway: it pins the acceptance criterion.

- [ ] **Step 3: Implement**

`records.ts`: add `AssistantAttachmentV1` (see "Interfaces"), and on `AssistantMessageV1`:

```ts
  /** 2by.10: a user message's images and text files. Absent on older rows. */
  attachments?: AssistantAttachmentV1[] | null;
```

`messages.ts`: in the header comment, replace "Attachments, activity messages…" with "Activity messages and provider-internal encrypted payloads are NOT persisted. Attachments are (2by.10), because the product promises to keep them with the conversation." Then add:

```ts
import type { UserMessage } from "@ag-ui/client";
import type { AssistantAttachmentV1 } from "./records";

type Part = { type?: string; source?: { type?: string; value?: string; mimeType?: string }; metadata?: { filename?: string } };

function readAttachments(content: unknown): AssistantAttachmentV1[] | null {
  if (!Array.isArray(content)) return null;
  const found = (content as Part[]).flatMap((part): AssistantAttachmentV1[] =>
    (part.type === "image" || part.type === "document") && part.source?.type === "data"
      ? [
          {
            kind: part.type === "image" ? "image" : "text",
            filename: part.metadata?.filename ?? "attachment",
            mimeType: part.source.mimeType ?? "application/octet-stream",
            data: part.source.value ?? "",
          },
        ]
      : [],
  );
  return found.length > 0 ? found : null;
}

/** A user message's content: plain text, or text followed by one part per attachment. */
export function toUserContent(
  text: string,
  attachments: readonly AssistantAttachmentV1[] | null,
): UserMessage["content"] {
  if (!attachments || attachments.length === 0) return text;
  return [
    { type: "text", text },
    ...attachments.map((a) => ({
      type: a.kind === "image" ? ("image" as const) : ("document" as const),
      source: { type: "data" as const, value: a.data, mimeType: a.mimeType },
      metadata: { filename: a.filename },
    })),
  ];
}
```

In `toCanonical`, add `attachments: readAttachments((message as { content?: unknown }).content),` next to `content`. In `toTransport`'s `"user"` case, return `{ id: record.messageId, role: "user", content: toUserContent(record.content, record.attachments ?? null) }`.

`history-repo.ts`, in the `prior ? {…}` branch of `persistThreadMessages`, add:

```ts
                attachments: canonical.attachments ?? prior.attachments ?? null,
```

`transcript.ts`: add `attachments?: readonly { filename: string; mimeType: string }[] | null;` to `TranscriptMessage`. After the content line in `buildTranscriptMarkdown`, add:

```ts
    for (const a of message.attachments ?? []) lines.push(`Attached: ${a.filename} (${a.mimeType})`);
```

- [ ] **Step 4: Run the assistant lib suite**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/assistant`
Expected: PASS. The clear suites (`clear-*.test.ts`) delete whole rows, so the attachment data goes with them.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments && git add web/lib/ai/assistant
git commit -m "feat(assistant): keep message attachments in local history (2by.10)"
```

### Task 4: Text files reach the model as text

**Files:**
- Create: `web/lib/ai/runtime/attachments.ts`
- Modify: `web/lib/ai/runtime/openrouter-agent.ts` (the `messages:` line in `streamText`, ~line 95)
- Test: `web/lib/ai/runtime/copilot-runtime.test.ts`

- [ ] **Step 1: Write the failing test** (in `describe("run")`, using the file's `launch`, `runRequest`, `readSse`):

```ts
it("sends an image as an image and a text file as text (2by.10)", async () => {
  const { runtime, provider } = launch();
  await readSse(
    await runtime.handler(
      runRequest({
        threadId: "t-attach",
        messages: [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "What does this show?" },
              { type: "image", source: { type: "data", value: "iVBORw0KGgo=", mimeType: "image/png" }, metadata: { filename: "ward.png" } },
              { type: "document", source: { type: "data", value: Buffer.from("Ana,leave,3 Nov").toString("base64"), mimeType: "text/csv" }, metadata: { filename: "leave.csv" } },
            ],
          },
        ],
      }),
    ),
  );
  const user = (provider.calls[0].body.messages as { role: string; content: unknown }[]).at(-1)!;
  const parts = user.content as { type: string; text?: string; image_url?: { url: string } }[];
  expect(parts[0]).toMatchObject({ type: "text", text: "What does this show?" });
  expect(parts.some((p) => p.type === "image_url" && p.image_url!.url.startsWith("data:image/png;base64,"))).toBe(true);
  expect(parts.some((p) => p.type === "text" && p.text!.startsWith('Attached file "leave.csv":\nAna,leave,3 Nov'))).toBe(true);
  expect(parts.some((p) => p.type === "file")).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/runtime/copilot-runtime.test.ts`
Expected: FAIL. The CSV reaches `@ai-sdk/openai` as a file part, which it rejects (a RUN_ERROR, and no user text part).

- [ ] **Step 3: Implement**

`attachments.ts`:

```ts
// Text-file attachments become plain text before the AI SDK sees them (2by.10). The
// OpenAI-compatible chat provider accepts images but not a text/* file part, and a
// text file is only text anyway. Server-only: it decodes with Buffer.

import type { Message } from "@ag-ui/client";

const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown"]);

export function inlineTextAttachments(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "document" || part.source.type !== "data") return part;
        if (!TEXT_TYPES.has(part.source.mimeType)) return part;
        const name = (part.metadata as { filename?: string } | undefined)?.filename ?? "attachment";
        const text = Buffer.from(part.source.value, "base64").toString("utf8");
        return { type: "text" as const, text: `Attached file "${name}":\n${text}` };
      }),
    };
  });
}
```

`openrouter-agent.ts`:

```ts
        messages: convertMessagesToVercelAISDKMessages(inlineTextAttachments(input.messages)),
```

and `import { inlineTextAttachments } from "./attachments";`. If the `part.source` narrowing does not typecheck against 0.0.57's union, narrow with `"source" in part`.

- [ ] **Step 4: Run it and see it pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run lib/ai/runtime`
Expected: PASS. The credential-leak scan in the same file still passes.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments && git add web/lib/ai/runtime
git commit -m "feat(assistant): pass text attachments to the model as text (2by.10)"
```

### Task 5: The send path carries attachments

**Files:**
- Modify: `web/components/ai/use-assistant-session.ts` (`AssistantSendOptions`, `runSend` user message ~line 463)
- Modify: `web/components/ai/use-assistant-follow-ups.ts` (the send signature and the returned user send)
- Modify: `web/components/ai/use-assistant-retry.ts` (`RetryTarget.attachments`, `retry`)
- Test: `web/components/ai/session-persistence.test.tsx`, `web/components/ai/use-assistant-follow-ups.test.tsx`, `web/components/ai/assistant-retry.test.tsx`

**Interfaces:** Consumes `toUserContent` and `AssistantAttachmentV1` (Task 3). Produces `AssistantSendOptions.attachments`. After this task, `useAssistantFollowUps` returns `(text: string, options?: AssistantSendOptions) => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`session-persistence.test.tsx` (use the file's existing mount, `settle` and `agent.clones` pattern):

```ts
it("sends and stores a message's attachments, and not when AI is not ready (2by.10)", async () => {
  const png = { kind: "image" as const, filename: "ward.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
  agent.shape = "answer";
  agent.answer = "a picture of a roster";
  await act(async () => { await session.current!.send("what is this?", { attachments: [png] }); });
  await settle();

  const hop = agent.clones.at(-1)!.hopInputs[0]!;
  const user = hop.messages.find((m) => m.role === "user" && JSON.stringify(m).includes("what is this?"))!;
  expect(JSON.stringify(user.content)).toContain('"type":"image"');
  const rows = await harness.db.assistantMessages.where("threadId").equals(threadId).toArray();
  expect(rows.find((r) => r.role === "user")?.attachments).toEqual([png]);
});
```

For the "not ready" half, reuse the file's existing not-ready refusal case: add `{ attachments: [png] }` to its `send`, and assert `harness.db.assistantMessages` holds no row with `attachments`.

`use-assistant-follow-ups.test.tsx`:

```ts
it("passes a user send's options through (2by.10)", async () => {
  const send = vi.fn(async () => true);
  const { result } = renderHook(() => useAssistantFollowUps(false, null, send));
  const png = { kind: "image" as const, filename: "a.png", mimeType: "image/png", data: "x" };
  await result.current("look", { attachments: [png] });
  expect(send).toHaveBeenCalledWith("look", { attachments: [png] });
});
```

`assistant-retry.test.tsx`: in the case that retries a failed turn, seed that turn's user row with `attachments: [png]`, and assert `send` is called with `{ replaceTurnId: <id>, attachments: [png] }`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run components/ai/session-persistence.test.tsx components/ai/use-assistant-follow-ups.test.tsx components/ai/assistant-retry.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`use-assistant-session.ts`:

```ts
export interface AssistantSendOptions {
  /** The failed or interrupted turn whose own messages this send replaces. */
  replaceTurnId?: string;
  /** 2by.10: the composer's ready attachments. Sent only through the gate, like the text. */
  attachments?: readonly AssistantAttachmentV1[];
}
```

In `runSend`, build the user message as:

```ts
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: toUserContent(plan.text, options?.attachments ?? null),
      };
```

(`prepareSend` refuses a not-ready assistant before this line, so nothing is stored or sent in that case.)

`use-assistant-follow-ups.ts`: change the `send` parameter type to `(text: string, options?: AssistantSendOptions) => Promise<boolean>`, keep the queued follow-up call as `send(text)`, and return:

```ts
  return (text: string, options?: AssistantSendOptions) => {
    userSends.current += 1;
    setWaiting(null);
    return send(text, options);
  };
```

In `assistant-conversation.tsx`, the inner send passed to `useAssistantFollowUps` becomes `(text, options) => { assistantActions.clearChoices(); return session.send(text, options); }`.

`use-assistant-retry.ts`: add `attachments: AssistantAttachmentV1[] | null;` to `RetryTarget`, set it from `question.attachments ?? null`, and send:

```ts
    void send(target.text, {
      replaceTurnId: target.turnId,
      ...(target.attachments ? { attachments: target.attachments } : {}),
    }).then(…)
```

- [ ] **Step 4: Run the component suite**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run components/ai`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments && git add web/components/ai
git commit -m "feat(assistant): send, store and retry message attachments (2by.10)"
```

### Task 6: The composer: attach, drop, paste, refuse with a reason

**Files:**
- Create: `web/components/ai/use-model-image-input.ts`
- Create: `web/components/ai/use-composer-attachments.ts`
- Modify: `web/components/ai/assistant-conversation.tsx` (`AssistantLiveConversation`)
- Modify: `web/app/globals.css` (§4 assistant block: chip filename truncation. Step 6 decides whether this is needed)
- Modify: `docs/ai-assistant.md`
- Test: `web/components/ai/use-composer-attachments.test.tsx` (new), `web/e2e/ai-assistant-chat-ui.spec.ts`

**Interfaces:** Consumes Task 2's rules, `AI_MODEL_CATALOG_URL` (`lib/ai/protocol.ts`), `ModelCatalog` (type only, `lib/ai/openrouter/catalog.ts`), `useAssistantStore((s) => s.settings.modelId)`, and `useAttachments` from `@copilotkit/react-core/v2`. Produces:

```ts
export interface ComposerAttachments {
  attachments: Attachment[];               // for CopilotChatView
  error: string | null;                    // the last refusal, cleared on the next pick
  accept: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  handleFileUpload: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDragOver: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => Promise<void>;
  dragOver: boolean;
  removeAttachment: (id: string) => void;
  /** Ready attachments as durable records, without clearing the queue. */
  ready: () => AssistantAttachmentV1[];
  /** Clear the ready ones after an accepted send. */
  consume: () => void;
}
```

- [ ] **Step 1: Write the failing test** (`use-composer-attachments.test.tsx`, jsdom):

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useComposerAttachments } from "./use-composer-attachments";

function Probe({ imageInput }: { imageInput: boolean }) {
  const a = useComposerAttachments(imageInput);
  return (
    <div ref={a.containerRef}>
      <input type="file" multiple hidden data-testid="file" ref={a.fileInputRef} accept={a.accept} onChange={a.handleFileUpload} />
      <p data-testid="error">{a.error ?? ""}</p>
      <p data-testid="ready">{JSON.stringify(a.ready().map((r) => [r.kind, r.filename, r.mimeType]))}</p>
    </div>
  );
}
const upload = (files: File[]) => userEvent.upload(screen.getByTestId("file"), files, { applyAccept: false });

describe("composer attachments (2by.10)", () => {
  it("queues a text file for any model and an image for a vision model", async () => {
    render(<Probe imageInput />);
    await upload([new File(["# notes"], "notes.md", { type: "" }), new File([new Uint8Array([137, 80, 78, 71])], "ward.png", { type: "image/png" })]);
    await waitFor(() =>
      expect(screen.getByTestId("ready").textContent).toBe(JSON.stringify([["text", "notes.md", "text/markdown"], ["image", "ward.png", "image/png"]])),
    );
  });

  it("refuses an image for a model that cannot read one, and queues nothing", async () => {
    render(<Probe imageInput={false} />);
    await upload([new File(["x"], "ward.png", { type: "image/png" })]);
    await waitFor(() => expect(screen.getByTestId("error").textContent).toMatch(/^This model cannot read images\./));
    expect(screen.getByTestId("ready").textContent).toBe("[]");
  });

  it("refuses a fifth file and an oversized text file", async () => {
    render(<Probe imageInput />);
    await upload([1, 2, 3, 4, 5].map((n) => new File(["x"], `f${n}.txt`, { type: "text/plain" })));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("You can attach up to 4 files to one message."));
    await upload([new File(["x".repeat(200 * 1024 + 1)], "big.txt", { type: "text/plain" })]);
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe('"big.txt" is larger than 200 KB.'));
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run components/ai/use-composer-attachments.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the two hooks**

`use-model-image-input.ts`:

```ts
"use client";

// Whether the selected model reads images, from OpenRouter's catalog (2by.10). The
// same-origin catalog route is memoised server-side for 15 minutes. Unknown = false.

import { useEffect, useState } from "react";
import { useAssistantStore } from "@/lib/ai/assistant/store";
import type { ModelCatalog } from "@/lib/ai/openrouter/catalog";
import { AI_MODEL_CATALOG_URL } from "@/lib/ai/protocol";

export function useModelImageInput(): boolean {
  const modelId = useAssistantStore((state) => state.settings.modelId);
  const [imageInput, setImageInput] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setImageInput(false);
    if (!modelId) return;
    void fetch(AI_MODEL_CATALOG_URL)
      .then((response) => response.json() as Promise<ModelCatalog>)
      .then((catalog) => {
        if (!cancelled) setImageInput(catalog.models.some((m) => m.id === modelId && m.imageInput));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [modelId]);
  return imageInput;
}
```

`use-composer-attachments.ts`:

```ts
"use client";

// The composer's attachments (2by.10): CopilotKit's own `useAttachments` (queue,
// picker, drag and drop, paste, chips) with this app's rules from attachment-rules.ts.

import { useCallback, useRef, useState } from "react";
import { useAttachments, type Attachment } from "@copilotkit/react-core/v2";
import { acceptFor, checkAttachment, MAX_IMAGE_BYTES } from "@/lib/ai/assistant/attachment-rules";
import type { AssistantAttachmentV1 } from "@/lib/ai/assistant/records";

/** Base64 without the data-URL prefix. FileReader, because it is in every browser and jsdom. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useComposerAttachments(imageInput: boolean) {
  const [error, setError] = useState<string | null>(null);
  const queued = useRef(0);
  const state = useAttachments({
    config: {
      enabled: true,
      accept: acceptFor(imageInput),
      maxSize: MAX_IMAGE_BYTES,
      onUpload: async (file) => {
        const verdict = checkAttachment(file, imageInput, queued.current);
        if (!verdict.ok) throw new Error(verdict.message);
        queued.current += 1;
        setError(null);
        return { type: "data", value: await readBase64(file), mimeType: verdict.mimeType };
      },
      // The library's own messages list MIME types; the app's rules say it plainly.
      onUploadFailed: ({ file, message, reason }) => {
        const verdict = checkAttachment(file, imageInput, queued.current);
        setError(reason === "upload-failed" || verdict.ok ? message : verdict.message);
      },
    },
  });
  queued.current = state.attachments.length;

  const ready = useCallback(
    (): AssistantAttachmentV1[] =>
      state.attachments
        .filter((a: Attachment) => a.status === "ready" && a.source.type === "data")
        .map((a: Attachment) => ({
          kind: a.type === "image" ? "image" : "text",
          filename: a.filename ?? "attachment",
          mimeType: a.source.mimeType ?? "application/octet-stream",
          data: a.source.value,
        })),
    [state.attachments],
  );

  return {
    ...state,
    error,
    accept: acceptFor(imageInput),
    ready,
    consume: () => {
      state.consumeAttachments();
      setError(null);
    },
  };
}
```

`queued.current` is set from the render state and raised inside `onUpload`, so a batch of 5 counts its own earlier files. `useAttachments` awaits each file in turn (`processFiles`), so `onUpload` runs serially. If typecheck rejects `a.source.mimeType` on the URL-source branch, keep the `?? "application/octet-stream"` and narrow with the `a.source.type === "data"` guard already in the filter.

- [ ] **Step 4: Run it and see it pass**

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run components/ai/use-composer-attachments.test.tsx`
Expected: PASS. If `useAttachments` throws outside a CopilotKit provider, wrap `Probe` in the provider that `assistant-panel.test.tsx` uses.

- [ ] **Step 5: Wire the composer** (`assistant-conversation.tsx`, `AssistantLiveConversation`)

```tsx
  const imageInput = useModelImageInput();
  const attach = useComposerAttachments(imageInput);
  // Only a composer submit carries files. Cards and follow-ups send text alone.
  const submit = useCallback(
    (text: string) => {
      const files = attach.ready();
      void sendMessage(text, files.length > 0 ? { attachments: files } : undefined).then(
        (accepted) => {
          if (accepted && files.length > 0) attach.consume();
        },
      );
    },
    [attach, sendMessage],
  );
```

Put `ref={attach.containerRef}` on the root `div` (so paste works inside the panel). Render, just before `<ActivityContext.Provider>`:

```tsx
      <input
        type="file"
        multiple
        hidden
        ref={attach.fileInputRef}
        accept={attach.accept}
        onChange={attach.handleFileUpload}
        data-testid="assistant-file-input"
      />
      {attach.error && (
        <p className="truncate px-4 pb-2 text-meta text-errorink" role="status" title={attach.error} data-testid="assistant-attach-error">
          {attach.error}
        </p>
      )}
      {attach.attachments.length > 0 && (
        <p className="px-4 pb-2 text-meta text-ink2" data-testid="assistant-attach-privacy">
          {ATTACHMENT_PRIVACY_NOTE}
        </p>
      )}
```

On `CopilotChatView`, replace `onSubmitMessage={sendMessage}` with `onSubmitMessage={submit}`, and add:

```tsx
            attachments={attach.attachments}
            onRemoveAttachment={attach.removeAttachment}
            onAddFile={() => attach.fileInputRef.current?.click()}
            dragOver={attach.dragOver}
            onDragOver={attach.handleDragOver}
            onDragLeave={attach.handleDragLeave}
            onDrop={attach.handleDrop}
```

`dock.onSend` stays `sendMessage`: cards never carry files.

- [ ] **Step 6: Real-browser check** (`web/e2e/ai-assistant-chat-ui.spec.ts`, which already opens a ready panel with no live provider)

```ts
test("queues an attachment chip without overflowing the composer (2by.10)", async ({ page }) => {
  // Reuse the spec's own "open a ready panel" setup. The catalog route it fulfils must
  // list the sentinel model with imageInput: true.
  const long = `${"very-long-roster-file-name-".repeat(5)}.csv`;
  await page.getByTestId("assistant-file-input").setInputFiles({ name: long, mimeType: "text/csv", buffer: Buffer.from("Ana,leave") });
  await expect(page.getByTestId("assistant-attach-privacy")).toBeVisible();
  const composer = page.locator("[data-assistant-dock]").locator("..");
  const chip = page.getByText(/very-long-roster-file-name/).first();
  const [chipBox, composerBox] = [await chip.boundingBox(), await composer.boundingBox()];
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width + 1);
});
```

Run: `cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm test:e2e e2e/ai-assistant-chat-ui.spec.ts`. An overflowing chip needs a scoped rule in `globals.css` §4. Give the library's attachment filename `max-width: 100%`, `overflow: hidden`, `text-overflow: ellipsis` and `white-space: nowrap`. Find its class with the browser inspector, and key it the way §4 keys the other `cpk:` classes. Extend `assistant-styles.test.ts` the way it covers the other §4 rules. The library chip lacks a `title`, so the full name stays in the tooltip of our error line and in the transcript. Record this in the commit message.

- [ ] **Step 7: Docs** (`docs/ai-assistant.md`)

Under "What leaves your browser", add:

```markdown
- images and text files you attach to a message (PNG, JPEG, WebP or GIF up to 5 MB;
  .txt, .csv or .md up to 200 KB; at most 4 per message). Images need a model that reads
  images; the panel says so when yours does not.
```

In the "What is stored" table, change the Conversations row to `Conversations, attachments, previews and receipts`. Clear conversation history deletes attachments with the messages.

- [ ] **Step 8: Gate, commit, close**

```bash
cd /home/kenan/work/nursing-sheduler.feat-2by10-attachments/web && pnpm vitest run components/ai lib/ai && pnpm typecheck && pnpm lint && pnpm format:check
cd .. && git add web docs/ai-assistant.md
git commit -m "feat(assistant): attach images and text files in the composer (2by.10)"
bd close nursing-sheduler-2by.10
```

## Cross-plan note

`2026-09-27-assistant-history-auto-compact.md` (ypo) summarises old turns. The plan that lands second must make `historyChars` count each attachment as 1,000 characters. It must also make `transcriptForSummary` write `[attached image: <filename>]` or `[attached file: <filename>]` instead of the data. Without ypo, every later turn resends each image in the thread. That is correct, but it costs more on long image threads.

## Unresolved questions

1. **Resend images on every later turn?** I recommend yes, until ypo lands. It is what "stored with the conversation" means for the model, and ypo's compaction then drops old images.
2. **Show "reads images" next to models in Settings?** I recommend a follow-up bead, not this plan. At the moment of an attach, the composer already explains the limit.
3. **Allow an attachment with no typed text?** I recommend no, for now. `CopilotChatInput` sends on text, and a question about the file is almost always wanted.

## Assumptions

- `CopilotChatView` renders `attachments` as chips in its composer and forwards `onAddFile` and the drag and drop handlers there. This comes from its `.d.mts` props. Step 6 checks it in a real browser.
- The CopilotKit runtime route accepts a run request of about 30 MB (4 images of 5 MB, base64). If it does not, lower `MAX_IMAGE_BYTES`. Step 6 does not cover this. Check it manually with a real key before merging.
- `@ai-sdk/openai` 3.0.36 sends an AI SDK image part to `/chat/completions` as `image_url` with a data URL. Task 4 proves this.

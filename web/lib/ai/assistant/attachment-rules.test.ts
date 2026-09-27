import { describe, expect, it } from "vitest";

import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  acceptFor,
  checkAttachment,
  contentMatches,
} from "./attachment-rules";

const file = (name: string, type: string, size = 10) => ({ name, type, size });
const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("attachment rules (2by.10)", () => {
  it("takes the four image types for a vision model, and text files for any model", () => {
    expect(checkAttachment(file("ward.png", "image/png"), true, 0)).toEqual({
      ok: true,
      kind: "image",
      mimeType: "image/png",
    });
    expect(checkAttachment(file("notes.md", ""), false, 0)).toEqual({
      ok: true,
      kind: "text",
      mimeType: "text/markdown",
    });
    expect(checkAttachment(file("leave.CSV", "application/vnd.ms-excel"), false, 0)).toEqual({
      ok: true,
      kind: "text",
      mimeType: "text/csv",
    });
  });

  it("refuses an image for a model that cannot read one, with the way out", () => {
    expect(checkAttachment(file("ward.png", "image/png"), false, 0)).toEqual({
      ok: false,
      message:
        "This model cannot read images. Choose one that can in Settings → AI assistant, or attach a .txt, .csv or .md file.",
    });
  });

  it("enforces type, size and count", () => {
    expect(checkAttachment(file("rota.pdf", "application/pdf"), true, 0)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^"rota.pdf" cannot be attached\./),
    });
    expect(checkAttachment(file("noext", ""), true, 0)).toMatchObject({ ok: false });
    expect(checkAttachment(file("big.jpg", "image/jpeg", MAX_IMAGE_BYTES + 1), true, 0)).toEqual({
      ok: false,
      message: '"big.jpg" is larger than 3.75 MB.',
    });
    expect(checkAttachment(file("big.txt", "text/plain", MAX_TEXT_BYTES + 1), true, 0)).toEqual({
      ok: false,
      message: '"big.txt" is larger than 200 KB.',
    });
    expect(checkAttachment(file("a.txt", "text/plain"), true, MAX_ATTACHMENTS)).toEqual({
      ok: false,
      message: "You can attach up to 4 files to one message.",
    });
  });

  it("keeps an image's base64 within Anthropic's 5,242,880-byte limit", () => {
    expect(MAX_IMAGE_BYTES).toBe(3.75 * 1024 * 1024);
    expect(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(5_242_880);
    expect(checkAttachment(file("ok.png", "image/png", MAX_IMAGE_BYTES), true, 0)).toMatchObject({
      ok: true,
    });
  });

  it("offers images in the picker only to a vision model", () => {
    expect(acceptFor(true)).toContain("image/png");
    expect(acceptFor(false)).not.toContain("image/");
    expect(acceptFor(false)).toContain(".md");
  });

  it("checks a file's bytes against its declared type, not its name", () => {
    expect(
      contentMatches("image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)),
    ).toBe(true);
    expect(contentMatches("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
    expect(contentMatches("image/gif", ascii("GIF89a..."))).toBe(true);
    expect(contentMatches("image/webp", ascii("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(contentMatches("text/csv", ascii("Ana,leave,3 Nov"))).toBe(true);
    expect(contentMatches("text/markdown", ascii(""))).toBe(true);

    // A renamed executable, a PNG claiming to be a JPEG, a binary "text" file.
    expect(contentMatches("image/png", ascii("MZ\x90\0"))).toBe(false);
    expect(
      contentMatches("image/jpeg", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe(false);
    expect(contentMatches("text/plain", bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0xff))).toBe(false);
    expect(contentMatches("text/plain", bytes(0xc3, 0x28))).toBe(false);
    expect(contentMatches("application/pdf", ascii("%PDF-1.7"))).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES } from "./attachment-rules";
import { SHRINK_LONG_SIDE, shrinkImage } from "./shrink-image";

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const jpegOfSize = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(JPEG_MAGIC);
  return new Blob([bytes], { type: "image/jpeg" });
};

/** createImageBitmap and OffscreenCanvas as a browser has them, encoding to `encoded` bytes. */
function stubCanvas(width: number, height: number, encoded: number) {
  const drawn: unknown[][] = [];
  const canvases: { width: number; height: number; type?: string }[] = [];
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {
        canvases.push(this);
      }
      getContext() {
        return { fillRect: () => {}, drawImage: (...args: unknown[]) => drawn.push(args) };
      }
      async convertToBlob(options: { type: string }) {
        canvases[0].type = options.type;
        return jpegOfSize(encoded);
      }
    },
  );
  return { drawn, canvases, close };
}

afterEach(() => vi.unstubAllGlobals());

describe("shrinking a large photo (j6dk)", () => {
  it("scales a 6 MB photo to a 2000 px long side and re-encodes it as JPEG under the cap", async () => {
    const { drawn, canvases, close } = stubCanvas(4000, 3000, 900_000);
    const photo = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" });

    const shrunk = await shrinkImage(photo);

    expect(SHRINK_LONG_SIDE).toBe(2000);
    expect(canvases).toEqual([{ width: 2000, height: 1500, type: "image/jpeg" }]);
    expect(drawn[0].slice(1)).toEqual([0, 0, 2000, 1500]);
    expect(shrunk?.length).toBe(900_000);
    expect(shrunk!.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect([...shrunk!.subarray(0, 4)]).toEqual(JPEG_MAGIC);
    expect(close).toHaveBeenCalled();
  });

  it("keeps a small-but-heavy image at its size, and gives up when it still does not fit", async () => {
    const { canvases } = stubCanvas(1200, 1800, MAX_IMAGE_BYTES + 1);
    expect(await shrinkImage(new Blob([new Uint8Array(10)]))).toBeNull();
    expect(canvases[0]).toMatchObject({ width: 1200, height: 1800 });
  });
});

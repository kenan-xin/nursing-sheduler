// A photo over the image cap, shrunk in the browser (bead j6dk): a phone photo of a
// paper roster is often 4-8 MB. Native createImageBitmap + OffscreenCanvas, no
// dependency. The result is always JPEG: every vision model reads it, and Safari's
// canvas cannot encode WebP.

import { MAX_IMAGE_BYTES } from "./attachment-rules";

export const SHRINK_LONG_SIDE = 2000;
const JPEG_QUALITY = 0.85;

/**
 * The image re-encoded as JPEG with its long side at most {@link SHRINK_LONG_SIDE}
 * px, or null when that still exceeds {@link MAX_IMAGE_BYTES}. Throws when the
 * browser cannot decode it. Only the first frame of an animated GIF survives.
 */
export async function shrinkImage(image: Blob): Promise<Uint8Array | null> {
  // "from-image" applies a phone photo's EXIF rotation before the pixels are redrawn.
  const bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, SHRINK_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    // JPEG has no transparency: a transparent PNG's background becomes white, not black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    return jpeg.size > MAX_IMAGE_BYTES ? null : new Uint8Array(await jpeg.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

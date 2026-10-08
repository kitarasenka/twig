/**
 * Which files the image viewer opens, by extension: the raster formats
 * Chromium decodes. SVG is left out on purpose — it is text, and its text diff
 * is the honest view of it. No imports: main, the renderer and the Node checks
 * all load this file.
 */
export const IMAGE_TYPES = Object.freeze({
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
});

/** Bytes per side the viewer reads; a larger version is reported by size only. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** The MIME type for an image path, or null when the viewer does not open it. */
export function imageType(path) {
  if (typeof path !== 'string') return null;
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return Object.hasOwn(IMAGE_TYPES, name.slice(dot + 1)) ? IMAGE_TYPES[name.slice(dot + 1)] : null;
}

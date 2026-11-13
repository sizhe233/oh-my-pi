/**
 * Form pictures are bounded inline raster data. File/network sources and SVG are refused.
 *
 * @example
 * const media = await loadFormImage("data:image/png;base64,...", { cwd, signal });
 * media.mime; // "image/png"
 */
import { parseImageMetadata } from "@oh-my-pi/pi-utils";

/** An image's bytes and MIME type. */
export interface FormMedia {
	bytes: Uint8Array;
	mime: string;
}

/** Caller context and cancellation; cwd never grants form images file access. */
export interface FormMediaOptions {
	cwd: string;
	signal?: AbortSignal;
}

/** Largest picture a form loads. */
export const MAX_FORM_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Load an inline `<img src>` data URI. Files and network URLs are refused.
 *
 * @throws {Error} the source cannot be read, exceeds {@link MAX_FORM_IMAGE_BYTES},
 * is cancelled, or is not a PNG, JPEG, GIF, WebP or SVG image.
 */
export async function loadFormImage(src: string, options: FormMediaOptions): Promise<FormMedia> {
	const bytes = await readSource(src, options);
	if (bytes.byteLength > MAX_FORM_IMAGE_BYTES) throw new Error(`larger than ${MAX_FORM_IMAGE_BYTES >> 20} MiB`);
	const raster = parseImageMetadata(bytes.subarray(0, 64));
	if (raster) return { bytes, mime: raster.mimeType };
	const text = new TextDecoder().decode(bytes.subarray(0, 4096));
	if (/<svg[\s>]/i.test(text)) return svgMedia(new TextDecoder().decode(bytes));
	throw new Error("not a PNG, JPEG, GIF, WebP or SVG image");
}

/** SVG form images are refused until every terminal renderer enforces the same I/O boundary. */
export function svgMedia(_markup: string): FormMedia {
	throw new Error("SVG form images are disabled; use an inline PNG, JPEG, GIF or WebP image");
}

async function readSource(src: string, options: FormMediaOptions): Promise<Uint8Array> {
	options.signal?.throwIfAborted();
	if (!/^data:/i.test(src)) {
		throw new Error("Form images must be inline data; automatic file and network reads are disabled");
	}
	return decodeDataUri(src);
}

/** Decode bounded inline media without opening files or issuing network requests. */
function decodeDataUri(uri: string): Uint8Array {
	// Bound encoded input before slicing, stripping whitespace, or decoding.
	if (uri.length > MAX_FORM_IMAGE_BYTES * 3 + 256) throw new Error("inline image is too large");
	const comma = uri.indexOf(",");
	if (comma === -1 || comma > 256) throw new Error("malformed data: URI");
	const header = uri.slice(5, comma);
	const payload = uri.slice(comma + 1);
	if (/;base64$/i.test(header)) {
		const compact = payload.replace(/\s+/g, "");
		if (compact.length > Math.ceil(MAX_FORM_IMAGE_BYTES / 3) * 4) throw new Error("inline image is too large");
		return Uint8Array.fromBase64(compact);
	}
	const decoded = decodeURIComponent(payload);
	if (Buffer.byteLength(decoded, "utf8") > MAX_FORM_IMAGE_BYTES) throw new Error("inline image is too large");
	return new TextEncoder().encode(decoded);
}

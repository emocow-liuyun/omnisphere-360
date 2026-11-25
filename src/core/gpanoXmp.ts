import type { GPanoMetadata } from './types';

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const GPANO_NS = 'http://ns.google.com/photos/1.0/panorama/';

/**
 * Build standard Google Photo Sphere (GPano) XMP XML packet.
 */
export function buildGPanoXmpXml(meta: GPanoMetadata): string {
  const headingTag =
    typeof meta.poseHeadingDegrees === 'number' && Number.isFinite(meta.poseHeadingDegrees)
      ? `\n      GPano:PoseHeadingDegrees="${meta.poseHeadingDegrees.toFixed(2)}"`
      : '';

  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:GPano="${GPANO_NS}"
      GPano:ProjectionType="${meta.projectionType}"
      GPano:UsePanoramaViewer="${meta.usePanoramaViewer ? 'True' : 'False'}"
      GPano:FullPanoWidthPixels="${Math.round(meta.fullPanoWidthPixels)}"
      GPano:FullPanoHeightPixels="${Math.round(meta.fullPanoHeightPixels)}"
      GPano:CroppedAreaImageWidthPixels="${Math.round(meta.croppedAreaImageWidthPixels)}"
      GPano:CroppedAreaImageHeightPixels="${Math.round(meta.croppedAreaImageHeightPixels)}"
      GPano:CroppedAreaLeftPixels="${Math.round(meta.croppedAreaLeftPixels)}"
      GPano:CroppedAreaTopPixels="${Math.round(meta.croppedAreaTopPixels)}"
      GPano:StitchingSoftware="${escapeXml(meta.stitchingSoftware)}"
      GPano:CaptureSoftware="${escapeXml(meta.captureSoftware)}"${headingTag} />
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Idempotently inject GPano XMP metadata into a JPEG byte buffer:
 * - Preserves JFIF (APP0) and Exif (APP1) segments in their original order
 * - Replaces any existing XMP APP1 segment instead of duplicating it
 * - Handles 0xFF marker fill bytes cleanly
 */
export function injectGPanoXmpIntoJpeg(
  jpegBytes: Uint8Array,
  meta: GPanoMetadata
): Uint8Array {
  if (jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    throw new Error('Invalid JPEG buffer: missing SOI (0xFFD8) marker');
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const headerBytes = encoder.encode(XMP_HEADER);
  const xmlBytes = encoder.encode(buildGPanoXmpXml(meta));
  const payloadLength = headerBytes.length + xmlBytes.length;
  const segmentLength = payloadLength + 2;

  if (segmentLength > 65535) {
    throw new Error('XMP packet exceeds JPEG APP1 64KB limit');
  }

  const app1Segment = new Uint8Array(2 + 2 + payloadLength);
  app1Segment[0] = 0xff;
  app1Segment[1] = 0xe1;
  app1Segment[2] = (segmentLength >> 8) & 0xff;
  app1Segment[3] = segmentLength & 0xff;
  app1Segment.set(headerBytes, 4);
  app1Segment.set(xmlBytes, 4 + headerBytes.length);

  // Walk header segments up to SOS (0xDA) or EOI (0xD9), keeping APP0/Exif and stripping old XMP
  const chunks: Uint8Array[] = [jpegBytes.subarray(0, 2)];
  let offset = 2;
  let inserted = false;

  while (offset < jpegBytes.length) {
    // Skip marker fill bytes (0xFF)
    while (offset < jpegBytes.length && jpegBytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= jpegBytes.length) break;

    const marker = jpegBytes[offset];
    const markerStart = offset - 1;
    offset++;

    // Standalone markers (RST0..7, TEM, SOI, EOI) or SOS (0xDA)
    if (marker === 0xda || marker === 0xd9) {
      if (!inserted) {
        chunks.push(app1Segment);
        inserted = true;
      }
      chunks.push(jpegBytes.subarray(markerStart));
      break;
    }

    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      chunks.push(jpegBytes.subarray(markerStart, offset));
      continue;
    }

    if (offset + 2 > jpegBytes.length) {
      if (!inserted) {
        chunks.push(app1Segment);
        inserted = true;
      }
      chunks.push(jpegBytes.subarray(markerStart));
      break;
    }

    const segLen = (jpegBytes[offset] << 8) | jpegBytes[offset + 1];
    const segEnd = offset + segLen;
    if (segLen < 2 || segEnd > jpegBytes.length) {
      throw new Error('Corrupt JPEG segment length');
    }

    const isExistingXmp =
      marker === 0xe1 &&
      segLen >= 2 + headerBytes.length &&
      decoder.decode(jpegBytes.subarray(offset + 2, offset + 2 + headerBytes.length)) ===
        XMP_HEADER;

    if (!isExistingXmp) {
      chunks.push(jpegBytes.subarray(markerStart, segEnd));
      // Insert right after APP0 (JFIF) or Exif APP1 so standard segment order is preserved
      if (!inserted && (marker === 0xe0 || marker === 0xe1)) {
        chunks.push(app1Segment);
        inserted = true;
      }
    }

    offset = segEnd;
  }

  if (!inserted) {
    chunks.push(app1Segment);
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const output = new Uint8Array(totalLen);
  let cursor = 0;
  for (const c of chunks) {
    output.set(c, cursor);
    cursor += c.length;
  }
  return output;
}

/**
 * Extract GPano XMP XML string from a JPEG byte buffer if present (verifies GPano namespace).
 */
export function extractGPanoXmpFromJpeg(jpegBytes: Uint8Array): string | null {
  if (jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    return null;
  }

  const decoder = new TextDecoder();
  let offset = 2;

  while (offset < jpegBytes.length) {
    while (offset < jpegBytes.length && jpegBytes[offset] === 0xff) {
      offset++;
    }
    if (offset >= jpegBytes.length) break;

    const marker = jpegBytes[offset];
    offset++;

    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > jpegBytes.length) break;

    const segLen = (jpegBytes[offset] << 8) | jpegBytes[offset + 1];
    if (segLen < 2 || offset + segLen > jpegBytes.length) break;

    if (marker === 0xe1) {
      const payload = jpegBytes.subarray(offset + 2, offset + segLen);
      const text = decoder.decode(payload);
      if (text.startsWith(XMP_HEADER)) {
        const xml = text.slice(XMP_HEADER.length);
        if (xml.includes(GPANO_NS) || xml.includes('GPano:')) {
          return xml;
        }
      }
    }

    offset += segLen;
  }

  return null;
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToJpegDataUrl(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

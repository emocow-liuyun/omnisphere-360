import { describe, expect, it } from 'vitest';
import {
  buildGPanoXmpXml,
  extractGPanoXmpFromJpeg,
  injectGPanoXmpIntoJpeg,
} from '../src/core/gpanoXmp';

function buildRealisticJpegWithJfifAndExif(): Uint8Array {
  // SOI (FF D8) + APP0 JFIF (FF E0, len 16) + APP1 Exif (FF E1, len 12) + SOS (FF DA) + EOI (FF D9)
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const exif = [0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a];
  return new Uint8Array([0xff, 0xd8, ...app0, ...exif, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
}

describe('gpanoXmp', () => {
  it('preserves JFIF/Exif segments and injects GPano XMP idempotently', () => {
    const jpeg = buildRealisticJpegWithJfifAndExif();
    const meta = {
      projectionType: 'equirectangular' as const,
      usePanoramaViewer: true,
      fullPanoWidthPixels: 4096,
      fullPanoHeightPixels: 2048,
      croppedAreaImageWidthPixels: 4096,
      croppedAreaImageHeightPixels: 2048,
      croppedAreaLeftPixels: 0,
      croppedAreaTopPixels: 0,
      stitchingSoftware: 'OmniSphere 360',
      captureSoftware: 'OmniSphere 360',
    };

    const once = injectGPanoXmpIntoJpeg(jpeg, meta);
    const twice = injectGPanoXmpIntoJpeg(once, { ...meta, fullPanoWidthPixels: 2048 });

    // APP0 JFIF remains immediately after SOI
    expect(once[2]).toBe(0xff);
    expect(once[3]).toBe(0xe0);

    // Exif APP1 remains intact
    const textOnce = new TextDecoder().decode(once);
    expect(textOnce).toContain('Exif');

    // Second injection replaces existing XMP instead of duplicating it
    const xmpHeaderCount = new TextDecoder()
      .decode(twice)
      .split('http://ns.adobe.com/xap/1.0/').length - 1;
    expect(xmpHeaderCount).toBe(1);

    const extracted = extractGPanoXmpFromJpeg(twice);
    expect(extracted).not.toBeNull();
    expect(extracted).toContain('GPano:FullPanoWidthPixels="2048"');
  });

  it('ignores non-GPano XMP packets during extraction', () => {
    const encoder = new TextEncoder();
    const nonGpanoPayload = encoder.encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>plain</x:xmpmeta>');
    const segLen = nonGpanoPayload.length + 2;
    const jpeg = new Uint8Array(2 + 4 + nonGpanoPayload.length + 2);
    jpeg.set([0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff], 0);
    jpeg.set(nonGpanoPayload, 6);
    jpeg.set([0xff, 0xd9], 6 + nonGpanoPayload.length);

    expect(extractGPanoXmpFromJpeg(jpeg)).toBeNull();
  });

  it('escapes XML special characters and omits uncalibrated heading when undefined', () => {
    const xml = buildGPanoXmpXml({
      projectionType: 'equirectangular',
      usePanoramaViewer: true,
      fullPanoWidthPixels: 2048,
      fullPanoHeightPixels: 1024,
      croppedAreaImageWidthPixels: 2048,
      croppedAreaImageHeightPixels: 1024,
      croppedAreaLeftPixels: 0,
      croppedAreaTopPixels: 0,
      stitchingSoftware: 'Omni & "Sphere" <360>',
      captureSoftware: 'Cam',
    });
    expect(xml).toContain('Omni &amp; &quot;Sphere&quot; &lt;360&gt;');
    expect(xml).not.toContain('PoseHeadingDegrees');
  });
});

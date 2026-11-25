import { Directory, Filesystem } from '@capacitor/filesystem';
import type { CapturedFrame, StitchProgress, StitchResult } from '../types';
import { computeActualFrustumCoveragePercent } from '../sphereLattice';
import { bytesToJpegDataUrl, dataUrlToBytes, injectGPanoXmpIntoJpeg } from '../gpanoXmp';
import { canUseNativeOpenCV, OmniStitcher } from './nativeBridge';
import { stitchFramesEquirectangular } from './webglStitcher';

export interface StitchPipelineOptions {
  jobId?: string;
  outputWidth?: number;
  jpegQuality?: number;
  warpMode?: 'spherical' | 'cylindrical';
  onProgress?: (progress: StitchProgress) => void;
}

function uriToLocalPath(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length));
  }
  return uri;
}

/**
 * Unified dual-engine panorama stitcher:
 * 1. On iOS / Android native Capacitor builds with OpenCV linked: writes frames and output
 *    inside the same Directory.Cache session directory so Filesystem readback is symmetric
 *    and safe across both platforms.
 * 2. On Web / PWA or fallback: uses on-device CPU/Canvas equirectangular stitcher.
 */
export async function runPanoramaStitch(
  frames: CapturedFrame[],
  options: StitchPipelineOptions = {}
): Promise<StitchResult> {
  const jobId = options.jobId ?? `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const outputWidth = options.outputWidth ?? 4096;
  const jpegQuality = options.jpegQuality ?? 0.92;
  const warpMode = options.warpMode ?? 'spherical';

  const nativeAvailable = await canUseNativeOpenCV();
  if (nativeAvailable) {
    const sessionDir = `omnisphere_stitch_${jobId}`;
    const outputRelPath = `${sessionDir}/stitched.jpg`;
    let progressHandle: { remove: () => Promise<void> } | null = null;

    try {
      progressHandle = await OmniStitcher.addListener('stitchProgress', (ev) => {
        if (ev.jobId && ev.jobId !== jobId) return;
        options.onProgress?.({
          jobId,
          stage: ev.stage,
          progress: ev.progress,
          message: ev.message,
          engine: 'native-opencv',
        });
      });

      options.onProgress?.({
        jobId,
        stage: 'preparing',
        progress: 0.05,
        message: '正在将采样帧写入原生缓存...',
        engine: 'native-opencv',
      });

      const nativeInputs = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const relPath = `${sessionDir}/frame_${String(i).padStart(3, '0')}.jpg`;
        const base64 = f.imageDataUrl.includes(',')
          ? f.imageDataUrl.split(',')[1]
          : f.imageDataUrl;
        const written = await Filesystem.writeFile({
          path: relPath,
          data: base64,
          directory: Directory.Cache,
          recursive: true,
        });
        nativeInputs.push({
          filePath: uriToLocalPath(written.uri),
          yawDeg: f.orientation.yawDeg,
          pitchDeg: f.orientation.pitchDeg,
          rollDeg: f.orientation.rollDeg,
        });
      }

      const outputUriRes = await Filesystem.getUri({
        path: outputRelPath,
        directory: Directory.Cache,
      });

      const nativeRes = await OmniStitcher.stitchPanorama({
        jobId,
        frames: nativeInputs,
        outputFilePath: uriToLocalPath(outputUriRes.uri),
        outputWidth,
        jpegQuality: Math.round(jpegQuality * 100),
        warpMode,
        blendStrength: 5,
      });

      // Read back via Directory.Cache relative path (avoids Android null-scheme NPE)
      const readBack = await Filesystem.readFile({
        path: outputRelPath,
        directory: Directory.Cache,
      });
      const rawDataUrl = `data:image/jpeg;base64,${readBack.data}`;
      const rawBytes = dataUrlToBytes(rawDataUrl);

      const usedFrames = nativeRes.usedIndices
        .map((idx) => frames[idx])
        .filter((f): f is CapturedFrame => Boolean(f));
      const coveragePercent = computeActualFrustumCoveragePercent(
        usedFrames.length > 0 ? usedFrames : []
      );
      const isFullSphere = nativeRes.isFullSphere && coveragePercent >= 95;

      // Derive true angular span from usedFrames when partial so GPano fullPanoWidth reflects real FOV
      let fullPanoWidth = nativeRes.width;
      let fullPanoHeight = nativeRes.height;
      let cropLeft = 0;
      let cropTop = 0;

      if (!isFullSphere && usedFrames.length > 0) {
        const pitches = usedFrames.map((f) => f.orientation.pitchDeg);
        const halfV = (usedFrames[0].fovVerticalDeg || 46) * 0.5;
        const minPitch = Math.max(-90, Math.min(...pitches) - halfV);
        const maxPitch = Math.min(90, Math.max(...pitches) + halfV);
        const pitchSpanDeg = Math.max(30, maxPitch - minPitch);

        // Estimate horizontal span from aspect ratio & pitch span (clamped to [45°, 360°])
        const estYawSpanDeg = Math.min(
          360,
          Math.max(45, pitchSpanDeg * (nativeRes.width / Math.max(1, nativeRes.height)))
        );
        fullPanoWidth = Math.max(
          nativeRes.width,
          Math.round(nativeRes.width * (360 / estYawSpanDeg))
        );
        fullPanoHeight = Math.max(nativeRes.height, Math.round(fullPanoWidth / 2));
        cropLeft = Math.max(0, Math.round((fullPanoWidth - nativeRes.width) * 0.5));
        cropTop = Math.max(0, Math.round(((90 - maxPitch) / 180) * fullPanoHeight));
      }

      const xmpBytes = injectGPanoXmpIntoJpeg(rawBytes, {
        projectionType: warpMode === 'cylindrical' ? 'cylindrical' : 'equirectangular',
        usePanoramaViewer: true,
        fullPanoWidthPixels: fullPanoWidth,
        fullPanoHeightPixels: fullPanoHeight,
        croppedAreaImageWidthPixels: nativeRes.width,
        croppedAreaImageHeightPixels: nativeRes.height,
        croppedAreaLeftPixels: cropLeft,
        croppedAreaTopPixels: cropTop,
        stitchingSoftware: 'OmniSphere 360 Native OpenCV Stitcher',
        captureSoftware: 'OmniSphere 360 Camera',
      });

      return {
        equirectangularDataUrl: bytesToJpegDataUrl(xmpBytes),
        jpegBytes: xmpBytes,
        width: nativeRes.width,
        height: nativeRes.height,
        fullPanoWidth,
        fullPanoHeight,
        cropLeft,
        cropTop,
        isFullSphere,
        coveragePercent,
        engine: 'native-opencv',
        usedFrameCount: nativeRes.usedIndices.length,
        elapsedMs: nativeRes.elapsedMs,
        hasGpanoXmp: true,
      };
    } catch (err) {
      options.onProgress?.({
        jobId,
        stage: 'preparing',
        progress: 0.08,
        message: `原生拼接回退至端侧球面融合 (${err instanceof Error ? err.message : 'fallback'})`,
        engine: 'cpu-canvas',
      });
    } finally {
      if (progressHandle) {
        await progressHandle.remove().catch(() => {});
      }
      await Filesystem.rmdir({
        path: sessionDir,
        directory: Directory.Cache,
        recursive: true,
      }).catch(() => {});
    }
  }

  const webWidth = Math.min(outputWidth, 2048);
  return stitchFramesEquirectangular(frames, {
    jobId,
    outputWidth: webWidth,
    jpegQuality,
    onProgress: options.onProgress,
  });
}

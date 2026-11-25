import type { CapturedFrame, StitchProgress, StitchResult } from '../types';
import { createCameraPose, mulMat3Vec3, type Mat3 } from '../cameraPose';
import { computeActualFrustumCoveragePercent } from '../sphereLattice';
import { bytesToJpegDataUrl, dataUrlToBytes, injectGPanoXmpIntoJpeg } from '../gpanoXmp';

const DEG_TO_RAD = Math.PI / 180;

export interface CameraProjectionParams {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
}

export interface PreparedFrameProjection {
  worldToCam: Mat3;
  opticalAxisWorld: { x: number; y: number; z: number };
  cosHalfDiag: number;
  tanHalfH: number;
  tanHalfV: number;
}

export function prepareFrameProjection(cam: CameraProjectionParams): PreparedFrameProjection {
  const pose = createCameraPose({
    yawDeg: cam.yawDeg,
    pitchDeg: cam.pitchDeg,
    rollDeg: cam.rollDeg,
    timestampMs: 0,
  });
  const tanHalfH = Math.tan((cam.fovHorizontalDeg * 0.5) * DEG_TO_RAD);
  const tanHalfV = Math.tan((cam.fovVerticalDeg * 0.5) * DEG_TO_RAD);
  // Optical axis in world is camToWorld * (0, 0, -1)
  const opticalAxisWorld = {
    x: -pose.camToWorld[2],
    y: -pose.camToWorld[5],
    z: -pose.camToWorld[8],
  };
  const halfDiagRad = Math.atan(Math.hypot(tanHalfH, tanHalfV));
  const cosHalfDiag = Math.cos(Math.min(Math.PI * 0.49, halfDiagRad + 0.02));

  return {
    worldToCam: pose.worldToCam,
    opticalAxisWorld,
    cosHalfDiag,
    tanHalfH,
    tanHalfV,
  };
}

export function projectWorldRayWithPrepared(
  rayX: number,
  rayY: number,
  rayZ: number,
  prep: PreparedFrameProjection
): { u: number; v: number; weight: number } | null {
  // Fast cone culling before 3x3 matrix multiply
  const dotAxis =
    rayX * prep.opticalAxisWorld.x +
    rayY * prep.opticalAxisWorld.y +
    rayZ * prep.opticalAxisWorld.z;
  if (dotAxis < prep.cosHalfDiag) return null;

  const camRay = mulMat3Vec3(prep.worldToCam, { x: rayX, y: rayY, z: rayZ });
  if (camRay.z >= -0.05) return null;

  const nx = camRay.x / (-camRay.z * prep.tanHalfH);
  const ny = -camRay.y / (-camRay.z * prep.tanHalfV);

  if (nx < -1 || nx > 1 || ny < -1 || ny > 1) {
    return null;
  }

  const wx = Math.cos(nx * Math.PI * 0.5);
  const wy = Math.cos(ny * Math.PI * 0.5);
  const weight = Math.max(0.0001, wx * wx * wy * wy);

  return {
    u: (nx + 1) * 0.5,
    v: (ny + 1) * 0.5,
    weight,
  };
}

/**
 * Project a world unit ray (dx, dy, dz) into normalized camera image coordinates (u, v) in [0, 1]^2.
 * Uses the exact same CameraPose rotation convention as SphereCaptureHUD and SimulationCamera.
 */
export function projectWorldRayToFrameUV(
  rayX: number,
  rayY: number,
  rayZ: number,
  cam: CameraProjectionParams
): { u: number; v: number; weight: number } | null {
  return projectWorldRayWithPrepared(rayX, rayY, rayZ, prepareFrameProjection(cam));
}

/**
 * Convert equirectangular normalized coordinates (u in [0,1], v in [0,1])
 * to a world unit ray.
 * u = 0.5 -> yaw = 0° (-Z), u = 0 -> -180°, u = 1 -> +180°
 * v = 0 -> pitch = +90° (zenith), v = 1 -> pitch = -90° (nadir)
 */
export function equirectUVToWorldRay(u: number, v: number): { x: number; y: number; z: number } {
  const yaw = (u - 0.5) * Math.PI * 2;
  const pitch = (0.5 - v) * Math.PI;
  const cosP = Math.cos(pitch);
  return {
    x: Math.sin(yaw) * cosP,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosP,
  };
}

interface LoadedFramePixels {
  frame: CapturedFrame;
  prep: PreparedFrameProjection;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  meanLuma: number;
}

async function loadFramePixels(frame: CapturedFrame, maxSampleWidth = 640): Promise<LoadedFramePixels> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to decode frame ${frame.id}`));
    img.src = frame.imageDataUrl;
  });

  const scale = Math.min(1, maxSampleWidth / Math.max(1, img.naturalWidth));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.drawImage(img, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);

  let lumaSum = 0;
  const step = 16;
  let count = 0;
  for (let i = 0; i < imgData.data.length; i += 4 * step) {
    lumaSum +=
      0.2126 * imgData.data[i] +
      0.7152 * imgData.data[i + 1] +
      0.0722 * imgData.data[i + 2];
    count++;
  }

  return {
    frame,
    prep: prepareFrameProjection({
      yawDeg: frame.orientation.yawDeg,
      pitchDeg: frame.orientation.pitchDeg,
      rollDeg: frame.orientation.rollDeg,
      fovHorizontalDeg: frame.fovHorizontalDeg,
      fovVerticalDeg: frame.fovVerticalDeg,
    }),
    data: imgData.data,
    width: w,
    height: h,
    meanLuma: count > 0 ? lumaSum / count : 128,
  };
}

/**
 * On-device CPU/Canvas Equirectangular Stitcher with precomputed pose matrices,
 * cone culling, exposure gain compensation, raised-cosine feathering, and GPano XMP injection.
 */
export async function stitchFramesEquirectangular(
  frames: CapturedFrame[],
  options: {
    jobId?: string;
    outputWidth?: number;
    jpegQuality?: number;
    onProgress?: (progress: StitchProgress) => void;
  } = {}
): Promise<StitchResult> {
  if (frames.length === 0) {
    throw new Error('No frames provided for stitching');
  }

  const startMs = performance.now();
  const outputWidth = options.outputWidth ?? 2048;
  const outputHeight = Math.round(outputWidth / 2);
  const jpegQuality = options.jpegQuality ?? 0.92;
  const emit = options.onProgress;
  const jobId = options.jobId;

  emit?.({
    jobId,
    stage: 'preparing',
    progress: 0.05,
    message: `正在解码 ${frames.length} 张球面采样帧...`,
    engine: 'cpu-canvas',
  });

  const loaded: LoadedFramePixels[] = [];
  for (let i = 0; i < frames.length; i++) {
    loaded.push(await loadFramePixels(frames[i], outputWidth >= 4096 ? 960 : 640));
    if (i % 4 === 0) {
      emit?.({
        jobId,
        stage: 'preparing',
        progress: 0.05 + (0.2 * (i + 1)) / frames.length,
        message: `已加载 ${i + 1}/${frames.length} 帧`,
        engine: 'cpu-canvas',
      });
    }
  }

  const lumas = loaded.map((l) => l.meanLuma).sort((a, b) => a - b);
  const targetLuma = lumas[Math.floor(lumas.length / 2)] || 128;
  const gains = loaded.map((l) => {
    const rawGain = targetLuma / Math.max(24, l.meanLuma);
    return Math.max(0.78, Math.min(1.28, rawGain));
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outputWidth;
  outCanvas.height = outputHeight;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Failed to create output 2D canvas');

  const outImage = outCtx.createImageData(outputWidth, outputHeight);
  const outBuf = outImage.data;

  const bandHeight = 64;
  for (let yStart = 0; yStart < outputHeight; yStart += bandHeight) {
    const yEnd = Math.min(outputHeight, yStart + bandHeight);

    for (let y = yStart; y < yEnd; y++) {
      const v = (y + 0.5) / outputHeight;
      const pitch = (0.5 - v) * Math.PI;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);

      for (let x = 0; x < outputWidth; x++) {
        const u = (x + 0.5) / outputWidth;
        const yaw = (u - 0.5) * Math.PI * 2;
        const rayX = Math.sin(yaw) * cosP;
        const rayY = sinP;
        const rayZ = -Math.cos(yaw) * cosP;

        let rAcc = 0;
        let gAcc = 0;
        let bAcc = 0;
        let wAcc = 0;

        for (let fIdx = 0; fIdx < loaded.length; fIdx++) {
          const item = loaded[fIdx];
          const proj = projectWorldRayWithPrepared(rayX, rayY, rayZ, item.prep);
          if (!proj) continue;

          const sx = proj.u * (item.width - 1);
          const sy = proj.v * (item.height - 1);
          const x0 = Math.floor(sx);
          const y0 = Math.floor(sy);
          const x1 = Math.min(item.width - 1, x0 + 1);
          const y1 = Math.min(item.height - 1, y0 + 1);
          const fx = sx - x0;
          const fy = sy - y0;

          const idx00 = (y0 * item.width + x0) * 4;
          const idx10 = (y0 * item.width + x1) * 4;
          const idx01 = (y1 * item.width + x0) * 4;
          const idx11 = (y1 * item.width + x1) * 4;

          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;

          const gain = gains[fIdx];
          const r =
            (item.data[idx00] * w00 +
              item.data[idx10] * w10 +
              item.data[idx01] * w01 +
              item.data[idx11] * w11) *
            gain;
          const g =
            (item.data[idx00 + 1] * w00 +
              item.data[idx10 + 1] * w10 +
              item.data[idx01 + 1] * w01 +
              item.data[idx11 + 1] * w11) *
            gain;
          const b =
            (item.data[idx00 + 2] * w00 +
              item.data[idx10 + 2] * w10 +
              item.data[idx01 + 2] * w01 +
              item.data[idx11 + 2] * w11) *
            gain;

          rAcc += r * proj.weight;
          gAcc += g * proj.weight;
          bAcc += b * proj.weight;
          wAcc += proj.weight;
        }

        const outIdx = (y * outputWidth + x) * 4;
        if (wAcc > 0) {
          outBuf[outIdx] = Math.min(255, Math.round(rAcc / wAcc));
          outBuf[outIdx + 1] = Math.min(255, Math.round(gAcc / wAcc));
          outBuf[outIdx + 2] = Math.min(255, Math.round(bAcc / wAcc));
          outBuf[outIdx + 3] = 255;
        } else {
          outBuf[outIdx] = 8;
          outBuf[outIdx + 1] = 12;
          outBuf[outIdx + 2] = 22;
          outBuf[outIdx + 3] = 255;
        }
      }
    }

    const bandProgress = 0.25 + (0.6 * yEnd) / outputHeight;
    emit?.({
      jobId,
      stage: yEnd < outputHeight * 0.7 ? 'projecting' : 'blending',
      progress: bandProgress,
      message: `球面反投影与升余弦羽化融合 (${Math.round((yEnd / outputHeight) * 100)}%)`,
      engine: 'cpu-canvas',
    });

    await new Promise((r) => setTimeout(r, 0));
  }

  outCtx.putImageData(outImage, 0, 0);

  const coveragePercent = computeActualFrustumCoveragePercent(frames);
  const isFullSphere = coveragePercent >= 95;

  emit?.({
    jobId,
    stage: 'encoding',
    progress: 0.9,
    message: '正在编码 2:1 等距柱状投影 JPEG...',
    engine: 'cpu-canvas',
  });

  const rawDataUrl = outCanvas.toDataURL('image/jpeg', jpegQuality);
  const rawBytes = dataUrlToBytes(rawDataUrl);

  emit?.({
    jobId,
    stage: 'injecting_xmp',
    progress: 0.96,
    message: '正在写入 GPano XMP 全景元数据...',
    engine: 'cpu-canvas',
  });

  // The encoded JPEG is the full 2:1 equirectangular canvas (uncovered regions are dark-filled),
  // so GPano cropped area matches the encoded image dimensions.
  const xmpBytes = injectGPanoXmpIntoJpeg(rawBytes, {
    projectionType: 'equirectangular',
    usePanoramaViewer: true,
    fullPanoWidthPixels: outputWidth,
    fullPanoHeightPixels: outputHeight,
    croppedAreaImageWidthPixels: outputWidth,
    croppedAreaImageHeightPixels: outputHeight,
    croppedAreaLeftPixels: 0,
    croppedAreaTopPixels: 0,
    stitchingSoftware: 'OmniSphere 360 CPU/Canvas Stitcher',
    captureSoftware: 'OmniSphere 360 Camera',
  });

  const finalDataUrl = bytesToJpegDataUrl(xmpBytes);

  emit?.({
    jobId,
    stage: 'done',
    progress: 1,
    message: '全景合成完成',
    engine: 'cpu-canvas',
  });

  return {
    equirectangularDataUrl: finalDataUrl,
    jpegBytes: xmpBytes,
    width: outputWidth,
    height: outputHeight,
    fullPanoWidth: outputWidth,
    fullPanoHeight: outputHeight,
    cropLeft: 0,
    cropTop: 0,
    isFullSphere,
    coveragePercent,
    engine: 'cpu-canvas',
    usedFrameCount: frames.length,
    elapsedMs: Math.round(performance.now() - startMs),
    hasGpanoXmp: true,
  };
}

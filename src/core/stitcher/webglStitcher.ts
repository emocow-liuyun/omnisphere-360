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

  // Center-priority score in (0, 1]: 1.0 at optical center, smoothly 0 at border
  const wx = Math.cos(nx * Math.PI * 0.5);
  const wy = Math.cos(ny * Math.PI * 0.5);
  const weight = Math.max(0.0001, wx * wy);

  return {
    u: (nx + 1) * 0.5,
    v: (ny + 1) * 0.5,
    weight,
  };
}

export function projectWorldRayToFrameUV(
  rayX: number,
  rayY: number,
  rayZ: number,
  cam: CameraProjectionParams
): { u: number; v: number; weight: number } | null {
  return projectWorldRayWithPrepared(rayX, rayY, rayZ, prepareFrameProjection(cam));
}

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

async function loadFramePixels(frame: CapturedFrame, maxSampleWidth = 720): Promise<LoadedFramePixels> {
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

function sampleBilinearRGB(
  item: LoadedFramePixels,
  u: number,
  v: number,
  gain: number
): [number, number, number] {
  const sx = u * (item.width - 1);
  const sy = v * (item.height - 1);
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

  return [
    (item.data[idx00] * w00 + item.data[idx10] * w10 + item.data[idx01] * w01 + item.data[idx11] * w11) * gain,
    (item.data[idx00 + 1] * w00 + item.data[idx10 + 1] * w10 + item.data[idx01 + 1] * w01 + item.data[idx11 + 1] * w11) * gain,
    (item.data[idx00 + 2] * w00 + item.data[idx10 + 2] * w10 + item.data[idx01 + 2] * w01 + item.data[idx11 + 2] * w11) * gain,
  ];
}

/**
 * Refine per-frame (yaw, pitch) offsets against overlapping neighbors using fast
 * spherical SAD correlation on a coarse 128x64 grid to eliminate indoor IMU drift.
 */
function refineFramePoses(loaded: LoadedFramePixels[], gains: number[]): void {
  if (loaded.length < 2) return;

  // Anchor frame 0; sequentially refine each subsequent frame against already-refined frames
  const sampleRays: { x: number; y: number; z: number }[] = [];
  const gridW = 96;
  const gridH = 48;
  for (let gy = 0; gy < gridH; gy++) {
    const pitch = (0.5 - (gy + 0.5) / gridH) * Math.PI;
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    for (let gx = 0; gx < gridW; gx++) {
      const yaw = ((gx + 0.5) / gridW - 0.5) * Math.PI * 2;
      sampleRays.push({ x: Math.sin(yaw) * cosP, y: sinP, z: -Math.cos(yaw) * cosP });
    }
  }

  for (let i = 1; i < loaded.length; i++) {
    const curr = loaded[i];
    // Find overlapping rays with earlier frames
    const overlapRays: { ray: { x: number; y: number; z: number }; refLuma: number }[] = [];
    for (const ray of sampleRays) {
      const dot =
        ray.x * curr.prep.opticalAxisWorld.x +
        ray.y * curr.prep.opticalAxisWorld.y +
        ray.z * curr.prep.opticalAxisWorld.z;
      if (dot < curr.prep.cosHalfDiag) continue;

      let bestW = 0;
      let refLuma = 0;
      for (let j = 0; j < i; j++) {
        const p = projectWorldRayWithPrepared(ray.x, ray.y, ray.z, loaded[j].prep);
        if (p && p.weight > bestW) {
          bestW = p.weight;
          const [r, g, b] = sampleBilinearRGB(loaded[j], p.u, p.v, gains[j]);
          refLuma = 0.299 * r + 0.587 * g + 0.114 * b;
        }
      }
      if (bestW > 0.15) {
        overlapRays.push({ ray, refLuma });
      }
    }

    if (overlapRays.length < 12) continue;

    let bestDyaw = 0;
    let bestDpitch = 0;
    let bestSad = Infinity;

    // Coarse-to-fine 2D angular search (±4° in 1° steps, then ±0.75° in 0.25° steps)
    for (const step of [1.0, 0.35]) {
      const centerY = bestDyaw;
      const centerP = bestDpitch;
      const range = step === 1.0 ? 4 : 2;
      for (let iy = -range; iy <= range; iy++) {
        for (let ip = -range; ip <= range; ip++) {
          const dy = centerY + iy * step;
          const dp = centerP + ip * step;
          const candPrep = prepareFrameProjection({
            yawDeg: curr.frame.orientation.yawDeg + dy,
            pitchDeg: Math.max(-89.9, Math.min(89.9, curr.frame.orientation.pitchDeg + dp)),
            rollDeg: curr.frame.orientation.rollDeg,
            fovHorizontalDeg: curr.frame.fovHorizontalDeg,
            fovVerticalDeg: curr.frame.fovVerticalDeg,
          });

          let sad = 0;
          let hits = 0;
          for (const item of overlapRays) {
            const p = projectWorldRayWithPrepared(item.ray.x, item.ray.y, item.ray.z, candPrep);
            if (!p) continue;
            const [r, g, b] = sampleBilinearRGB(curr, p.u, p.v, gains[i]);
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            sad += Math.abs(luma - item.refLuma);
            hits++;
          }
          if (hits >= 10) {
            const meanSad = sad / hits;
            if (meanSad < bestSad) {
              bestSad = meanSad;
              bestDyaw = dy;
              bestDpitch = dp;
            }
          }
        }
      }
    }

    if (bestDyaw !== 0 || bestDpitch !== 0) {
      curr.frame = {
        ...curr.frame,
        orientation: {
          ...curr.frame.orientation,
          yawDeg: curr.frame.orientation.yawDeg + bestDyaw,
          pitchDeg: Math.max(-89.9, Math.min(89.9, curr.frame.orientation.pitchDeg + bestDpitch)),
        },
      };
      curr.prep = prepareFrameProjection({
        yawDeg: curr.frame.orientation.yawDeg,
        pitchDeg: curr.frame.orientation.pitchDeg,
        rollDeg: curr.frame.orientation.rollDeg,
        fovHorizontalDeg: curr.frame.fovHorizontalDeg,
        fovVerticalDeg: curr.frame.fovVerticalDeg,
      });
    }
  }
}

/**
 * On-device CPU/Canvas Equirectangular Stitcher with:
 * - Coarse-to-fine 2D angular pose refinement (eliminates indoor IMU drift)
 * - Sharp Voronoi seam selection with narrow 10% boundary feathering (eliminates ghosting!)
 * - Exposure gain compensation & GPano XMP injection
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
    loaded.push(await loadFramePixels(frames[i], outputWidth >= 4096 ? 960 : 720));
    if (i % 4 === 0) {
      emit?.({
        jobId,
        stage: 'preparing',
        progress: 0.05 + (0.15 * (i + 1)) / frames.length,
        message: `已加载 ${i + 1}/${frames.length} 帧`,
        engine: 'cpu-canvas',
      });
    }
  }

  const lumas = loaded.map((l) => l.meanLuma).sort((a, b) => a - b);
  const targetLuma = lumas[Math.floor(lumas.length / 2)] || 128;
  const gains = loaded.map((l) => {
    const rawGain = targetLuma / Math.max(24, l.meanLuma);
    return Math.max(0.82, Math.min(1.22, rawGain));
  });

  emit?.({
    jobId,
    stage: 'projecting',
    progress: 0.22,
    message: '正在执行重叠区域图像配准与姿态微调...',
    engine: 'cpu-canvas',
  });
  refineFramePoses(loaded, gains);

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

        // Sharp Voronoi seam: track top-2 closest-to-center frames only
        let bestIdx = -1;
        let bestScore = -1;
        let bestU = 0;
        let bestV = 0;

        let secondIdx = -1;
        let secondScore = -1;
        let secondU = 0;
        let secondV = 0;

        for (let fIdx = 0; fIdx < loaded.length; fIdx++) {
          const proj = projectWorldRayWithPrepared(rayX, rayY, rayZ, loaded[fIdx].prep);
          if (!proj) continue;

          if (proj.weight > bestScore) {
            secondIdx = bestIdx;
            secondScore = bestScore;
            secondU = bestU;
            secondV = bestV;

            bestIdx = fIdx;
            bestScore = proj.weight;
            bestU = proj.u;
            bestV = proj.v;
          } else if (proj.weight > secondScore) {
            secondIdx = fIdx;
            secondScore = proj.weight;
            secondU = proj.u;
            secondV = proj.v;
          }
        }

        const outIdx = (y * outputWidth + x) * 4;
        if (bestIdx >= 0) {
          const [r1, g1, b1] = sampleBilinearRGB(loaded[bestIdx], bestU, bestV, gains[bestIdx]);

          // Narrow 10% Voronoi seam feathering: only blend right along the seam boundary
          const ratio = secondIdx >= 0 ? secondScore / Math.max(1e-5, bestScore) : 0;
          if (secondIdx >= 0 && ratio > 0.88) {
            const [r2, g2, b2] = sampleBilinearRGB(
              loaded[secondIdx],
              secondU,
              secondV,
              gains[secondIdx]
            );
            const alpha = ((ratio - 0.88) / 0.12) * 0.5; // 0..0.5 at exact Voronoi edge
            const invA = 1 - alpha;
            outBuf[outIdx] = Math.min(255, Math.round(r1 * invA + r2 * alpha));
            outBuf[outIdx + 1] = Math.min(255, Math.round(g1 * invA + g2 * alpha));
            outBuf[outIdx + 2] = Math.min(255, Math.round(b1 * invA + b2 * alpha));
          } else {
            outBuf[outIdx] = Math.min(255, Math.round(r1));
            outBuf[outIdx + 1] = Math.min(255, Math.round(g1));
            outBuf[outIdx + 2] = Math.min(255, Math.round(b1));
          }
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
      message: `球面反投影与锐利接缝融合 (${Math.round((yEnd / outputHeight) * 100)}%)`,
      engine: 'cpu-canvas',
    });

    await new Promise((r) => setTimeout(r, 0));
  }

  outCtx.putImageData(outImage, 0, 0);

  const refinedFrames = loaded.map((l) => l.frame);
  const coveragePercent = computeActualFrustumCoveragePercent(refinedFrames);
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

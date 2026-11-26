import { Capacitor } from '@capacitor/core';
import type { EulerOrientation } from './types';
import { createCameraPose, mulMat3Vec3 } from './cameraPose';
import { OmniStitcher } from './stitcher/nativeBridge';

export interface CameraStreamHandle {
  stream: MediaStream | null;
  mode: 'live' | 'simulation';
  fovLongDeg: number;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
  stop: () => void;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Compute exact horizontal & vertical FOV (degrees) for a frame of size (width x height)
 * given the camera sensor's long-edge FOV (degrees).
 */
export function computeFovForDimensions(
  width: number,
  height: number,
  fovLongDeg: number
): { fovHorizontalDeg: number; fovVerticalDeg: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const tanHalfLong = Math.tan((fovLongDeg * 0.5) * DEG_TO_RAD);
  if (w >= h) {
    const fovHorizontalDeg = fovLongDeg;
    const fovVerticalDeg = 2 * Math.atan(tanHalfLong * (h / w)) * RAD_TO_DEG;
    return { fovHorizontalDeg, fovVerticalDeg };
  }
  const fovVerticalDeg = fovLongDeg;
  const fovHorizontalDeg = 2 * Math.atan(tanHalfLong * (w / h)) * RAD_TO_DEG;
  return { fovHorizontalDeg, fovVerticalDeg };
}

/**
 * Acquire rear wide-angle camera stream via WebRTC getUserMedia and query
 * physical camera intrinsics on native iOS/Android when available.
 */
export async function startCameraStream(): Promise<CameraStreamHandle> {
  let fovLongDeg = 68;
  if (Capacitor.isNativePlatform()) {
    try {
      const intrinsics = await OmniStitcher.getCameraIntrinsics();
      if (intrinsics.fovLongDeg > 25 && intrinsics.fovLongDeg < 130) {
        fovLongDeg = intrinsics.fovLongDeg;
      }
    } catch {
      // keep default 68°
    }
  }

  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    const { fovHorizontalDeg, fovVerticalDeg } = computeFovForDimensions(960, 720, fovLongDeg);
    return {
      stream: null,
      mode: 'simulation',
      fovLongDeg,
      fovHorizontalDeg,
      fovVerticalDeg,
      stop: () => {},
    };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1440 },
        height: { ideal: 1080 },
      },
    });

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.();
    const vw = settings?.width ?? 1280;
    const vh = settings?.height ?? 960;
    const { fovHorizontalDeg, fovVerticalDeg } = computeFovForDimensions(vw, vh, fovLongDeg);

    return {
      stream,
      mode: 'live',
      fovLongDeg,
      fovHorizontalDeg,
      fovVerticalDeg,
      stop: () => {
        for (const t of stream.getTracks()) {
          t.stop();
        }
      },
    };
  } catch {
    const { fovHorizontalDeg, fovVerticalDeg } = computeFovForDimensions(960, 720, fovLongDeg);
    return {
      stream: null,
      mode: 'simulation',
      fovLongDeg,
      fovHorizontalDeg,
      fovVerticalDeg,
      stop: () => {},
    };
  }
}

/**
 * Capture a JPEG frame strictly according to camera mode:
 * - 'live': preserves the video stream's natural aspect ratio (no portrait->landscape crop distortion!)
 *   and returns exact FOV matching the captured pixel dimensions.
 * - 'simulation': renders orientation-consistent procedural 3D world using CameraPose.
 */
export function captureFrameStrict(
  mode: 'live' | 'simulation',
  videoEl: HTMLVideoElement | null,
  orientation: EulerOrientation,
  fovLongDeg: number
): {
  dataUrl: string;
  width: number;
  height: number;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
} {
  let width = 960;
  let height = 720;

  if (mode === 'live') {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) {
      throw new Error('相机视频流尚未就绪，请稍候再试');
    }
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    const maxDim = 1080;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    width = Math.max(2, Math.round(vw * scale));
    height = Math.max(2, Math.round(vh * scale));
  }

  const { fovHorizontalDeg, fovVerticalDeg } = computeFovForDimensions(width, height, fovLongDeg);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }

  if (mode === 'live' && videoEl) {
    ctx.drawImage(videoEl, 0, 0, width, height);
  } else {
    renderSimulatedWorldFrame(ctx, width, height, orientation, fovHorizontalDeg, fovVerticalDeg);
  }

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    width,
    height,
    fovHorizontalDeg,
    fovVerticalDeg,
  };
}

function renderSimulatedWorldFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  orientation: EulerOrientation,
  fovH: number,
  fovV: number
): void {
  const img = ctx.createImageData(width, height);
  const buf = img.data;
  const deg2rad = Math.PI / 180;
  const tanH = Math.tan((fovH * 0.5) * deg2rad);
  const tanV = Math.tan((fovV * 0.5) * deg2rad);
  const pose = createCameraPose(orientation);

  const sunX = Math.sin(45 * deg2rad) * Math.cos(28 * deg2rad);
  const sunY = Math.sin(28 * deg2rad);
  const sunZ = -Math.cos(45 * deg2rad) * Math.cos(28 * deg2rad);

  for (let y = 0; y < height; y += 2) {
    const ny = (y / (height - 1)) * 2 - 1;
    const yc = -ny * tanV;
    for (let x = 0; x < width; x += 2) {
      const nx = (x / (width - 1)) * 2 - 1;
      const xc = nx * tanH;
      const zc = -1;

      const worldRay = mulMat3Vec3(pose.camToWorld, { x: xc, y: yc, z: zc });
      const invLen = 1 / Math.hypot(worldRay.x, worldRay.y, worldRay.z);
      const dx = worldRay.x * invLen;
      const dy = worldRay.y * invLen;
      const dz = worldRay.z * invLen;

      const worldYaw = Math.atan2(dx, -dz);
      const mountainHeight =
        0.06 +
        0.05 * Math.sin(worldYaw * 3.0 + 0.4) +
        0.03 * Math.cos(worldYaw * 7.0 - 1.1);

      let r = 0;
      let g = 0;
      let b = 0;

      if (dy > mountainHeight) {
        const t = Math.min(1, Math.max(0, (dy - mountainHeight) / 0.9));
        r = 28 * (1 - t) + 8 * t;
        g = 58 * (1 - t) + 18 * t;
        b = 112 * (1 - t) + 48 * t;

        const sunDot = Math.max(0, dx * sunX + dy * sunY + dz * sunZ);
        const halo = Math.pow(sunDot, 18);
        const core = Math.pow(sunDot, 220);
        r += halo * 180 + core * 255;
        g += halo * 110 + core * 230;
        b += halo * 60 + core * 180;
      } else if (dy > -0.02) {
        r = 18;
        g = 26;
        b = 44;
      } else {
        const gx = dx / Math.min(-0.02, dy);
        const gz = dz / Math.min(-0.02, dy);
        const gridLine =
          Math.abs(Math.sin(gx * Math.PI * 1.5)) < 0.08 ||
          Math.abs(Math.sin(gz * Math.PI * 1.5)) < 0.08;
        const distFade = Math.exp(-Math.hypot(gx, gz) * 0.12);
        r = 14 + (gridLine ? 24 * distFade : 0);
        g = 22 + (gridLine ? 140 * distFade : 0);
        b = 38 + (gridLine ? 175 * distFade : 0);
      }

      const cr = Math.min(255, Math.max(0, Math.round(r)));
      const cg = Math.min(255, Math.max(0, Math.round(g)));
      const cb = Math.min(255, Math.max(0, Math.round(b)));

      for (let dy2 = 0; dy2 < 2 && y + dy2 < height; dy2++) {
        for (let dx2 = 0; dx2 < 2 && x + dx2 < width; dx2++) {
          const idx = ((y + dy2) * width + (x + dx2)) * 4;
          buf[idx] = cr;
          buf[idx + 1] = cg;
          buf[idx + 2] = cb;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(img, 0, 0);
}

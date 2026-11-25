import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeStitchFrameInput {
  filePath: string;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export interface NativeStitchOptions {
  jobId: string;
  frames: NativeStitchFrameInput[];
  outputFilePath: string;
  outputWidth: number;
  jpegQuality: number;
  warpMode: 'spherical' | 'cylindrical';
  blendStrength: number;
}

export interface NativeStitchResult {
  outputPath: string;
  width: number;
  height: number;
  isFullSphere: boolean;
  usedIndices: number[];
  elapsedMs: number;
}

export interface NativeOrientationEvent {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  timestampMs: number;
}

export interface NativeStitchProgressEvent {
  jobId?: string;
  stage: 'preparing' | 'projecting' | 'blending' | 'encoding' | 'done';
  progress: number;
  message: string;
}

export interface NativeAeAfLockResult {
  locked: boolean;
  supported: boolean;
  aeLocked: boolean;
  afLocked: boolean;
  awbLocked: boolean;
}

export interface OmniStitcherPlugin {
  isNativeStitcherAvailable(): Promise<{ available: boolean; opencvVersion: string }>;
  lockExposureAndFocus(options: { locked: boolean }): Promise<NativeAeAfLockResult>;
  startMotionUpdates(options: { rateHz: number }): Promise<void>;
  stopMotionUpdates(): Promise<void>;
  stitchPanorama(options: NativeStitchOptions): Promise<NativeStitchResult>;
  addListener(
    eventName: 'orientationUpdate',
    listenerFunc: (event: NativeOrientationEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'stitchProgress',
    listenerFunc: (event: NativeStitchProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

export const OmniStitcher = registerPlugin<OmniStitcherPlugin>('OmniStitcher', {
  web: async () => ({
    async isNativeStitcherAvailable() {
      return { available: false, opencvVersion: 'web-cpu-canvas-fallback' };
    },
    async lockExposureAndFocus() {
      return {
        locked: false,
        supported: false,
        aeLocked: false,
        afLocked: false,
        awbLocked: false,
      };
    },
    async startMotionUpdates() {},
    async stopMotionUpdates() {},
    async stitchPanorama() {
      throw new Error('Native OpenCV stitcher is only available on iOS/Android native builds.');
    },
    async addListener() {
      return { remove: async () => {} };
    },
  }),
});

export async function canUseNativeOpenCV(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const res = await OmniStitcher.isNativeStitcherAvailable();
    return res.available;
  } catch {
    return false;
  }
}

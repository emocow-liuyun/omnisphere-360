export type CaptureMode = 'sphere360' | 'wide180';

export type CaptureDensity = 'fast26' | 'standard30' | 'ultra38';

export type CapturePhase =
  | 'IDLE'
  | 'GUIDING'
  | 'HOLD_STEADY'
  | 'CAPTURING'
  | 'STITCHING'
  | 'VIEWING';

export type AeAfStatus = 'unlocked' | 'locked' | 'unsupported';

export interface EulerOrientation {
  /** Azimuth / heading in degrees [0, 360) */
  yawDeg: number;
  /** Elevation in degrees [-90, +90], 0 = horizon, +90 = zenith, -90 = nadir */
  pitchDeg: number;
  /** Roll around optical axis in degrees [-180, 180] */
  rollDeg: number;
  /** Monotonic or sensor timestamp in ms */
  timestampMs: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SphereTarget {
  id: string;
  index: number;
  ring: 'zenith' | 'upper' | 'equator' | 'lower' | 'nadir';
  yawDeg: number;
  pitchDeg: number;
  direction: Vec3;
  captured: boolean;
}

export interface CapturedFrame {
  id: string;
  targetId: string | null;
  /** Data URL or local file URI */
  imageDataUrl: string;
  width: number;
  height: number;
  orientation: EulerOrientation;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
  capturedAtMs: number;
}

export interface AlignmentStatus {
  nearestTarget: SphereTarget | null;
  angularErrorDeg: number;
  angularVelocityDegPerSec: number;
  isAligned: boolean;
  isSteady: boolean;
  /** 0..1 progress while holding steady before auto-shutter fires */
  holdProgress: number;
  guidanceHint: string;
}

export interface StitchProgress {
  jobId?: string;
  stage: 'preparing' | 'projecting' | 'blending' | 'encoding' | 'injecting_xmp' | 'done';
  progress: number; // 0..1
  message: string;
  engine: 'native-opencv' | 'cpu-canvas';
}

export interface StitchResult {
  equirectangularDataUrl: string;
  jpegBytes: Uint8Array;
  width: number;
  height: number;
  fullPanoWidth: number;
  fullPanoHeight: number;
  cropLeft: number;
  cropTop: number;
  isFullSphere: boolean;
  coveragePercent: number;
  engine: 'native-opencv' | 'cpu-canvas';
  usedFrameCount: number;
  elapsedMs: number;
  hasGpanoXmp: boolean;
}

export interface GPanoMetadata {
  projectionType: 'equirectangular' | 'cylindrical';
  usePanoramaViewer: boolean;
  fullPanoWidthPixels: number;
  fullPanoHeightPixels: number;
  croppedAreaImageWidthPixels: number;
  croppedAreaImageHeightPixels: number;
  croppedAreaLeftPixels: number;
  croppedAreaTopPixels: number;
  stitchingSoftware: string;
  captureSoftware: string;
  /** Only set when calibrated true-north heading of panorama center is known */
  poseHeadingDegrees?: number;
}

import React from 'react';

interface GalaxyShutterButtonProps {
  isCapturing: boolean;
  isAligned: boolean;
  holdProgress: number; // 0..1
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Galaxy-inspired orbital shutter button with SVG hold-steady progress ring.
 */
export const GalaxyShutterButton: React.FC<GalaxyShutterButtonProps> = ({
  isCapturing,
  isAligned,
  holdProgress,
  disabled = false,
  onClick,
}) => {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - Math.max(0, Math.min(1, holdProgress)));

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label="拍摄当前球面点位"
      className={`galaxy-shutter-outer ${isAligned ? 'is-locked' : ''} ${
        isCapturing ? 'is-capturing' : ''
      } ${disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}
    >
      <svg
        className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none"
        viewBox="0 0 84 84"
      >
        <circle
          cx="42"
          cy="42"
          r={radius}
          fill="none"
          stroke="rgba(148, 163, 184, 0.22)"
          strokeWidth="3"
        />
        <circle
          cx="42"
          cy="42"
          r={radius}
          fill="none"
          stroke={isAligned ? '#34d399' : '#22d3ee'}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: 'stroke-dashoffset 60ms linear, stroke 180ms ease' }}
        />
      </svg>
      <span className="galaxy-shutter-core" />
    </button>
  );
};

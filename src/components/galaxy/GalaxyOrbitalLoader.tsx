import React from 'react';

interface GalaxyOrbitalLoaderProps {
  progress: number; // 0..1
  title: string;
  subtitle: string;
  engineLabel: string;
}

export const GalaxyOrbitalLoader: React.FC<GalaxyOrbitalLoaderProps> = ({
  progress,
  title,
  subtitle,
  engineLabel,
}) => {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={title}
      className="galaxy-glass rounded-3xl p-7 w-[min(90vw,360px)] flex flex-col items-center text-center gap-5"
    >
      <div className="galaxy-orbit-loader" aria-hidden="true">
        <div className="galaxy-orbit-ring galaxy-orbit-ring-1" />
        <div className="galaxy-orbit-ring galaxy-orbit-ring-2" />
        <div className="galaxy-orbit-ring galaxy-orbit-ring-3" />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-semibold tracking-tight text-cyan-300 tabular-nums">
            {pct}%
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <p className="text-xs text-slate-300 leading-relaxed">{subtitle}</p>
      </div>

      <div className="w-full h-1.5 rounded-full bg-slate-800/90 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-400 to-emerald-400 transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>

      <span className="text-[11px] uppercase tracking-wider text-cyan-300/80 font-mono">
        {engineLabel}
      </span>
    </div>
  );
};

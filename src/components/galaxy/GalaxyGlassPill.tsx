import React from 'react';

interface GalaxyGlassPillProps {
  children: React.ReactNode;
  className?: string;
}

export const GalaxyGlassPill: React.FC<GalaxyGlassPillProps> = ({
  children,
  className = '',
}) => {
  return (
    <div
      className={`galaxy-glass rounded-full px-3.5 py-1.5 text-xs font-medium text-slate-100 flex items-center gap-2 ${className}`}
    >
      {children}
    </div>
  );
};

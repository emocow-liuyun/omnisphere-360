import React from 'react';

interface GalaxyActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  variant?: 'default' | 'primary' | 'danger';
}

export const GalaxyActionButton: React.FC<GalaxyActionButtonProps> = ({
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
  variant = 'default',
}) => {
  const variantClass =
    variant === 'primary'
      ? 'border-cyan-400/50 text-cyan-200 bg-cyan-500/15'
      : variant === 'danger'
        ? 'border-rose-400/40 text-rose-200 bg-rose-500/10'
        : active
          ? 'border-emerald-400/50 text-emerald-200 bg-emerald-500/15'
          : 'text-slate-200';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`galaxy-btn px-3 py-2 flex items-center gap-1.5 text-xs font-medium cursor-pointer ${variantClass} ${
        disabled ? 'opacity-40 pointer-events-none' : ''
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

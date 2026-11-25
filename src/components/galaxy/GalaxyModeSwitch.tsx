export interface ModeOption<T extends string> {
  value: T;
  label: string;
}

interface GalaxyModeSwitchProps<T extends string> {
  options: ModeOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function GalaxyModeSwitch<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel = '模式切换',
}: GalaxyModeSwitchProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      className={`galaxy-switch-track rounded-full p-1 inline-flex items-center gap-1 ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
              disabled ? 'cursor-not-allowed' : 'cursor-pointer'
            } ${
              active
                ? 'galaxy-switch-thumb text-cyan-200'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

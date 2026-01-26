import React from 'react';

interface ControlSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (val: number) => void;
  onReset?: () => void;
  displayValue?: string | number;
  icon?: React.ReactNode;
}

export const ControlSlider: React.FC<ControlSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  onChange,
  onReset,
  displayValue,
  icon
}) => {
  return (
    <div className="bg-gray-800/50 rounded-xl p-4 backdrop-blur-sm border border-gray-700/50">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2 text-gray-300 font-medium">
          {icon}
          <span>{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-brand-glow font-bold font-mono text-lg">
            {displayValue ?? value}{unit}
          </span>
          {onReset && (
            <button 
              onClick={onReset}
              className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
            >
              Reset
            </button>
          )}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
      />
      <div className="flex justify-between mt-2 text-xs text-gray-500 font-mono">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
};
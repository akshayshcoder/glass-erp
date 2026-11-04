import type React from 'react';
import { availableFiscalYears, fiscalYearRange } from '../../lib/fiscal-year';
import { Select } from './field';

interface FyPickerProps {
  value: string;
  onChange: (fy: string, dateRange?: { from: string; to: string }) => void;
  includeAll?: boolean;
  className?: string;
  autoFillDates?: boolean;
}

export function FyPicker({
  value,
  onChange,
  includeAll = true,
  className = 'w-full lg:w-44',
  autoFillDates = true,
}: FyPickerProps) {
  const options = availableFiscalYears(3, 1);

  return (
    <div className="relative inline-flex items-center">
      <Select
        aria-label="Financial Year"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
          const selectedFy = e.target.value;
          if (selectedFy && autoFillDates) {
            const range = fiscalYearRange(selectedFy);
            onChange(selectedFy, range);
          } else {
            onChange(selectedFy);
          }
        }}
        className={className}
      >
        {includeAll && <option value="">All Financial Years</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

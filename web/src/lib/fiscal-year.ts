/**
 * Indian Financial Year utilities (1 April – 31 March).
 * E.g. Date 2026-10-23 falls in '2026-27'.
 */

export function fiscalYearOf(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const month = d.getMonth() + 1; // 1-12
  const fullYear = d.getFullYear();
  const startYear = month >= 4 ? fullYear : fullYear - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endYearShort}`;
}

export function currentFiscalYear(): string {
  return fiscalYearOf(new Date());
}

export function fiscalYearRange(fy: string): { from: string; to: string } {
  const [startStr] = fy.split('-');
  const startYear = parseInt(startStr!, 10);
  const endYear = startYear + 1;
  return {
    from: `${startYear}-04-01`,
    to: `${endYear}-03-31`,
  };
}

export function availableFiscalYears(countBefore = 2, countAfter = 1): { value: string; label: string }[] {
  const current = currentFiscalYear();
  const currentStartYear = parseInt(current.split('-')[0]!, 10);
  const years: { value: string; label: string }[] = [];

  for (let y = currentStartYear + countAfter; y >= currentStartYear - countBefore; y--) {
    const nextShort = String((y + 1) % 100).padStart(2, '0');
    const fyCode = `${y}-${nextShort}`;
    years.push({
      value: fyCode,
      label: `FY ${fyCode} (01/04/${y} – 31/03/${y + 1})`,
    });
  }

  return years;
}

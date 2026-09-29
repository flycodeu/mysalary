export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrLine {
  text: string;
  box: Box;
  /** Overlapping OCR tiles disagreed at this image location. */
  needsReview?: true;
  alternatives?: string[];
}

export interface OcrResult {
  lines: OcrLine[];
  imageWidth: number;
  imageHeight: number;
  engine: string;
  modelVersion: string;
  elapsedMs: number;
}

export type SalaryEffect = 'earning' | 'deduction' | 'display' | 'unknown';
export type CalculationMode = 'self' | 'children' | 'exclude' | 'unresolved';

export interface SalaryLine {
  id: string;
  label: string;
  rawAmountText: string;
  amountMinor: number | null;
  effect: SalaryEffect;
  rowRole: 'detail' | 'subtotal' | 'total';
  calculationMode: CalculationMode;
  parentLineId: string | null;
  sourceBox?: Box;
  issues: string[];
  /** Manual edits keep their chosen classification when automatic rules run again. */
  accountingSource?: 'automatic' | 'manual';
}

export interface SalaryDraft {
  payrollMonth: string | null;
  statedGrossMinor: number | null;
  statedNetMinor: number | null;
  lines: SalaryLine[];
  warnings: string[];
  reviewStatus: 'draft' | 'reviewed';
}

export interface Reconciliation {
  /** Confirmed selected rows only; unknown groups never silently count as zero. */
  knownGrossMinor: number | null;
  knownDeductionsMinor: number | null;
  calculatedGrossMinor: number | null;
  calculatedDeductionsMinor: number | null;
  calculatedNetMinor: number | null;
  /** Derived from stated gross minus stated net; this is not a source deduction field. */
  statedDeductionMinor: number | null;
  /** Stated gross - stated net - known deductions; may be a partial comparison. */
  deductionDifferenceMinor: number | null;
  deductionComparisonComplete: boolean;
  grossDifferenceMinor: number | null;
  status: 'consistent' | 'difference' | 'unresolved';
  issues: string[];
  unresolvedLineIds: string[];
  groupDifferences: Array<{ lineId: string; label: string; differenceMinor: number }>;
}

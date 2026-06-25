export interface OpenFileOptions {
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface BatchValidatePayload {
  inputFolder: string
  spreadsheetPath: string
  outputFolder: string
}

export interface BatchValidationResult {
  ok: boolean
  errors: string[]
  imageCount?: number
}

export interface SpreadsheetRowData {
  sku: string
  widthMm: number
  heightMm: number
  measureBy: string
}

export interface MatchSummary {
  totalSpreadsheetRecords: number
  totalImages: number
  matched: string[]
  missingImages: string[]
  missingSpreadsheetRecords: string[]
  duplicateSpreadsheetSkus: string[]
  duplicateImageSkus: string[]
  rows: Record<string, SpreadsheetRowData>
}

export interface BatchLoadPayload {
  inputFolder: string
  spreadsheetPath: string
}

export interface BatchLoadResult {
  ok: boolean
  errors: string[]
  match?: MatchSummary
}

export interface SessionSavePayload {
  outputFolder: string
  session: import('./session').SessionFile
}

export interface SessionSaveResult {
  ok: boolean
  error?: string
}

export interface SessionLoadPayload {
  inputFolder: string
  outputFolder: string
  spreadsheetPath: string
}

export interface SessionLoadResult {
  ok: boolean
  session: import('./session').SessionFile | null
  error?: string
}

export interface LastBatchPrefs {
  inputFolder: string | null
  spreadsheetPath: string | null
  outputFolder: string | null
}

export interface ProcessWatchPayload {
  inputFolder: string
  outputFolder: string
  sku: string
  leftBoundary: number
  rightBoundary: number
  widthMm: number
}

export interface ProcessWatchResult {
  ok: boolean
  sku: string
  outputPath?: string
  error?: string
}

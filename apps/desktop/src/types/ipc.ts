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

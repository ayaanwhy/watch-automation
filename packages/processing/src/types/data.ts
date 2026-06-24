export interface SpreadsheetRow {
  sku: string
  widthMm: number
  heightMm: number
  measureBy: string
}

export interface MatchResult {
  totalSpreadsheetRecords: number
  totalImages: number
  matched: string[]
  missingImages: string[]
  missingSpreadsheetRecords: string[]
  duplicateSpreadsheetSkus: string[]
  duplicateImageSkus: string[]
  rows: Record<string, SpreadsheetRow>
}

#!/usr/bin/env tsx
// Reads two scripts/benchmark.ts JSON outputs and prints a concise
// before/after markdown report. Standalone — no app runtime dependency.
//
// Usage:
//   npm run benchmark:compare -- --baseline benchmarks/baseline-....json --final benchmarks/phase11-final-....json
//   npm run benchmark:compare -- --baseline benchmarks/baseline-....json --final benchmarks/phase11-final-....json --out benchmarks/phase11-comparison.md

import { Command } from 'commander'
import { readFileSync, writeFileSync } from 'node:fs'

const program = new Command()
program
  .name('benchmark-compare')
  .requiredOption('--baseline <path>', 'baseline benchmark JSON')
  .requiredOption('--final <path>', 'final benchmark JSON')
  .option('--out <path>', 'also write the report to this file')
program.parse()
const opts = program.opts<{ baseline: string; final: string; out?: string }>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const before: any = JSON.parse(readFileSync(opts.baseline, 'utf-8'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const after: any = JSON.parse(readFileSync(opts.final, 'utf-8'))

function pct(a: number, b: number): string {
  if (a === 0) return b === 0 ? '0%' : 'n/a'
  const d = ((b - a) / a) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}
function sec(ms: number): string { return `${(ms / 1000).toFixed(1)}s` }
function mb(v: number): string { return `${v.toFixed(1)} MB` }

type Row = [metric: string, baseline: string, final: string, delta: string]
const rows: Row[] = []

rows.push(['Tracked files', String(before.repoStats.trackedFiles), String(after.repoStats.trackedFiles), pct(before.repoStats.trackedFiles, after.repoStats.trackedFiles)])
rows.push(['Source files (ts+tsx+py)', String(before.repoStats.sourceFiles.total), String(after.repoStats.sourceFiles.total), pct(before.repoStats.sourceFiles.total, after.repoStats.sourceFiles.total)])
rows.push(['Lines of code', String(before.repoStats.linesOfCode.total), String(after.repoStats.linesOfCode.total), pct(before.repoStats.linesOfCode.total, after.repoStats.linesOfCode.total)])
rows.push(['Project size (tracked)', mb(before.projectSize.totalMb), mb(after.projectSize.totalMb), pct(before.projectSize.totalMb, after.projectSize.totalMb)])
rows.push(['Build time', sec(before.buildTimeMs), sec(after.buildTimeMs), pct(before.buildTimeMs, after.buildTimeMs)])

for (const [key, name] of [['watch', 'Watch'], ['preprocessing', 'Universal Preprocessing'], ['ringBracelet', 'Ring & Bracelet']] as const) {
  const b = before.pipelines[key]
  const a = after.pipelines[key]
  rows.push([`${name} — wall time`, sec(b.wallTimeMs), sec(a.wallTimeMs), pct(b.wallTimeMs, a.wallTimeMs)])
  if (b.peakRssMb != null && a.peakRssMb != null) {
    rows.push([`${name} — peak RSS`, mb(b.peakRssMb), mb(a.peakRssMb), pct(b.peakRssMb, a.peakRssMb)])
  }
  if ('mpsDriverMb' in b && b.mpsDriverMb != null && a.mpsDriverMb != null) {
    rows.push([`${name} — peak MPS driver mem`, mb(b.mpsDriverMb), mb(a.mpsDriverMb), pct(b.mpsDriverMb, a.mpsDriverMb)])
  }
}

let report = `# Phase 11 Benchmark Comparison\n\n`
report += `**Baseline:** \`${before.label}\` — ${before.timestamp} (${before.git.commit})\n\n`
report += `**Final:** \`${after.label}\` — ${after.timestamp} (${after.git.commit})\n\n`
if (before.pipelines.watch.inputSource !== after.pipelines.watch.inputSource) {
  report += `⚠️ Baseline and final used different input sources (${before.pipelines.watch.inputSource} vs ${after.pipelines.watch.inputSource}) — pipeline timings below are not directly comparable.\n\n`
}
report += `| Metric | Baseline | Final | Delta |\n|---|---|---|---|\n`
for (const [m, b, a, d] of rows) report += `| ${m} | ${b} | ${a} | ${d} |\n`

console.log(report)
if (opts.out) {
  writeFileSync(opts.out, report)
  console.log(`\nWritten to ${opts.out}`)
}

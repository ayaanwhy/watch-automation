#!/usr/bin/env node
/** Capture immutable source images from the live ring configurator. */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 90_000;
const RESET_EVERY_CASES = 20;
const MAX_CASE_ATTEMPTS = 3;
const MAX_LOAD_ATTEMPTS = 4;
const OPTIONAL_CONTROL_GROUPS = new Set([
  'Side setting',
  'Side stones type',
  'Side stones length',
]);

// Apply parent controls before controls whose availability depends on them.
// Object insertion order is not sufficient here because suite defaults are
// merged before case-specific shape/head/mounting selections.
const CONTROL_ORDER = [
  'Center diamond type',
  'Center stone shape',
  'Center stone size',
  'Ring head type',
  'Ring head metal',
  'Mounting type',
  'Side setting',
  'Side stones type',
  'Side stones length',
  'Mounting metal',
];

class UnavailableCombinationError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function parseArgs(argv) {
  const args = { outRoot: 'benchmark/snapshots', delayMs: 600, maxCases: Infinity,
                 startCase: 1, imageSize: 1000, headful: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--suite') args.suite = argv[++i];
    else if (value === '--out-root') args.outRoot = argv[++i];
    else if (value === '--snapshot-id') args.snapshotId = argv[++i];
    else if (value === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (value === '--max-cases') args.maxCases = Number(argv[++i]);
    else if (value === '--start-case') args.startCase = Number(argv[++i]);
    else if (value === '--image-size') args.imageSize = Number(argv[++i]);
    else if (value === '--headful') args.headful = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.suite) throw new Error('--suite is required');
  if (!Number.isInteger(args.startCase) || args.startCase < 1) {
    throw new Error('--start-case must be a positive one-based index');
  }
  if (!Number.isInteger(args.imageSize) || args.imageSize < 400 || args.imageSize > 1000) {
    throw new Error('--image-size must be an integer from 400 to the vendor maximum of 1000');
  }
  return args;
}

function previewAtSize(previewUrl, imageSize) {
  const sized = new URL(previewUrl);
  sized.searchParams.set('s', String(imageSize));
  return sized.toString();
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isoCompact(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function groupEntries(page, role) {
  return page.locator(`[role="${role}"]`).evaluateAll((groups) => groups.map((group, index) => ({
    index,
    label: (group.previousElementSibling?.innerText || '').trim().replace(/\s+/g, ' '),
    options: [...group.querySelectorAll('[aria-checked]')].map((element) => ({
      text: (element.closest('label')?.innerText || element.innerText || '')
        .trim().replace(/\s+/g, ' '),
      value: element.getAttribute('value') || '',
      automation_id: element.getAttribute('data-automation-id') || '',
      selected: element.getAttribute('aria-checked') === 'true',
      disabled: element.disabled || element.hasAttribute('data-disabled') ||
                element.getAttribute('aria-disabled') === 'true',
    })),
  })).filter((group) => group.label && group.options.length));
}

async function inventory(page) {
  const groups = [...await groupEntries(page, 'radiogroup'),
                  ...await groupEntries(page, 'group')];
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups.map(({ label, options }) => ({ label, options }));
}

function selectedState(groups) {
  return Object.fromEntries(groups.map((group) => {
    const selected = group.options.filter((option) => option.selected)
      .map((option) => option.text);
    return [group.label, selected.length === 1 ? selected[0] : selected];
  }));
}

async function findGroup(page, label) {
  for (const role of ['radiogroup', 'group']) {
    const groups = await groupEntries(page, role);
    const match = groups.find((group) => group.label === label);
    if (match) return { role, index: match.index, ...match };
  }
  return null;
}

async function choose(page, groupLabel, optionText, delayMs) {
  const group = await findGroup(page, groupLabel);
  if (!group) {
    if (OPTIONAL_CONTROL_GROUPS.has(groupLabel)) {
      throw new UnavailableCombinationError(
        `control group not available: ${groupLabel}`, true);
    }
    throw new Error(`control group not available: ${groupLabel}`);
  }
  const option = group.options.find((item) => item.text === optionText);
  if (!option) throw new Error(`${groupLabel} has no option: ${optionText}`);
  if (option.disabled) {
    throw new UnavailableCombinationError(
      `${groupLabel} option is disabled for this combination: ${optionText}`);
  }
  if (option.selected) return false;

  const locator = page.locator(`[role="${group.role}"]`).nth(group.index);
  if (group.role === 'radiogroup') {
    await locator.getByRole('radio', { name: optionText, exact: true }).click();
  } else {
    // The visible card text is recreated during each configurator update and
    // text locators can go stale. The Radix checkbox order is the same order
    // returned by groupEntries; click that actual control directly.
    const optionIndex = group.options.findIndex((item) => item.text === optionText);
    await locator.locator('[role="checkbox"]').nth(optionIndex)
      .evaluate((control) => control.closest('label')?.click());
  }
  await page.waitForTimeout(delayMs);
  let updated = await findGroup(page, groupLabel);
  if (!updated?.options.find((item) => item.text === optionText)?.selected) {
    // The configurator sometimes completes its React update just after the
    // normal inter-control delay. Give it one additional settling window
    // before declaring the selection failed and resetting the whole page.
    await page.waitForTimeout(Math.max(delayMs, 750));
    updated = await findGroup(page, groupLabel);
  }
  if (!updated?.options.find((item) => item.text === optionText)?.selected) {
    throw new Error(`${groupLabel} did not select: ${optionText}`);
  }
  return true;
}

async function stablePreview(page) {
  const preview = page.locator('img[alt="Preview — view 1"]').first();
  await preview.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="Preview — view 1"]');
    return image?.complete && image.naturalWidth >= 400 && image.naturalHeight >= 400;
  }, null, { timeout: DEFAULT_TIMEOUT });
  let previous = '';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await preview.evaluate((image) => image.currentSrc || image.src);
    if (current === previous) return current;
    previous = current;
    await page.waitForTimeout(350);
  }
  return previous;
}

async function loadConfigurator(page, sourcePage) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(sourcePage, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
      await page.getByText('Ring head type', { exact: true }).waitFor({ timeout: DEFAULT_TIMEOUT });
      await stablePreview(page);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_LOAD_ATTEMPTS) break;
      console.warn(`configurator load failed; retry ${attempt}/${MAX_LOAD_ATTEMPTS - 1}`);
      await page.waitForTimeout(2_000 * attempt);
    }
  }
  throw lastError;
}

async function saveProgress(tempDir, progress) {
  const destination = path.join(tempDir, 'progress.json');
  const pending = `${destination}.pending`;
  await fs.writeFile(pending, `${JSON.stringify(progress, null, 2)}\n`);
  await fs.rename(pending, destination);
}

async function captureCase(context, page, testCase, suiteDefaults, imageDir, delayMs,
                           inventories, imageSize) {
  const requested = { ...suiteDefaults, ...(testCase.selections || {}) };
  for (const [group, value] of Object.entries(requested)) {
    if (value === null) delete requested[group];
  }
  const record = {
    id: testCase.id || slug(Object.values(requested).join('-')),
    notes: testCase.notes || '',
    requested,
    captured_at: new Date().toISOString(),
  };
  try {
    const orderedSelections = Object.entries(requested).sort(([left], [right]) => {
      const leftIndex = CONTROL_ORDER.indexOf(left);
      const rightIndex = CONTROL_ORDER.indexOf(right);
      return (leftIndex < 0 ? CONTROL_ORDER.length : leftIndex) -
             (rightIndex < 0 ? CONTROL_ORDER.length : rightIndex);
    });
    for (const [group, option] of orderedSelections) {
      await choose(page, group, option, delayMs);
    }
    const controls = await inventory(page);
    const state = selectedState(controls);
    const mismatches = Object.entries(requested).filter(([group, option]) =>
      state[group] !== option).map(([group, option]) => ({
        group, requested: option, actual: state[group] ?? null,
      }));
    const inventoryJson = JSON.stringify(controls);
    const inventorySha = sha256(inventoryJson);
    inventories[inventorySha] = controls;

    const previewUrl = await stablePreview(page);
    const imageUrl = previewAtSize(previewUrl, imageSize);
    const response = await context.request.get(imageUrl, { timeout: DEFAULT_TIMEOUT });
    if (!response.ok()) throw new Error(`preview download returned HTTP ${response.status()}`);
    const bytes = Buffer.from(await response.body());
    const imageSha = sha256(bytes);
    const contentType = response.headers()['content-type'] || '';
    const extension = contentType.includes('png') ? 'png' : 'jpg';
    const relativeImage = `images/${imageSha}.${extension}`;
    const destination = path.join(imageDir, `${imageSha}.${extension}`);
    try { await fs.access(destination); } catch { await fs.writeFile(destination, bytes); }

    record.status = mismatches.length ? 'not_available' : 'ok';
    record.selection_mismatches = mismatches;
    record.selected = state;
    record.controls_sha256 = inventorySha;
    record.page_url = page.url();
    record.image = {
      url: imageUrl,
      preview_url: previewUrl,
      requested_size: imageSize,
      file: relativeImage,
      sha256: imageSha,
      bytes: bytes.length,
      content_type: contentType,
    };
  } catch (error) {
    record.status = error instanceof UnavailableCombinationError ? 'not_available' : 'error';
    record.error = String(error?.message || error);
    record.retryable = Boolean(error?.retryable);
  }
  return record;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suiteBytes = await fs.readFile(args.suite);
  const suite = JSON.parse(suiteBytes.toString('utf8'));
  if (!suite.source_page || !Array.isArray(suite.cases)) {
    throw new Error('suite requires source_page and cases');
  }
  const snapshotId = args.snapshotId || `${slug(suite.name || 'configurator')}-${isoCompact()}`;
  const finalDir = path.resolve(args.outRoot, snapshotId);
  const tempDir = `${finalDir}.partial`;
  const suiteSha = sha256(suiteBytes);
  const maxCasesMarker = Number.isFinite(args.maxCases) ? args.maxCases : null;
  try { await fs.access(finalDir); throw new Error(`snapshot already exists: ${finalDir}`); }
  catch (error) { if (!String(error.message).startsWith('ENOENT')) throw error; }
  await fs.mkdir(path.join(tempDir, 'images'), { recursive: true });

  let records = [];
  let inventories = {};
  try {
    const progress = JSON.parse(await fs.readFile(path.join(tempDir, 'progress.json'), 'utf8'));
    if (progress.snapshot_id !== snapshotId || progress.suite_sha256 !== suiteSha ||
        progress.start_case !== args.startCase || progress.max_cases !== maxCasesMarker ||
        progress.image_size !== args.imageSize) {
      throw new Error(`partial snapshot arguments do not match: ${tempDir}`);
    }
    records = progress.records || [];
    inventories = progress.control_inventories || {};
    console.log(`resuming ${snapshotId} after ${records.length} completed cases`);
  } catch (error) {
    if (!String(error.message).startsWith('ENOENT')) throw error;
  }

  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  try {
    await loadConfigurator(page, suite.source_page);
    const startIndex = args.startCase - 1;
    const selectedCases = suite.cases.slice(startIndex, startIndex + args.maxCases);
    if (records.length > selectedCases.length) {
      throw new Error(`partial snapshot has too many records: ${records.length}`);
    }
    for (let index = records.length; index < selectedCases.length; index += 1) {
      const testCase = selectedCases[index];
      if (index > 0 && index % RESET_EVERY_CASES === 0) {
        await loadConfigurator(page, suite.source_page);
      }
      let record;
      for (let attempt = 0; attempt < MAX_CASE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await loadConfigurator(page, suite.source_page);
        record = await captureCase(context, page, testCase, suite.defaults || {},
                                   path.join(tempDir, 'images'), args.delayMs,
                                   inventories, args.imageSize);
        record.retry_count = attempt;
        const shouldRetry = record.status === 'error' || record.retryable;
        if (!shouldRetry || attempt === MAX_CASE_ATTEMPTS - 1) break;
        console.warn(`[${index + 1}/${selectedCases.length}] ${record.id}: ` +
                     `retry ${attempt + 1}/${MAX_CASE_ATTEMPTS - 1} after page reset`);
      }
      records.push(record);
      await saveProgress(tempDir, {
        snapshot_id: snapshotId,
        suite_sha256: suiteSha,
        start_case: args.startCase,
        max_cases: maxCasesMarker,
        image_size: args.imageSize,
        records,
        control_inventories: inventories,
      });
      console.log(`[${index + 1}/${selectedCases.length}] ${record.id}: ${record.status}` +
                  (record.error ? ` — ${record.error}` : ''));
    }
    const appScript = await page.locator('script[src*="nivoda-connect"]').first()
      .getAttribute('src').catch(() => null);
    const manifest = {
      schema_version: 1,
      snapshot_id: snapshotId,
      suite_name: suite.name || '',
      suite_sha256: suiteSha,
      source_page: suite.source_page,
      created_at: new Date().toISOString(),
      collector: { playwright: (await import('playwright/package.json', { with: { type: 'json' } })).default.version,
                   browser: browser.version(), app_script: appScript,
                   image_size: args.imageSize },
      cases: records,
      control_inventories: inventories,
    };
    await fs.writeFile(path.join(tempDir, 'manifest.json'),
                       `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.unlink(path.join(tempDir, 'progress.json'));
  } finally {
    await browser.close();
  }
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  await fs.rename(tempDir, finalDir);
  const failures = records.filter((record) => record.status === 'error').length;
  const unavailable = records.filter((record) => record.status === 'not_available').length;
  console.log(`snapshot: ${finalDir} (${records.length - failures - unavailable} ok, ` +
              `${unavailable} unavailable, ${failures} failed)`);
  if (failures) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

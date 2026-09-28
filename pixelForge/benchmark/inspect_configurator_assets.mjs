#!/usr/bin/env node
/** Read-only inventory of image/layer metadata exposed by the configurator. */

import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('usage: inspect_configurator_assets.mjs URL');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const interestingResponses = [];
  const bodyPromises = [];
  page.on('response', (response) => {
    const value = response.url();
    const type = response.request().resourceType();
    if (type === 'image' || /api|config|variant|ring|image/i.test(value)) {
      const entry = {
        status: response.status(), type, url: value,
        method: response.request().method(),
        postData: response.request().postData(),
      };
      interestingResponses.push(entry);
      if (/diamond-proxy\/api\/(setting|setting-markup)/.test(value)) {
        bodyPromises.push(response.text().then((body) => {
          entry.body = body.slice(0, 2_000_000);
        }).catch((error) => { entry.bodyError = String(error); }));
      }
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector('img[alt="Preview — view 1"]', { timeout: 90_000 });
  await page.waitForTimeout(5_000);
  const exposed = await page.evaluate(() => {
    const scripts = [...document.scripts]
      .map((script) => script.textContent || '')
      .filter((text) => /frontFullImage|frontImage|VariantImageJson/.test(text))
      .map((text) => text.slice(0, 20_000));
    const storage = {};
    for (const [name, store] of [['localStorage', localStorage],
                                 ['sessionStorage', sessionStorage]]) {
      storage[name] = Object.fromEntries([...Array(store.length)].map((_, index) => {
        const key = store.key(index);
        const value = store.getItem(key);
        return [key, value?.slice(0, 20_000)];
      }));
    }
    return {
      images: [...document.images].map((image) => ({
        alt: image.alt, src: image.src, currentSrc: image.currentSrc,
        width: image.naturalWidth, height: image.naturalHeight,
      })),
      scripts,
      storage,
      nextData: document.querySelector('#__NEXT_DATA__')?.textContent?.slice(0, 100_000),
      resources: performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => /frontFullImage|frontImage|variant|api_image|config/i.test(name)),
    };
  });
  await Promise.all(bodyPromises);
  console.log(JSON.stringify({ exposed, responses: interestingResponses }, null, 2));
} finally {
  await browser.close();
}

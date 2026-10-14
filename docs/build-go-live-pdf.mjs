/**
 * Prints docs/go-live-guide.html to docs/Go-Live-Guide.pdf with page numbers.
 *
 *   node docs/build-go-live-pdf.mjs
 *
 * Needs Playwright and a Chromium: PLAYWRIGHT_MODULE and CHROMIUM_PATH override where they are.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
await page.goto(pathToFileURL(here('go-live-guide.html')).href, { waitUntil: 'load' });
await page.pdf({
  path: here('Go-Live-Guide.pdf'),
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="width:100%;font-family:'Liberation Sans',Arial,sans-serif;font-size:7.5pt;color:#7a8882;padding:0 17mm;display:flex;justify-content:space-between">
    <span>Navin Plastic Tech CRM · Going live on AWS</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
});
await browser.close();
console.log('wrote docs/Go-Live-Guide.pdf');

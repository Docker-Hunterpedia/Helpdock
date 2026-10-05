/**
 * Renders every design canvas artboard to an image, so docs/design/ can show
 * the screens on GitHub without the canvas.
 *
 *   node scripts/render-artboards.ts <artboards-dir> <screens-dir>
 *
 * `<artboards-dir>` holds the `*.dc.html` sources and `canvas.json` exported
 * from the canvas. Each board is written to `<screens-dir>/<group>/<title>.png`
 * at the size the canvas gives it, where `<group>` is the canvas section the
 * board sits under (foundations, m0 … m8). `pnpm design:render` runs it on
 * docs/design/.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type LaunchOptions, type Page } from '@playwright/test';
import sharp from 'sharp';
import {
  type Canvas,
  fileNameOf,
  fillHoles,
  groupOf,
  inlineFontUrls,
  parseDcSource,
  sectionsOf,
  withStylesheet,
} from './artboards.ts';

const PAGE_TIMEOUT_MS = 10_000;
const FONTS_DIR = new URL('../packages/ui/fonts/', import.meta.url);

/**
 * The artboards link IBM Plex from Google Fonts. The render uses the copies the
 * apps self-host instead, so it works offline and matches what ships.
 */
function selfHostedFonts(): string {
  const css = readFileSync(new URL('fonts.css', FONTS_DIR), 'utf8');
  return inlineFontUrls(css, (file) => readFileSync(new URL(file, FONTS_DIR)));
}

/**
 * The logic class runs in the page rather than in Node: it is canvas content,
 * and the browser is where the canvas runs it too.
 */
async function holeValues(
  page: Page,
  logic: string,
  defaults: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (logic.trim() === '') return { ...defaults };
  return page.evaluate(
    ({ source, props }) => {
      class DCLogic {
        props: Record<string, unknown>;
        state: Record<string, unknown> = {};
        constructor(initial: Record<string, unknown>) {
          this.props = initial;
        }
        setState(): void {}
      }
      try {
        const Component = new Function('DCLogic', `${source}\nreturn Component;`)(DCLogic);
        return { ...props, ...(new Component(props).renderVals?.() ?? {}) };
      } catch {
        return { ...props };
      }
    },
    { source: logic, props: { ...defaults } },
  );
}

async function render(
  page: Page,
  fonts: string,
  sourcePath: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const dc = parseDcSource(await readFile(sourcePath, 'utf8'));
  await page.setViewportSize({ width, height });
  await page.goto('about:blank');
  const html = fillHoles(dc.html, await holeValues(page, dc.logic, dc.defaults));
  await page.setContent(withStylesheet(html, fonts), { timeout: PAGE_TIMEOUT_MS });
  await page.evaluate('document.fonts.ready');
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  return sharp(shot)
    .png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

/**
 * `CHROMIUM_EXECUTABLE` points at a Chromium other than the one this Playwright
 * version downloads, for machines with a preinstalled browser.
 */
function launchOptions(): LaunchOptions {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: run by node directly, never as a turbo task
  const executablePath = process.env.CHROMIUM_EXECUTABLE;
  return executablePath ? { executablePath } : {};
}

async function main(): Promise<void> {
  const [inputDir, outputDir] = process.argv.slice(2);
  if (!inputDir || !outputDir) {
    console.error('usage: node scripts/render-artboards.ts <artboards-dir> <screens-dir>');
    process.exit(2);
  }
  const canvas: Canvas = JSON.parse(await readFile(path.join(inputDir, 'canvas.json'), 'utf8'));
  const sections = sectionsOf(canvas);
  const files = canvas.order ?? Object.keys(canvas.boards);
  const fonts = selfHostedFonts();

  await rm(outputDir, { recursive: true, force: true });
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const file of files) {
      const board = canvas.boards[file];
      if (!board) continue;
      const target = path.join(
        outputDir,
        groupOf(board, sections),
        `${fileNameOf(board.title)}.png`,
      );
      const image = await render(page, fonts, path.join(inputDir, file), board.w, board.h);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, image);
      console.log(`${file} -> ${path.relative(process.cwd(), target)}`);
    }
  } finally {
    await browser.close();
  }
}

await main();

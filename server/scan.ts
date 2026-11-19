import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { ScanLayout, ScanWord } from '../shared/scan.js';
import { UserError } from './recognize.js';

const run = promisify(execFile);
function readWords(tsv: string, width: number, height: number) {
  const words: ScanWord[] = [];
  for (const row of tsv.split(/\r?\n/)) {
    const [level, , block, paragraph, line, , left, top, boxWidth, boxHeight, , ...tokens] = row.split('\t');
    if (level !== '5') continue;
    const text = tokens.join(' ').trim(),
      x = Number(left),
      y = Number(top);
    const w = Number(boxWidth),
      h = Number(boxHeight);
    if (text && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height) {
      words.push({ text, x, y, w, h, line: [block, paragraph, line].join('.') });
    }
  }
  return words;
}
export async function preparePageImage(target: string) {
  let image = await readFile(target);
  try {
    const { stdout } = await run('tesseract', [target, 'stdout', '--psm', '0'], {
      timeout: 30_000,
      maxBuffer: 256_000,
    });
    const angle = Number(stdout.match(/^Rotate:\s*(0|90|180|270)/m)?.[1] ?? 0);
    if (angle && Number(stdout.match(/^Orientation confidence:\s*([\d.]+)/m)?.[1]) >= 2.5) {
      image = await sharp(image).rotate(angle).jpeg({ quality: 90 }).toBuffer();
      await writeFile(target, image);
    }
  } catch {
    /* Sparse pages can lack a reliable orientation. */
  }
  const { width, height } = await sharp(image).metadata();
  let words: ScanWord[] = [];
  try {
    const { stdout } = await run('tesseract', [target, 'stdout', '-l', 'rus+eng', '--psm', '3', 'tsv'], {
      timeout: 60_000,
      maxBuffer: 8_000_000,
    });
    words = readWords(stdout, width, height);
  } catch {
    /* The normalized image is available even without OCR. */
  }
  return { image, ocr: pageText(words), layout: { width, height, words } satisfies ScanLayout };
}

export function pageText(words: ScanWord[]) {
  const text = words
    .map((word, i) => (i && words[i - 1].line !== word.line ? '\n' : ' ') + word.text)
    .join('')
    .trim();
  return text.length > 12_000 ? text.slice(0, 6000) + '\n…\n' + text.slice(-6000) : text;
}

// A request and a retried registry job may ask for the same asset concurrently.
const pending = new Map<string, Promise<void>>();
async function once(key: string, build: () => Promise<void>) {
  try {
    await access(key);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let task = pending.get(key);
  if (!task) {
    task = build().finally(() => pending.delete(key));
    pending.set(key, task);
  }
  await task;
}
export async function scanPage(dir: string, page: number) {
  const base = path.join(dir, 'scans', String(page)),
    layout = base + '.json',
    image = base + '.jpg';
  await once(layout, async () => {
    await mkdir(path.dirname(base), { recursive: true, mode: 0o700 });
    const temp = base + '.' + randomUUID();
    try {
      await run(
        'pdftoppm',
        [
          '-f',
          String(page),
          '-l',
          String(page),
          '-singlefile',
          '-scale-to',
          '2200',
          '-jpeg',
          '-jpegopt',
          'quality=85',
          path.join(dir, 'source.pdf'),
          temp,
        ],
        { timeout: 120_000, maxBuffer: 256_000 }
      );
      const result = await preparePageImage(temp + '.jpg');
      await writeFile(temp + '.json', JSON.stringify(result.layout), { mode: 0o600 });
      await rename(temp + '.jpg', image);
      await rename(temp + '.json', layout);
    } catch {
      throw new UserError('Не удалось подготовить скан страницы ' + page + '.', 422);
    } finally {
      await Promise.all([rm(temp + '.jpg', { force: true }), rm(temp + '.json', { force: true })]);
    }
  });
  return { layout, image };
}
export async function saveDocument(dir: string, index: number, row: { first: number; last: number; name: string }) {
  const file = path.join(dir, 'documents', index + '.pdf');
  await once(file, async () => {
    const pdf = await PDFDocument.create();
    pdf.setTitle(row.name);
    const { stdout } = await run(
      'pdfinfo',
      ['-f', String(row.first), '-l', String(row.last), path.join(dir, 'source.pdf')],
      { timeout: 60000, maxBuffer: 8_000_000 }
    );
    const sizes = new Map(
      [...stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((m) => [
        Number(m[1]),
        [Number(m[2]), Number(m[3])],
      ])
    );
    for (let n = row.first; n <= row.last; n++) {
      const scan = await scanPage(dir, n);
      const jpg = await pdf.embedJpg(await readFile(scan.image));
      const size = sizes.get(n);
      if (!size) throw new UserError('Не удалось определить размер листа ' + n + '.', 422);
      const [w, h] = size;
      const [width, height] = w > h === jpg.width > jpg.height ? [w, h] : [h, w];
      pdf.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
      await jpg.embed();
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + randomUUID();
    try {
      await writeFile(temp, await pdf.save(), { mode: 0o600 });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  });
  return file;
}

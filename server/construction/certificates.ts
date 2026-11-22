import { BadRequestException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
const run = promisify(execFile);
export async function certificate(data: Buffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'quality-document-')),
    source = path.join(dir, 'original');
  const isPdf = data.subarray(0, 5).toString() === '%PDF-';
  let pages = 1,
    text = '',
    warning = '';
  try {
    await writeFile(source, data);
    if (isPdf) {
      try {
        pages = (await PDFDocument.load(data)).getPageCount();
      } catch {
        throw new BadRequestException('PDF повреждён или защищён паролем.');
      }
      try {
        text = (
          await run('pdftotext', ['-f', '1', '-l', '3', '-layout', source, '-'], {
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout;
      } catch {
        /* use OCR below */
      }
    }
    if (text.trim().length < 25) {
      const image = path.join(dir, 'page.png');
      try {
        if (isPdf)
          await run(
            'pdftoppm',
            ['-singlefile', '-f', '1', '-l', '1', '-scale-to', '2200', '-png', source, path.join(dir, 'page')],
            { timeout: 20000 },
          );
        else
          await sharp(data, { limitInputPixels: 50_000_000 })
            .rotate()
            .resize({ width: 2200, withoutEnlargement: true })
            .png()
            .toFile(image);
        text = (
          await run('tesseract', [image, 'stdout', '-l', 'rus+eng', '--psm', '3'], {
            timeout: 45000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout;
      } catch {
        warning = 'Текст не распознан. Заполните реквизиты вручную.';
      }
    }
    const compact = text.replace(/[ \t]+/g, ' ');
    const docType =
      compact.match(
        /сертификат соответствия|декларация о соответствии|паспорт качества|протокол испытаний|сертификат качества|паспорт/iu,
      )?.[0] || '';
    const number =
      compact.match(/(?:№|номер[:\s]+)\s*([\p{L}\d][\p{L}\d./–_-]*)/iu)?.[1] ||
      compact.match(/(?:РОСС|ЕАЭС)\s+[\p{L}\d.\-/ ]{5,48}/u)?.[0]?.trim() ||
      '';
    const dates = compact.match(/\b\d{2}[./]\d{2}[./]\d{4}\b/g) || [];
    const validity = compact.match(
      /(?:срок действия|действителен|действует)?\s*с\s+(\d{2}[./]\d{2}[./]\d{4})\s+(?:по|до)\s+(\d{2}[./]\d{2}[./]\d{4})/iu,
    );
    const issuer =
      compact.match(/(?:изготовитель|производитель|поставщик|выдан)\s*[:–-]?\s*([^\n]{3,150})/iu)?.[1]?.trim() ||
      '';
    const name =
      compact
        .match(/(?:наименование продукции|продукция|наименование материала)\s*[:–-]?\s*([^\n]{3,180})/iu)?.[1]
        ?.trim() || '';
    return {
      values: {
        name,
        docType,
        number,
        date: validity ? 'с ' + validity[1] + ' по ' + validity[2] : dates[0] || '',
        issuer,
        pages: String(pages),
      },
      text: text.trim().slice(0, 12000),
      warning: warning || (!text.trim() ? 'Не удалось извлечь текст. Заполните поля вручную.' : ''),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

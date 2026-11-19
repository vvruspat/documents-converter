import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Models } from '../shared/models.js';
import { UserError } from './recognize.js';

// Router variants (for example ":free") are part of the opaque model ID.
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-z\d._~-]+\/[a-z\d._~:/-]+$/i);
const modelInput = z.object({ recognition: modelId, chat: modelId, regions: modelId }).strict();

export class ModelSettings {
  private file: string;
  constructor(directory: string, private defaults: Models) {
    this.file = path.resolve(directory, 'model-settings.json');
  }
  async get(): Promise<Models> {
    try {
      return modelInput.parse(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...this.defaults };
      throw error;
    }
  }
  async save(input: unknown): Promise<Models> {
    const result = modelInput.safeParse(input);
    if (!result.success) throw new UserError('Для каждой задачи укажите ID OpenRouter в формате provider/model.');
    const temporary = this.file + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(result.data), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
    return result.data;
  }
}

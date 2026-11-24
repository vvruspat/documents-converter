import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defaultRegionRetries, maxRegionRetries, type Models, type RecognitionSettings } from '../shared/models.js';
import { UserError } from './recognize.js';

// Router variants (for example ":free") are part of the opaque model ID.
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-z\d._~-]+\/[a-z\d._~:/-]+$/i);
const modelInput = z.object({ recognition: modelId, chat: modelId, regions: modelId,
  regionRetries: z.number().int().min(0).max(maxRegionRetries).optional(),
}).strict();

export class ModelSettings {
  private file: string;
  constructor(directory: string, private defaults: Models) {
    this.file = path.resolve(directory, 'model-settings.json');
  }
  async get(): Promise<RecognitionSettings> {
    try {
      const saved = modelInput.parse(JSON.parse(await readFile(this.file, 'utf8')));
      return { ...saved, regionRetries: saved.regionRetries ?? defaultRegionRetries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...this.defaults, regionRetries: defaultRegionRetries };
      throw error;
    }
  }
  async save(input: unknown): Promise<RecognitionSettings> {
    const result = modelInput.safeParse(input);
    if (!result.success) {
      if (result.error.issues.some(issue => issue.path[0] === 'regionRetries')) {
        throw new UserError(`Число повторов должно быть целым от 0 до ${maxRegionRetries}.`);
      }
      throw new UserError('Для каждой задачи укажите ID OpenRouter в формате provider/model.');
    }
    const settings = { ...result.data, regionRetries: result.data.regionRetries ?? (await this.get()).regionRetries };
    const temporary = this.file + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
    return settings;
  }
}

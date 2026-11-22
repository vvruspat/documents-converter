import { z } from 'zod';
import { kinds, projectSchema, rowSchema, type Entry, type Project } from '../../shared/construction.js';

const storedSchema = projectSchema.extend({
  rows: z.array(rowSchema.extend({ kind: z.enum([...kinds, 'phase']) })).max(15000),
});

// Older projects can contain both levels. Keep existing package memberships (including
// multiple memberships), and reuse a phase's ID for its formerly unassigned works.
export function readProject(input: unknown): Project {
  const stored = storedSchema.parse(input);
  const parentIds = new Set(stored.rows.filter((r) => r.kind === 'pack').map((r) => r.links.phase?.[0]));
  const fallbackIds = new Set(
    stored.rows.filter((r) => r.kind === 'work' && !r.links.pack?.length).map((r) => r.links.phase?.[0]),
  );
  const phases = new Map(stored.rows.filter((r) => r.kind === 'phase').map((r) => [r.id, r.v.name]));
  const rows: Entry[] = [];
  for (const row of stored.rows) {
    if (row.kind === 'phase') {
      if (!parentIds.has(row.id) || fallbackIds.has(row.id)) rows.push({ ...row, kind: 'pack' });
      continue;
    }
    const { phase, ...links } = row.links;
    if (row.kind === 'work' && !links.pack?.length && phase?.length) links.pack = phase;
    const priorName = row.kind === 'pack' && phase?.[0] && phases.get(phase[0]);
    const v = priorName ? { ...row.v, previousPhase: priorName } : row.v;
    rows.push({ ...row, kind: row.kind, v, links });
  }
  return { ...stored, rows };
}

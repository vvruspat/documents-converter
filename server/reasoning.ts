type Role = 'ocr' | 'chat';
type Capability = { mandatory?: boolean; supported_efforts?: string[] };
type Model = { id: string; reasoning?: Capability };

export function createReasoningPolicy(load: typeof fetch) {
  let models = new Map<string, Capability>();
  let refreshAfter = 0;
  let pending: Promise<void> | undefined;

  async function refresh() {
    try {
      const response = await load('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Catalog HTTP ' + response.status);
      const { data }: { data: Model[] } = await response.json();
      models = new Map(data.filter(m => Array.isArray(m.reasoning?.supported_efforts)).map(m => [m.id, m.reasoning!]));
      refreshAfter = Date.now() + 3_600_000;
    } catch {
      // Keep the last successful catalog during a temporary OpenRouter outage.
      refreshAfter = Date.now() + 60_000;
    }
  }

  return async (model: string, role: Role) => {
    if (Date.now() >= refreshAfter) {
      pending ??= refresh().finally(() => { pending = undefined; });
      await pending;
    }
    const capability = models.get(model);
    const preferred = role === 'ocr' ? ['none', 'minimal', 'low'] : ['low', 'minimal', 'none'];
    const effort = preferred.find(e => capability?.supported_efforts?.includes(e) && (e !== 'none' || !capability.mandatory));
    return effort ? { reasoning: { effort } } : {};
  };
}

// The public catalog uses a separate, unauthenticated request.
export const reasoningFor = createReasoningPolicy((url, init) => fetch(url, init));

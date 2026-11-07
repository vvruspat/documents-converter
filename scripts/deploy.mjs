import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const { COOLIFY_WEBHOOK_URL, COOLIFY_WEBHOOK_SECRET, APP_URL, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_REF } = process.env;
for (const name of ['COOLIFY_WEBHOOK_URL', 'COOLIFY_WEBHOOK_SECRET', 'APP_URL', 'GITHUB_SHA', 'GITHUB_REPOSITORY']) {
  if (!process.env[name]) throw new Error(`Missing required deployment setting: ${name}`);
}
if (!/^[a-f0-9]{40}$/.test(GITHUB_SHA) || GITHUB_REF !== 'refs/heads/main') throw new Error('Only a verified main-branch commit can be deployed.');
if (new URL(COOLIFY_WEBHOOK_URL).protocol !== 'https:' || new URL(APP_URL).protocol !== 'https:') throw new Error('Deployment and application URLs must use HTTPS.');
const payload = JSON.stringify({
  ref: GITHUB_REF, after: GITHUB_SHA, deleted: false,
  repository: { full_name: GITHUB_REPOSITORY, html_url: `https://github.com/${GITHUB_REPOSITORY}` },
  head_commit: { id: GITHUB_SHA, message: 'Deploy commit after successful checks' },
  commits: [{ id: GITHUB_SHA, message: 'Deploy commit after successful checks', modified: ['Dockerfile'], added: [], removed: [] }],
});
const signature = createHmac('sha256', COOLIFY_WEBHOOK_SECRET).update(payload).digest('hex');
const response = await fetch(COOLIFY_WEBHOOK_URL, {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': `sha256=${signature}` },
  body: payload,
});
if (!response.ok) throw new Error(`Coolify rejected the deployment webhook (${response.status}).`);
const result = await response.text();
if (!result.includes('deployment_uuid')) throw new Error('Coolify did not confirm a queued deployment. Check the application webhook settings.');
console.log(`Deployment queued for ${GITHUB_SHA}. Waiting for the exact commit to become healthy.`);
const deadline = Date.now() + 17 * 60_000;
while (Date.now() < deadline) {
  try {
    const health = await fetch(new URL('/api/health', APP_URL), { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (health.ok) {
      const data = await health.json();
      if (data.status === 'ok' && data.commit === GITHUB_SHA) { console.log(`Healthy: ${APP_URL} (${GITHUB_SHA})`); process.exit(0); }
    }
  } catch { /* A rollout can temporarily return a network or proxy error. */ }
  await setTimeout(10000);
}
throw new Error('The deployment did not become healthy with the expected commit within 17 minutes. Check Coolify deployment logs.');

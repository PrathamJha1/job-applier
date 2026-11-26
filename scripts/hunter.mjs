import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

try { process.loadEnvFile(); } catch {}

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: {
    domain: { type: 'string' },
    first: { type: 'string' },
    last: { type: 'string' },
    email: { type: 'string' },
    out: { type: 'string' },
  },
});

const usage = `Usage:
  node scripts/snov.mjs domain --domain razorpay.com [--out jobs/SLUG/snov.json]
  node scripts/snov.mjs find --domain razorpay.com --first Rahul --last Sharma
  node scripts/snov.mjs verify --email rahul.sharma@razorpay.com`;

const required = { domain: ['domain'], find: ['domain', 'first', 'last'], verify: ['email'] }[command];
if (!required || required.some((k) => !args[k])) {
  console.error(usage);
  process.exit(1);
}

const fail = (msg) => {
  console.error(`snov error: ${msg}`);
  process.exit(1);
};

// A cached --out file saves credits, and needs no key.
if (command === 'domain' && args.out && existsSync(args.out)) {
  console.log(readFileSync(args.out, 'utf8').trim());
  process.exit(0);
}

const clientId = process.env.SNOV_CLIENT_ID;
const clientSecret = process.env.SNOV_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.log(JSON.stringify({ enabled: false }));
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAccessToken() {
  let res;
  try {
    res = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    fail(`could not reach Snov OAuth (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    fail(`Snov credentials rejected (HTTP ${res.status}: ${body.message || res.statusText})`);
  }
  return body.access_token;
}

async function snovRequest(token, url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    fail(`could not reach Snov (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.message || body.error || res.statusText;
    if (res.status === 429 || /limit|credit|balance/i.test(detail)) {
      fail(`out of credits or rate limited (HTTP ${res.status}: ${detail})`);
    }
    if (res.status === 401 || res.status === 403) {
      fail(`API unauthorized or free-plan API access not enabled (${detail})`);
    }
    fail(`HTTP ${res.status}: ${detail}`);
  }
  return body;
}

async function pollTask(token, resultUrl, maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(1500);
    const body = await snovRequest(token, resultUrl, { method: 'GET' });
    if (body.status === 'completed') return body;
  }
  fail('timed out waiting for Snov async task to complete');
}

const token = await getAccessToken();
let result;

if (command === 'domain') {
  // 1. Start domain emails search
  const start = await snovRequest(
    token,
    `https://api.snov.io/v2/domain-search/domain-emails/start?${new URLSearchParams({ domain: args.domain })}`,
    { method: 'POST' }
  );
  const taskHash = start.data?.task_hash || start.task_hash;
  if (!taskHash) fail('no task_hash returned from domain search');

  // 2. Poll until completed
  const done = await pollTask(token, `https://api.snov.io/v2/domain-search/domain-emails/result/${taskHash}`);
  const emails = done.data?.emails ?? done.data ?? [];

  result = {
    organization: done.data?.company_name ?? null,
    pattern: null,
    acceptAll: null,
    people: emails.slice(0, 10).map((e) => ({
      firstName: e.first_name ?? null,
      lastName: e.last_name ?? null,
      position: e.position ?? null,
      email: e.email ?? e.value ?? null,
      confidence: null,
      linkedin: e.source_page ?? null,
    })),
  };

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(result, null, 2));
  }
} else if (command === 'find') {
  // 1. Start email finder by name + domain
  const start = await snovRequest(token, 'https://api.snov.io/v2/emails-by-domain-by-name/start', {
    method: 'POST',
    body: JSON.stringify({
      rows: [{ first_name: args.first, last_name: args.last, domain: args.domain }],
    }),
  });
  const taskHash = start.data?.task_hash || start.task_hash;
  if (!taskHash) fail('no task_hash returned from email finder');

  // 2. Poll until completed
  const done = await pollTask(
    token,
    `https://api.snov.io/v2/emails-by-domain-by-name/result?${new URLSearchParams({ task_hash: taskHash })}`
  );
  const match = done.data?.[0]?.result?.[0] ?? {};
  result = {
    email: match.email ?? null,
    score: match.smtp_status === 'valid' ? 100 : match.smtp_status === 'unknown' ? 50 : 0,
  };
} else {
  // 1. Start email verification
  const start = await snovRequest(token, 'https://api.snov.io/v2/email-verification/start', {
    method: 'POST',
    body: JSON.stringify({ emails: [args.email] }),
  });
  const taskHash = start.data?.task_hash || start.task_hash;
  if (!taskHash) fail('no task_hash returned from email verifier');

  // 2. Poll until completed
  const done = await pollTask(
    token,
    `https://api.snov.io/v2/email-verification/result?${new URLSearchParams({ task_hash: taskHash })}`
  );
  const entry = done.data?.[0]?.result ?? done.data?.[0] ?? {};
  const status = entry.smtp_status ?? null;
  result = {
    email: entry.email ?? args.email,
    status,
    score: status === 'valid' ? 100 : status === 'unknown' ? 50 : 0,
  };
}

console.log(JSON.stringify(result, null, 2));
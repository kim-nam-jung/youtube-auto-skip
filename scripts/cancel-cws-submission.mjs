import { appendFile } from 'node:fs/promises';

// Cancels the item's active submission only when it is exactly the version the
// person named. fetchStatus GET, one cancelSubmission POST, then a confirming
// fetchStatus GET. No upload or publish request and no API retries.
const activeStates = new Set(['PENDING_REVIEW', 'STAGED']);
const versionPattern = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

function submitted(data) {
  const revision = data?.submittedItemRevisionStatus;
  const versions = Array.isArray(revision?.distributionChannels) ?
    revision.distributionChannels.map(channel => channel?.crxVersion).filter(version => typeof version === 'string') : [];
  return { state: typeof revision?.state === 'string' ? revision.state : 'NOT_RETURNED', versions };
}

async function call(url, method, accessToken, label) {
  let response;
  try {
    response = await fetch(url, { method, headers: { Authorization: `Bearer ${accessToken}` },
      ...(method === 'POST' ? { body: '' } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
  } catch {
    throw new Error(`Chrome Web Store ${label} request failed or timed out.`);
  }
  if (!response.ok) throw new Error(`Chrome Web Store ${label} request failed (HTTP ${response.status}).`);
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch {
    throw new Error(`Chrome Web Store returned an invalid ${label} response.`);
  }
}

async function main() {
  const publisherId = process.env.CWS_PUBLISHER_ID?.trim();
  const extensionId = process.env.CWS_EXTENSION_ID?.trim();
  const accessToken = process.env.CWS_ACCESS_TOKEN?.trim();
  const expected = process.env.CANCEL_VERSION?.trim();
  if (!publisherId || !/^[A-Za-z0-9_-]{1,128}$/.test(publisherId)) throw new Error('CWS_PUBLISHER_ID is missing or invalid.');
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) throw new Error('CWS_EXTENSION_ID is missing or invalid.');
  if (!accessToken || /\s/.test(accessToken)) throw new Error('CWS_ACCESS_TOKEN is missing or invalid.');
  if (!expected || !versionPattern.test(expected)) throw new Error('The version to cancel is missing or invalid.');
  const name = `publishers/${publisherId}/items/${extensionId}`;
  const base = `https://chromewebstore.googleapis.com/v2/${name}`;

  const before = submitted(await call(`${base}:fetchStatus`, 'GET', accessToken, 'status'));
  if (!activeStates.has(before.state)) {
    throw new Error(`No active submission to cancel (submitted state ${before.state}). Nothing was changed.`);
  }
  if (!before.versions.includes(expected)) {
    throw new Error(`The active submission is ${before.versions.join(', ') || 'an unknown version'}, not ${expected}. Nothing was changed.`);
  }
  await call(`${base}:cancelSubmission`, 'POST', accessToken, 'cancelSubmission');
  const after = submitted(await call(`${base}:fetchStatus`, 'GET', accessToken, 'status'));
  const checkedAt = new Date();
  const report = { checkedAtUtc: checkedAt.toISOString(), name, cancelledVersion: expected,
    before: before.state, after: after.state, afterVersions: after.versions };
  const json = JSON.stringify(report, null, 2).split(accessToken).join('[redacted]');
  console.log(json);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Chrome Web Store submission cancelled\n\n\`\`\`json\n${json}\n\`\`\`\n`, 'utf8').catch(() => {});
  }
  if (activeStates.has(after.state) && after.versions.includes(expected)) {
    throw new Error(`cancelSubmission returned, but ${expected} still reports ${after.state}. Check the dashboard.`);
  }
}

main().catch(error => {
  // Messages are fixed text, states, versions or HTTP status numbers, never
  // response bodies, headers, credentials or tokens.
  console.error(error.message);
  process.exitCode = 1;
});

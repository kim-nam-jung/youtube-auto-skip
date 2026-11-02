const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { buildSync } = require('esbuild');
const source = buildSync({ entryPoints: [path.join(__dirname, '../src/continue-dialog.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'browser' }).outputFiles[0].text;
function find(options = {}) {
  const dialog = { textContent: options.text || '동영상이 일시중지되었습니다. 계속 시청하시겠어요? 확인 취소',
    querySelectorAll: () => [button] };
  const button = { textContent: options.label || '확인', isConnected: options.connected !== false, parentElement: null,
    closest: selector => selector.includes('ytd-confirm') ? (options.otherDialog ? {} : dialog) : options.hidden ? {} : null,
    matches: () => options.disabled === true, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ x: 20, y: 20, width: 100, height: 40 }), contains: () => false };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, innerWidth: 800, innerHeight: 600,
    location: { href: options.url || 'https://www.youtube.com/watch?v=fixture' },
    document: { querySelector: () => options.noVideo ? null : { paused: options.paused !== false, ended: options.ended === true },
      querySelectorAll: () => [dialog], elementFromPoint: () => options.covered ? {} : button },
    getComputedStyle: () => ({ visibility: 'visible', pointerEvents: 'auto', display: options.display || 'block',
      contentVisibility: 'visible', opacity: options.opacity ?? '1' }) });
  return module.exports.findContinueTarget();
}
test('recognizes Korean and English inactivity prompts with affirmative buttons', () => {
  for (const options of [{}, { text: '동영상이 일시 중지되었습니다. 계속 시청할까요?', label: '예' },
    { text: 'Video paused. Continue watching?', label: 'Yes' }]) assert.ok(find(options));
});
test('never confirms unrelated, destructive, payment or cancel dialogs', () => {
  for (const text of ['동영상을 삭제하시겠어요?', '계속하려면 결제하세요', '계속 시청', 'Video paused', 'Confirm payment']) assert.equal(find({ text }), null);
  for (const label of ['취소', '아니요', 'Cancel', '삭제', '결제']) assert.equal(find({ label }), null);
});
test('requires paused media and the current YouTube watch page', () => {
  for (const options of [{ paused: false }, { ended: true }, { noVideo: true },
    { url: 'https://www.youtube.com/shorts/fixture' }, { url: 'https://www.youtube.com/watch' },
    { url: 'https://example.com/watch?v=fixture' }]) assert.equal(find(options), null);
});
test('hidden, covered, disabled, disconnected or nested-other-dialog buttons are rejected', () => {
  for (const options of [{ hidden: true }, { covered: true }, { disabled: true }, { connected: false },
    { opacity: '0' }, { display: 'none' }, { otherDialog: true }]) assert.equal(find(options), null);
});

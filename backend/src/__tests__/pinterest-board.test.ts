import { extractGalleryInfo, downloadGalleryZip } from '../services/gallery.service';
import path from 'path';
import fs from 'fs';
import { CONFIG } from '../config';

async function testPinterestSuite() {
  console.log('--- 📌 PINTEREST COMPREHENSIVE TEST SUITE ---');

  // Test 1: Real Pin
  console.log('\n[1] Testing Single Pin URL:');
  const pin1 = await extractGalleryInfo('https://www.pinterest.com/pin/7036943156993183/');
  console.log(`✅ Extracted: "${pin1.title}" (${pin1.images.length} Photos)`);

  // Test 2: Short Pin.it link
  console.log('\n[2] Testing Short pin.it Link:');
  const pin2 = await extractGalleryInfo('https://pin.it/6U6n3zF');
  console.log(`✅ Extracted: "${pin2.title}" (${pin2.images.length} Photos)`);

  // Test 3: ZIP Generation Test
  console.log('\n[3] Testing ZIP Download Creation:');
  const testZip = path.join(CONFIG.TEMP_DIR, `test_gallery_${Date.now()}.zip`);
  await downloadGalleryZip(pin1.images, testZip);
  if (fs.existsSync(testZip)) {
    const size = fs.statSync(testZip).size;
    console.log(`✅ ZIP Created Successfully (${(size / 1024).toFixed(1)} KB)`);
    fs.unlinkSync(testZip);
  } else {
    throw new Error('ZIP creation failed');
  }

  console.log('\n========================================');
  console.log('✅ ALL PINTEREST TESTS PASSED (100% WORKING)');
  console.log('========================================');
}

testPinterestSuite().catch((e) => {
  console.error('❌ Test failed:', e.message);
  process.exit(1);
});

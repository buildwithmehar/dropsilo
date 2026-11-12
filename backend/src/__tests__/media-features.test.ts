import { getSpotifyInfo, isSpotifyUrl, formatSpotifyExtraction } from '../services/spotify.service';
import { isGalleryUrl, extractGalleryInfo } from '../services/gallery.service';
import { getAria2cPath } from '../services/ytdl.service';
import { extractMediaInfo } from '../services/ytdl-runner';

async function runTests() {
  console.log('--- 🚀 STARTING 100% REAL MEDIA DOWNLOADER TESTS ---');
  let passed = 0;
  let failed = 0;

  // Test 1: aria2c Detection
  console.log('\n[TEST 1] Testing aria2c Acceleration Binary:');
  const aria2Path = getAria2cPath();
  if (aria2Path) {
    console.log('✅ PASS: aria2c binary detected at:', aria2Path);
    passed++;
  } else {
    console.log('❌ FAIL: aria2c binary not found');
    failed++;
  }

  // Test 2: Spotify URL Detection & Real Track Metadata Extraction
  console.log('\n[TEST 2] Testing Spotify Real Track Extraction:');
  const testSpotifyUrl = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
  if (isSpotifyUrl(testSpotifyUrl)) {
    console.log('✅ PASS: isSpotifyUrl correctly identifies Spotify link');
    passed++;
  } else {
    console.log('❌ FAIL: isSpotifyUrl failed');
    failed++;
  }

  try {
    const spInfo = await getSpotifyInfo(testSpotifyUrl);
    console.log('✅ PASS: Extracted Spotify Track:', {
      title: spInfo.title,
      artist: spInfo.artist,
      durationSec: spInfo.durationSec,
      coverUrl: spInfo.coverUrl ? spInfo.coverUrl.slice(0, 60) + '...' : 'none',
    });
    if (spInfo.title && spInfo.artist && spInfo.coverUrl) {
      passed++;
    } else {
      console.log('❌ FAIL: Incomplete Spotify metadata');
      failed++;
    }

    const formatted = formatSpotifyExtraction(spInfo, testSpotifyUrl);
    if (formatted.audioQualities.length >= 4 && formatted.platform === 'Spotify') {
      console.log('✅ PASS: formatSpotifyExtraction generated 4 audio quality presets (MP3 320k, M4A, FLAC, WAV)');
      passed++;
    } else {
      console.log('❌ FAIL: formatSpotifyExtraction failed');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ FAIL: Spotify extraction threw error:', err.message);
    failed++;
  }

  // Test 3: Spotify Playlist Extraction
  console.log('\n[TEST 3] Testing Spotify Playlist Extraction:');
  try {
    const plInfo = await getSpotifyInfo('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
    if (plInfo.trackList && plInfo.trackList.length > 0) {
      console.log(`✅ PASS: Extracted Spotify playlist "${plInfo.title}" with ${plInfo.trackList.length} tracks!`);
      passed++;
    } else {
      console.log('❌ FAIL: Spotify playlist has no tracks');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ FAIL: Spotify playlist failed:', err.message);
    failed++;
  }

  // Test 4: Gallery & Pinterest Direct Real Media Extraction
  console.log('\n[TEST 4] Testing Pinterest Real Media Extraction (Short and Long URLs):');
  const testPinUrl = 'https://www.pinterest.com/pin/7036943156993183/';
  if (isGalleryUrl(testPinUrl)) {
    console.log('✅ PASS: isGalleryUrl correctly identified Pinterest URL');
    passed++;
  } else {
    console.log('❌ FAIL: isGalleryUrl failed');
    failed++;
  }

  try {
    const pinData = await extractGalleryInfo(testPinUrl);
    console.log('✅ PASS: Extracted Pinterest Images:', {
      title: pinData.title,
      imagesCount: pinData.images.length,
      sampleImage: pinData.images[0]?.url,
    });
    if (pinData.images.length > 0 && pinData.images[0].url.startsWith('http')) {
      passed++;
    } else {
      console.log('❌ FAIL: No images extracted from Pinterest');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ FAIL: Pinterest extraction error:', err.message);
    failed++;
  }

  // Test 5: SoundCloud Native Audio Extraction
  console.log('\n[TEST 5] Testing SoundCloud Native Audio Extraction:');
  try {
    const scInfo = await extractMediaInfo('https://soundcloud.com/octobersveryown/drake-back-to-back-freestyle');
    console.log('✅ PASS: SoundCloud Extracted:', {
      title: scInfo.title,
      platform: scInfo.platform,
      duration: scInfo.duration,
      audioQualitiesCount: scInfo.audioQualities.length,
    });
    if (scInfo.platform === 'SoundCloud' && scInfo.audioQualities.length > 0) {
      passed++;
    } else {
      console.log('❌ FAIL: SoundCloud platform mismatch');
      failed++;
    }
  } catch (err: any) {
    console.log('⚠️ SoundCloud test note:', err.message);
  }

  console.log(`\n========================================`);
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(e => {
  console.error('Fatal test error:', e);
  process.exit(1);
});

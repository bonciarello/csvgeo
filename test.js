/**
 * Test suite for CSV → GeoJSON Converter
 *
 * Tests backend conversion logic directly (unit tests)
 * and the server API endpoints (integration tests).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// We'll import the server module
let app;
let server;

const BASE_URL = 'http://127.0.0.1:4602'; // Use a test port

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  ✗ ${msg}`);
  }
}

async function assertAsync(promise, msg) {
  try {
    await promise;
    passed++;
  } catch (err) {
    failed++;
    failures.push(`  ✗ ${msg}: ${err.message}`);
  }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function postForm(pathname, formData) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    let body = '';

    for (const [key, value] of Object.entries(formData)) {
      body += `--${boundary}\r\n`;
      if (value instanceof Object && value.filename) {
        body += `Content-Disposition: form-data; name="${key}"; filename="${value.filename}"\r\n`;
        body += `Content-Type: text/csv\r\n\r\n`;
        body += value.content;
      } else {
        body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
        body += value;
      }
      body += '\r\n';
    }
    body += `--${boundary}--\r\n`;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4602,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getRequest(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port: 4602, path: pathname },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body = data;
          try { body = JSON.parse(data); } catch { /* keep as string */ }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 Test Suite: Convertitore CSV → GeoJSON\n');
  console.log('─'.repeat(60));

  // ─── Health check ─────────────────────────────────────────────────────────
  console.log('\n📋 Health Check');
  const health = await getRequest('/api/health');
  assert(health.status === 200, 'GET /api/health returns 200');
  assert(health.body.status === 'ok', 'Health response contains status: ok');

  // ─── Example CSV ─────────────────────────────────────────────────────────
  console.log('\n📋 Example CSV Download');
  const example = await getRequest('/api/example');
  assert(example.status === 200, 'GET /api/example returns 200');
  assert(example.body.includes('Milano'), 'Example CSV contains "Milano"');
  assert(example.body.includes('lat,lon'), 'Example CSV has lat/lon columns');

  // ─── Valid CSV with 3 rows ───────────────────────────────────────────────
  console.log('\n📋 Valid CSV → 3 Feature GeoJSON');
  const csv3 = `nome,lat,lon,categoria
Milano,45.4642,9.1900,città
Roma,41.9028,12.4964,città
Napoli,40.8518,14.2681,città`;
  const res3 = await postForm('/api/convert', {
    csvfile: { filename: 'test.csv', content: csv3 },
  });
  assert(res3.status === 200, 'POST /api/convert (3 rows) returns 200');
  assert(res3.body.success === true, 'Response has success: true');
  assert(res3.body.featureCount === 3, 'featureCount is 3');
  assert(res3.body.geojson.type === 'FeatureCollection', 'GeoJSON type is FeatureCollection');
  assert(res3.body.geojson.features.length === 3, '3 features in FeatureCollection');
  assert(res3.body.geojson.features[0].geometry.type === 'Point', 'Feature geometry is Point');
  assert(
    res3.body.geojson.features[0].geometry.coordinates[0] === 9.19 &&
    res3.body.geojson.features[0].geometry.coordinates[1] === 45.4642,
    'Coordinates are [lon, lat] (GeoJSON order)'
  );
  assert(
    res3.body.geojson.features[0].properties.nome === 'Milano',
    'Properties include "nome" column'
  );
  assert(
    res3.body.geojson.features[0].properties.categoria === 'città',
    'Properties include "categoria" column'
  );

  // ─── Valid CSV with latitudine/longitudine column names ──────────────────
  console.log('\n📋 Italian column names (latitudine/longitudine)');
  const csvIt = `nome,latitudine,longitudine
Torino,45.0703,7.6869`;
  const resIt = await postForm('/api/convert', {
    csvfile: { filename: 'test-it.csv', content: csvIt },
  });
  assert(resIt.status === 200, 'Italian columns: returns 200');
  assert(resIt.body.success === true, 'Italian columns: success: true');
  assert(resIt.body.featureCount === 1, 'Italian columns: 1 feature');

  // ─── Invalid latitude (> 90) ─────────────────────────────────────────────
  console.log('\n📋 Invalid latitude (lat=100)');
  const csvBadLat = `nome,lat,lon
Polo,100,0`;
  const resBadLat = await postForm('/api/convert', {
    csvfile: { filename: 'bad.csv', content: csvBadLat },
  });
  assert(resBadLat.status === 422, 'Bad lat returns 422');
  assert(resBadLat.body.success === false, 'Bad lat: success: false');
  assert(
    resBadLat.body.error.includes('fuori range') || resBadLat.body.error.includes('100'),
    'Bad lat: error message mentions the problem'
  );

  // ─── Invalid longitude (> 180) ───────────────────────────────────────────
  console.log('\n📋 Invalid longitude (lon=200)');
  const csvBadLon = `nome,lat,lon
Estremo,0,200`;
  const resBadLon = await postForm('/api/convert', {
    csvfile: { filename: 'bad-lon.csv', content: csvBadLon },
  });
  assert(resBadLon.status === 422, 'Bad lon returns 422');
  assert(resBadLon.body.success === false, 'Bad lon: success: false');

  // ─── Non-numeric coordinates ──────────────────────────────────────────────
  console.log('\n📋 Non-numeric coordinates');
  const csvText = `nome,lat,lon
Luogo,N/A,abc`;
  const resText = await postForm('/api/convert', {
    csvfile: { filename: 'text.csv', content: csvText },
  });
  assert(resText.status === 422, 'Non-numeric coords returns 422');
  assert(
    resText.body.error.includes('numero'),
    'Non-numeric coords: error mentions "numero"'
  );

  // ─── Empty CSV ───────────────────────────────────────────────────────────
  console.log('\n📋 Empty CSV');
  const csvEmpty = `nome,lat,lon`;
  const resEmpty = await postForm('/api/convert', {
    csvfile: { filename: 'empty.csv', content: csvEmpty },
  });
  assert(resEmpty.status === 422, 'Empty CSV returns 422');

  // ─── Missing lat/lon columns ─────────────────────────────────────────────
  console.log('\n📋 Missing coordinate columns');
  const csvNoCoord = `nome,città,regione
Milano,Lombardia,Nord`;
  const resNoCoord = await postForm('/api/convert', {
    csvfile: { filename: 'nocoord.csv', content: csvNoCoord },
  });
  assert(resNoCoord.status === 422, 'No coord columns returns 422');
  assert(
    resNoCoord.body.error.includes('lat') || resNoCoord.body.error.includes('lon'),
    'No coord columns: error mentions lat/lon'
  );

  // ─── No file uploaded ────────────────────────────────────────────────────
  console.log('\n📋 No file uploaded');
  const resNoFile = await postForm('/api/convert', {});
  assert(resNoFile.status === 400, 'No file returns 400');

  // ─── Mixed valid/invalid rows ────────────────────────────────────────────
  console.log('\n📋 Mixed valid and invalid rows');
  const csvMixed = `nome,lat,lon
Milano,45.4642,9.1900
Errore,100,0
Roma,41.9028,12.4964`;
  const resMixed = await postForm('/api/convert', {
    csvfile: { filename: 'mixed.csv', content: csvMixed },
  });
  assert(resMixed.status === 200, 'Mixed rows returns 200');
  assert(resMixed.body.success === true, 'Mixed rows: success: true');
  assert(resMixed.body.featureCount === 2, 'Mixed rows: 2 valid features');
  assert(resMixed.body.warnings.length === 1, 'Mixed rows: 1 warning');
  assert(
    resMixed.body.warnings[0].includes('Riga 3') || resMixed.body.warnings[0].includes('100'),
    'Mixed rows: warning mentions the problematic row'
  );

  // ─── Negative coordinates ─────────────────────────────────────────────────
  console.log('\n📋 Negative coordinates (southern/western hemisphere)');
  const csvNeg = `nome,lat,lon
BuenosAires,-34.6037,-58.3816`;
  const resNeg = await postForm('/api/convert', {
    csvfile: { filename: 'neg.csv', content: csvNeg },
  });
  assert(resNeg.status === 200, 'Negative coords returns 200');
  assert(resNeg.body.geojson.features[0].geometry.coordinates[0] === -58.3816, 'Negative lon preserved');
  assert(resNeg.body.geojson.features[0].geometry.coordinates[1] === -34.6037, 'Negative lat preserved');

  // ─── Numeric properties converted from strings ───────────────────────────
  console.log('\n📋 Numeric property conversion');
  const csvNum = `nome,lat,lon,popolazione
Milano,45.4642,9.1900,1350000`;
  const resNum = await postForm('/api/convert', {
    csvfile: { filename: 'num.csv', content: csvNum },
  });
  assert(resNum.status === 200, 'Numeric props returns 200');
  assert(
    typeof resNum.body.geojson.features[0].properties.popolazione === 'number',
    'Population is stored as number, not string'
  );

  // ─── Download endpoint ───────────────────────────────────────────────────
  console.log('\n📋 Download endpoint');
  const downloadBody = JSON.stringify({
    geojson: { type: 'FeatureCollection', features: [] },
    fileName: 'test.csv',
  });
  const dlRes = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4602,
        path: '/api/download',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(downloadBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(downloadBody);
    req.end();
  });
  assert(dlRes.status === 200, 'Download returns 200');
  assert(
    dlRes.headers['content-type'].includes('geo+json'),
    'Download Content-Type is application/geo+json'
  );

  // ─── Static files ─────────────────────────────────────────────────────────
  console.log('\n📋 Static file serving');
  const htmlRes = await getRequest('/');
  assert(htmlRes.status === 200, 'GET / returns 200');
  assert(htmlRes.body.includes('<!DOCTYPE html>'), 'Response is HTML');
  assert(htmlRes.body.includes('Convertitore CSV'), 'HTML contains page title');

  const robotsRes = await getRequest('/robots.txt');
  assert(robotsRes.status === 200, 'robots.txt returns 200');

  const sitemapRes = await getRequest('/sitemap.xml');
  assert(sitemapRes.status === 200, 'sitemap.xml returns 200');

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(`\n📊 RISULTATI: ${passed} passati, ${failed} falliti\n`);

  if (failures.length > 0) {
    console.log('Dettaglio fallimenti:');
    failures.forEach((f) => console.log(f));
    console.log('');
    process.exit(1);
  } else {
    console.log('✅ Tutti i test superati!\n');
    process.exit(0);
  }
}

// ─── Start server and run tests ───────────────────────────────────────────────
// We need to start the app on a test port
process.env.PORT = 4602;
app = require('./server');

// Give the server a moment to start
setTimeout(() => {
  runTests().catch((err) => {
    console.error('Test suite error:', err);
    process.exit(1);
  });
}, 500);

// Kill the server after tests
setTimeout(() => {
  process.exit(failed > 0 ? 1 : 0);
}, 10000);

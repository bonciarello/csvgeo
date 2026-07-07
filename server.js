const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4601;

// ─── Queue ────────────────────────────────────────────────────────────────────
const jobs = new Map(); // jobId -> { status, result, error, createdAt }
let processing = false;
const queue = [];

function enqueue(jobId) {
  queue.push(jobId);
  processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    try {
      job.status = 'processing';
      const result = convertCsvToGeoJSON(job.csvData, job.originalName);
      job.status = 'completed';
      job.result = result;
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
    }
  }

  processing = false;
}

// ─── Multer config ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.csv') {
      return cb(new Error('Solo file CSV sono accettati.'));
    }
    cb(null, true);
  },
});

// ─── CSV → GeoJSON conversion ─────────────────────────────────────────────────
const LAT_ALIASES = ['lat', 'latitude', 'latitudine'];
const LON_ALIASES = ['lon', 'lng', 'long', 'longitude', 'longitudine'];

/**
 * Detect which column is latitude and which is longitude.
 * Returns { latCol, lonCol } or throws if not found.
 */
function detectColumns(headers) {
  const lowerHeaders = headers.map(h => String(h).trim().toLowerCase());

  let latCol = null;
  let lonCol = null;

  for (let i = 0; i < lowerHeaders.length; i++) {
    if (LAT_ALIASES.includes(lowerHeaders[i])) latCol = i;
    if (LON_ALIASES.includes(lowerHeaders[i])) lonCol = i;
  }

  if (latCol === null && lonCol === null) {
    throw new Error(
      'Colonne lat/lon non trovate. Il CSV deve contenere una colonna per la latitudine (lat, latitude, latitudine) e una per la longitudine (lon, lng, long, longitude, longitudine).'
    );
  }
  if (latCol === null) {
    throw new Error(
      'Colonna latitudine non trovata. Usa uno di questi nomi: lat, latitude, latitudine.'
    );
  }
  if (lonCol === null) {
    throw new Error(
      'Colonna longitudine non trovata. Usa uno di questi nomi: lon, lng, long, longitude, longitudine.'
    );
  }

  return { latCol, lonCol, headers: headers.map(h => String(h).trim()) };
}

/**
 * Validate a single coordinate pair.
 * Returns null if valid, or an error message string.
 */
function validateCoordinate(lat, lon, rowIndex) {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);

  if (isNaN(latNum)) {
    return `Riga ${rowIndex}: la latitudine "${lat}" non è un numero valido.`;
  }
  if (isNaN(lonNum)) {
    return `Riga ${rowIndex}: la longitudine "${lon}" non è un numero valido.`;
  }
  if (latNum < -90 || latNum > 90) {
    return `Riga ${rowIndex}: latitudine ${latNum} fuori range. Deve essere compresa tra -90 e 90.`;
  }
  if (lonNum < -180 || lonNum > 180) {
    return `Riga ${rowIndex}: longitudine ${lonNum} fuori range. Deve essere compresa tra -180 e 180.`;
  }
  return null; // valid
}

/**
 * Convert parsed CSV records into a GeoJSON FeatureCollection.
 */
function convertCsvToGeoJSON(csvText, originalName) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  if (records.length === 0) {
    throw new Error('Il file CSV è vuoto o non contiene righe di dati.');
  }

  const rawHeaders = Object.keys(records[0]);
  if (rawHeaders.length === 0) {
    throw new Error('Il file CSV non contiene intestazioni di colonna.');
  }

  const { latCol, lonCol, headers } = detectColumns(rawHeaders);

  const errors = [];
  const features = [];

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const latVal = row[headers[latCol]];
    const lonVal = row[headers[lonCol]];

    const err = validateCoordinate(latVal, lonVal, i + 2); // +2: row 1 is header in spreadsheet terms, data starts at row 2
    if (err) {
      errors.push(err);
      continue;
    }

    const lat = parseFloat(latVal);
    const lon = parseFloat(lonVal);

    // Build properties from all non-coordinate columns
    const properties = {};
    for (let j = 0; j < headers.length; j++) {
      if (j !== latCol && j !== lonCol) {
        const val = row[headers[j]];
        // Try to convert to number if it looks like one
        if (val !== '' && val !== undefined && val !== null) {
          const num = Number(val);
          properties[headers[j]] = isNaN(num) ? val : num;
        } else {
          properties[headers[j]] = val || '';
        }
      }
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lon, lat], // GeoJSON: [longitude, latitude]
      },
      properties,
    });
  }

  if (errors.length > 0 && features.length === 0) {
    throw new Error(
      `Nessuna coordinata valida trovata. Errori rilevati:\n${errors.join('\n')}`
    );
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
  };

  if (errors.length > 0) {
    geojson._warnings = errors;
  }

  return geojson;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Upload and convert CSV
app.post('/api/convert', upload.single('csvfile'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Nessun file caricato. Seleziona un file CSV.',
      });
    }

    const csvText = req.file.buffer.toString('utf-8');
    const originalName = req.file.originalname;
    const jobId = uuidv4();

    // Process synchronously for immediate feedback
    try {
      const result = convertCsvToGeoJSON(csvText, originalName);
      const warnings = result._warnings || [];
      delete result._warnings;

      return res.json({
        success: true,
        jobId,
        fileName: originalName,
        featureCount: result.features.length,
        warnings,
        geojson: result,
      });
    } catch (convErr) {
      return res.status(422).json({
        success: false,
        jobId,
        fileName: originalName,
        error: convErr.message,
      });
    }
  } catch (err) {
    if (err.message === 'Solo file CSV sono accettati.') {
      return res.status(400).json({ success: false, error: err.message });
    }
    return res.status(500).json({
      success: false,
      error: 'Errore interno del server: ' + err.message,
    });
  }
});

// Download converted GeoJSON by job ID (stored in memory – simple approach)
// For the synchronous approach, the client already has the data, but we also
// provide a download endpoint that accepts the JSON via POST and returns it as file
app.post('/api/download', express.json({ limit: '10mb' }), (req, res) => {
  const { geojson, fileName } = req.body;
  if (!geojson) {
    return res.status(400).json({ success: false, error: 'Nessun dato GeoJSON fornito.' });
  }
  const baseName = fileName ? path.basename(fileName, '.csv') : 'output';
  const downloadName = `${baseName}.geojson`;
  res.setHeader('Content-Type', 'application/geo+json');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.json(geojson);
});

// Example CSV download
app.get('/api/example', (_req, res) => {
  const exampleCsv = `nome,lat,lon,descrizione
Milano,45.4642,9.1900,Duomo di Milano
Roma,41.9028,12.4964,Colosseo
Napoli,40.8518,14.2681,Vesuvio
`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="esempio.csv"');
  res.send(exampleCsv);
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🖥️  Convertitore CSV → GeoJSON in esecuzione su http://0.0.0.0:${PORT}`);
});

module.exports = app;

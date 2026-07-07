/* ─── DOM refs ──────────────────────────────────────────────────────────────── */
const form = document.getElementById('upload-form');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('csvfile');
const browseBtn = document.getElementById('browse-btn');
const fileSelected = document.getElementById('file-selected');
const fileNameSpan = document.getElementById('file-name');
const clearFileBtn = document.getElementById('clear-file');
const dropzoneContent = dropzone.querySelector('.dropzone-content');
const submitBtn = document.getElementById('submit-btn');
const statusSection = document.getElementById('status-section');
const statusLoading = document.getElementById('status-loading');
const resultsSection = document.getElementById('results-section');
const resultSuccess = document.getElementById('result-success');
const resultError = document.getElementById('result-error');
const successDetail = document.getElementById('success-detail');
const errorDetail = document.getElementById('error-detail');
const warningsBox = document.getElementById('warnings-box');
const warningsList = document.getElementById('warnings-list');
const geojsonOutput = document.getElementById('geojson-output');
const downloadBtn = document.getElementById('download-btn');
const copyBtn = document.getElementById('copy-geojson');
const newConversionBtn = document.getElementById('new-conversion-btn');
const loadExample = document.getElementById('load-example');
const uploadSection = document.getElementById('upload-section');

let currentResult = null;

/* ─── File selection ────────────────────────────────────────────────────────── */
function showFileSelected(file) {
  fileSelected.hidden = false;
  dropzoneContent.hidden = true;
  fileNameSpan.textContent = file.name;
}

function clearFileSelection() {
  fileInput.value = '';
  fileSelected.hidden = true;
  dropzoneContent.hidden = false;
  fileNameSpan.textContent = '';
}

browseBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    showFileSelected(fileInput.files[0]);
  } else {
    clearFileSelection();
  }
});

clearFileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearFileSelection();
});

/* ─── Drag & drop ───────────────────────────────────────────────────────────── */
dropzone.addEventListener('click', (e) => {
  if (e.target === clearFileBtn || e.target === browseBtn) return;
  fileInput.click();
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  });
});

dropzone.addEventListener('drop', (e) => {
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    if (!files[0].name.toLowerCase().endsWith('.csv')) {
      showError('Il file deve avere estensione .csv');
      return;
    }
    fileInput.files = files;
    showFileSelected(files[0]);
  }
});

/* ─── Form submit ───────────────────────────────────────────────────────────── */
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!fileInput.files || fileInput.files.length === 0) {
    showError('Seleziona un file CSV prima di procedere.');
    return;
  }

  const file = fileInput.files[0];
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showError('Solo file con estensione .csv sono accettati.');
    return;
  }

  // Show loading
  hideResults();
  statusSection.hidden = false;
  statusLoading.hidden = false;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Conversione in corso…';

  try {
    const formData = new FormData();
    formData.append('csvfile', file);

    const response = await fetch('api/convert', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    statusSection.hidden = true;

    if (data.success) {
      showSuccess(data);
    } else {
      showError(data.error || 'Errore sconosciuto durante la conversione.');
    }
  } catch (err) {
    statusSection.hidden = true;
    showError('Errore di rete: impossibile raggiungere il server. Riprova.');
    console.error(err);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> Converti in GeoJSON`;
  }
});

/* ─── Show success ──────────────────────────────────────────────────────────── */
function showSuccess(data) {
  currentResult = data;
  resultSuccess.hidden = false;
  resultError.hidden = true;
  resultsSection.hidden = false;
  uploadSection.style.opacity = '0.6';

  const plural = data.featureCount === 1 ? 'feature' : 'feature';
  successDetail.textContent = `${data.featureCount} ${plural} generate da "${data.fileName}".`;

  // Show warnings if any
  if (data.warnings && data.warnings.length > 0) {
    warningsBox.hidden = false;
    warningsList.innerHTML = data.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('');
  } else {
    warningsBox.hidden = true;
  }

  // Show GeoJSON preview (first 3 features if many)
  let preview = data.geojson;
  if (preview.features && preview.features.length > 5) {
    preview = {
      ...preview,
      features: [
        ...preview.features.slice(0, 3),
        { _omitted: `… ${preview.features.length - 3} feature omesse dall'anteprima …` },
      ],
    };
  }
  geojsonOutput.textContent = JSON.stringify(preview, null, 2);

  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─── Show error ────────────────────────────────────────────────────────────── */
function showError(msg) {
  resultError.hidden = false;
  resultSuccess.hidden = true;
  resultsSection.hidden = false;
  uploadSection.style.opacity = '0.6';

  errorDetail.textContent = msg;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─── Hide results ──────────────────────────────────────────────────────────── */
function hideResults() {
  resultsSection.hidden = true;
  resultSuccess.hidden = true;
  resultError.hidden = true;
  uploadSection.style.opacity = '1';
  currentResult = null;
}

/* ─── Download ──────────────────────────────────────────────────────────────── */
downloadBtn.addEventListener('click', async () => {
  if (!currentResult || !currentResult.geojson) return;

  try {
    const response = await fetch('api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        geojson: currentResult.geojson,
        fileName: currentResult.fileName,
      }),
    });

    if (!response.ok) throw new Error('Download failed');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentResult.fileName || 'output').replace(/\.csv$/i, '') + '.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    // Fallback: download directly from the stored JSON
    const json = JSON.stringify(currentResult.geojson, null, 2);
    const blob = new Blob([json], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentResult.fileName || 'output').replace(/\.csv$/i, '') + '.geojson';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
});

/* ─── Copy to clipboard ─────────────────────────────────────────────────────── */
copyBtn.addEventListener('click', async () => {
  if (!currentResult || !currentResult.geojson) return;

  const json = JSON.stringify(currentResult.geojson, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7l2.5 3L11 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copiato!`;
    setTimeout(() => { copyBtn.innerHTML = orig; }, 1800);
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const orig = copyBtn.innerHTML;
    copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7l2.5 3L11 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Copiato!`;
    setTimeout(() => { copyBtn.innerHTML = orig; }, 1800);
  }
});

/* ─── New conversion ────────────────────────────────────────────────────────── */
newConversionBtn.addEventListener('click', () => {
  clearFileSelection();
  hideResults();
  statusSection.hidden = true;
  uploadSection.style.opacity = '1';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

/* ─── Load example ──────────────────────────────────────────────────────────── */
loadExample.addEventListener('click', () => {
  window.location.href = 'api/example';
});

/* ─── Utility ────────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

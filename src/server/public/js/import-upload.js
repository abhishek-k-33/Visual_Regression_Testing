/**
 * "Import CI run" on the dashboard: pick the visual-regression-diffs .zip with the button
 * (the keyboard way) or drop it anywhere on the page, and it is uploaded to
 * POST /api/imports. On success the page opens the imported run (or lists them when
 * the artifact held several); errors go to the role="alert" region, never alert().
 *
 * Only loaded in live mode: the static (GitHub Pages) build has no server to import into.
 */
import { api, announce, base, mode } from './common.js';

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed'];
// Required by the server's CSRF check (see src/server/security.js)
const WRITE_HEADERS = { 'X-Requested-With': 'visual-ci-dashboard', 'Content-Type': 'application/zip' };

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return { success: false, error: `the server responded with HTTP ${res.status}` };
  }
}

function initImport() {
  const button = document.getElementById('import-run-btn');
  const input = document.getElementById('import-file');
  const control = button?.closest('.import-control');
  const statusRegion = document.querySelector('[data-import-status]');
  const errorRegion = document.querySelector('[data-import-error]');
  const overlay = document.querySelector('[data-drop-overlay]');
  if (mode === 'static' || !button || !input || !statusRegion || !errorRegion) return;

  const label = button.querySelector('.import-label');
  const idleLabel = label?.textContent || 'Import CI run';
  const maxBytes = Number(control?.dataset.maxUploadBytes) || 0;
  let uploading = false;

  const setStatus = (content) => {
    if (typeof content === 'string') statusRegion.textContent = content;
    else statusRegion.replaceChildren(...content);
  };

  function showError(message) {
    setStatus('');
    const p = document.createElement('p');
    p.textContent = message;
    errorRegion.replaceChildren(p); // a new node each time, so a repeat is announced again
  }

  function setBusy(busy) {
    uploading = busy;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    if (label) label.textContent = busy ? 'Importing…' : idleLabel;
  }

  function showRunLinks(runs) {
    const intro = document.createElement('p');
    intro.textContent = `Imported ${runs.length} runs:`;
    const list = document.createElement('ul');
    for (const run of runs) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `${base}${run.url}`;
      link.textContent = run.id;
      item.append(link);
      if (run.alreadyImported) item.append(' (already imported)');
      else if (run.renamedFrom) item.append(` (renamed from ${run.renamedFrom})`);
      list.append(item);
    }
    setStatus([intro, list]);
  }

  async function upload(file) {
    if (uploading) {
      announce('An import is already running.');
      return;
    }
    errorRegion.replaceChildren();
    if (!file) return;
    const isZip = /\.zip$/i.test(file.name) || ZIP_TYPES.includes(file.type);
    if (!isZip) {
      showError(`"${file.name}" is not a .zip file. Download the visual-regression-diffs artifact from the failed CI run and import that.`);
      return;
    }
    if (maxBytes && file.size > maxBytes) {
      showError(`"${file.name}" is ${formatBytes(file.size)}; uploads are limited to ${formatBytes(maxBytes)}. Use the command line instead: npx visual-ci import <file>.`);
      return;
    }

    setBusy(true);
    setStatus(`Importing ${file.name}…`);
    let navigating = false;
    try {
      const res = await fetch(api('/imports'), { method: 'POST', headers: WRITE_HEADERS, body: file });
      const data = await readJson(res);
      if (!data.success) {
        showError(`Import failed: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      if (data.runs.length === 1) {
        const [run] = data.runs;
        const done = run.alreadyImported ? `${run.id} was already imported` : `Imported ${run.id}`;
        setStatus(`${done}. Opening it…`); // the status region announces it (once)
        navigating = true;
        window.location.assign(`${base}${run.url}`);
      } else {
        showRunLinks(data.runs); // announced by the status region
      }
    } catch (err) {
      showError(`Import failed: network error (${err.message}).`);
    } finally {
      // While the next page loads the button stays disabled: no second upload.
      if (!navigating) setBusy(false);
    }
  }

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const [file] = input.files;
    input.value = ''; // picking the same file again still fires "change"
    upload(file);
  });

  // Drag and drop anywhere on the page. The counter copes with dragenter/dragleave
  // firing for every child element crossed.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let depth = 0;
  const showOverlay = (show) => {
    if (overlay) overlay.hidden = !show;
  };
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    showOverlay(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // allows the drop
    e.dataTransfer.dropEffect = uploading ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) showOverlay(false);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser navigate to the dropped file
    depth = 0;
    showOverlay(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 1) {
      showError('Drop one .zip file at a time.');
      return;
    }
    upload(files[0]);
  });
}

initImport();

import './style.css';
import { WorkerPool } from './pool';
import { buildZip, crc32, type Bytes, type ZipEntry } from './zip';
import type { FormatMode, JobResult, QualityPreset } from './worker';

type Item = {
  id: number;
  file: File;
  name: string;
  status: 'queue' | 'work' | 'done' | 'error';
  outName?: string;
  bytes?: Bytes; // absent when the original is kept — read lazily at download
  crc?: number;
  size?: number;
  untouched?: boolean;
  error?: string;
  row?: HTMLElement;
};

type Run = { active: number };

const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

const settings = {
  preset: 'balanced' as QualityPreset,
  format: 'webp' as FormatMode,
};

const items: Item[] = [];
let nextId = 0;
let pool: WorkerPool | null = null;
let currentRun: Run | null = null;
let zipUrl: string | null = null;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <button id="theme" class="theme-toggle" title="Тема" aria-label="Тема"></button>

  <main class="shell">
    <header class="hero">
      <h1>MakeMeSmall</h1>
      <p>Сжимает картинки прямо в браузере. Ничего не уходит на сервер.</p>
    </header>

    <section class="controls" aria-label="Настройки">
      <div class="control">
        <span class="control-label">Режим</span>
        <div class="segmented" data-setting="preset">
          <button data-value="max">Качество</button>
          <button data-value="balanced" class="active">Оптимально</button>
          <button data-value="small">Компактно</button>
        </div>
      </div>
      <div class="control">
        <span class="control-label">Формат</span>
        <div class="segmented" data-setting="format">
          <button data-value="webp" class="active">WebP</button>
          <button data-value="jpeg">JPEG</button>
          <button data-value="png">PNG</button>
          <button data-value="keep">Оригинал</button>
        </div>
      </div>
    </section>

    <section id="drop" class="drop" tabindex="0">
      <div class="drop-inner">
        <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true">
          <path d="M24 32V12m0 0-7 7m7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M8 30v4a6 6 0 0 0 6 6h20a6 6 0 0 0 6-6v-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <p class="drop-title">Перетащите папку или картинки</p>
        <p class="drop-hint">JPEG, PNG, WebP, AVIF, GIF · до сотен файлов за раз</p>
        <div class="drop-actions">
          <button id="pick-folder" class="btn primary">Выбрать папку</button>
          <button id="pick-files" class="btn">Выбрать файлы</button>
        </div>
      </div>
      <input id="input-folder" type="file" webkitdirectory multiple hidden />
      <input id="input-files" type="file" accept="image/*" multiple hidden />
    </section>

    <section id="summary" class="summary" hidden>
      <div class="summary-main">
        <div class="saving"><span id="saving-value">—</span></div>
        <div class="summary-meta">
          <span id="summary-sizes">—</span>
          <span id="summary-count" class="muted">—</span>
        </div>
      </div>
      <div class="progress"><div id="progress-bar"></div></div>
    </section>

    <section id="list" class="list"></section>

    <div id="bar" class="actionbar" hidden>
      <button id="clear" class="btn ghost">Очистить</button>
      <button id="download" class="btn primary large" disabled>Скачать ZIP</button>
    </div>

    <footer class="foot">Файлы обрабатываются локально · метаданные вырезаются</footer>
  </main>
`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = el<HTMLElement>('drop');
const list = el<HTMLElement>('list');
const summary = el<HTMLElement>('summary');
const bar = el<HTMLElement>('bar');
const downloadBtn = el<HTMLButtonElement>('download');
const inputFolder = el<HTMLInputElement>('input-folder');
const inputFiles = el<HTMLInputElement>('input-files');

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} МБ`;
}

/* ---------- theme ---------- */

type Theme = 'auto' | 'light' | 'dark';
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const THEME_ICON: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' };
const THEME_NAME: Record<Theme, string> = { auto: 'Как в системе', light: 'Светлая', dark: 'Тёмная' };
const themeBtn = el<HTMLButtonElement>('theme');

function applyTheme(theme: Theme): void {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = THEME_ICON[theme];
  themeBtn.title = `Тема: ${THEME_NAME[theme]}`;
  try {
    localStorage.setItem('mms-theme', theme);
  } catch {
    /* private mode — the choice just does not persist */
  }
}

let theme: Theme = 'auto';
try {
  const saved = localStorage.getItem('mms-theme') as Theme | null;
  if (saved && THEMES.includes(saved)) theme = saved;
} catch {
  /* ignore */
}
applyTheme(theme);
themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
});

/* ---------- input collection ---------- */

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_RE.test(file.name);
}

async function readDirectory(entry: FileSystemDirectoryEntry, prefix: string, files: File[]): Promise<void> {
  const reader = entry.createReader();
  for (;;) {
    const batch: FileSystemEntry[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await walkEntry(child, prefix, files);
  }
}

async function walkEntry(entry: FileSystemEntry, prefix: string, files: File[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    if (isImage(file)) {
      Object.defineProperty(file, 'relPath', { value: prefix + file.name });
      files.push(file);
    }
    return;
  }
  await readDirectory(entry as FileSystemDirectoryEntry, prefix + entry.name + '/', files);
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return Array.from(dt.files).filter(isImage);

  const files: File[] = [];
  for (const entry of entries) await walkEntry(entry, '', files);
  return files;
}

function pathOf(file: File): string {
  return (file as File & { relPath?: string }).relPath || file.webkitRelativePath || file.name;
}

/* ---------- processing ---------- */

function addFiles(files: File[]): void {
  const images = files.filter(isImage);
  if (!images.length) return;

  const batch: Item[] = images.map((file) => {
    const item: Item = { id: nextId++, file, name: pathOf(file), status: 'queue' };
    item.row = renderRow(item);
    list.append(item.row);
    items.push(item);
    return item;
  });

  summary.hidden = false;
  bar.hidden = false;
  drop.classList.add('compact');
  enqueue(batch, false);
}

// `fresh` cancels everything in flight first — that is what a settings change
// does. Without it each change piled another full batch onto the same queue.
function enqueue(batch: Item[], fresh: boolean): void {
  if (fresh || !pool || !currentRun) {
    pool?.dispose();
    pool = new WorkerPool();
    currentRun = { active: 0 };
  }
  const run = currentRun;
  run.active += batch.length;
  invalidateZip();

  for (const item of batch) {
    item.status = 'work';
    updateRow(item);
    pool
      .run({ id: item.id, file: item.file, name: item.name, preset: settings.preset, format: settings.format })
      .then((result) => {
        if (currentRun !== run) return; // stale batch, its results are dropped
        apply(item, result);
        run.active--;
        updateSummary();
      });
  }
  updateSummary();
}

function apply(item: Item, result: JobResult): void {
  if (result.ok) {
    item.status = 'done';
    item.untouched = result.untouched;
    item.outName = result.name;
    item.bytes = result.bytes ?? undefined;
    item.crc = result.crc ?? undefined;
    item.size = result.size;
    item.error = undefined;
  } else {
    item.status = 'error';
    item.error = result.error;
  }
  updateRow(item);
}

function reprocessAll(): void {
  if (!items.length) return;
  for (const item of items) {
    item.status = 'queue';
    item.bytes = undefined;
    item.crc = undefined;
    item.size = undefined;
    item.error = undefined;
    updateRow(item);
  }
  enqueue(items.slice(), true);
}

/* ---------- rendering ---------- */

function renderRow(item: Item): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-name" title="${item.name}">${item.name}</div>
    <div class="row-bar"><div class="row-fill"></div></div>
    <div class="row-stat"></div>
  `;
  return row;
}

function updateRow(item: Item): void {
  const row = item.row;
  if (!row) return;
  const fill = row.querySelector<HTMLElement>('.row-fill')!;
  const stat = row.querySelector<HTMLElement>('.row-stat')!;
  row.dataset.status = item.status;
  row.toggleAttribute('data-untouched', item.status === 'done' && !!item.untouched);

  if (item.status === 'done' && item.size !== undefined) {
    fill.style.width = `${Math.min(100, (item.size / item.file.size) * 100)}%`;
    const saved = Math.round((1 - item.size / item.file.size) * 100);
    stat.innerHTML = item.untouched
      ? `<span class="muted">уже оптимально</span> <b>${fmt(item.size)}</b>`
      : `<span class="muted">${fmt(item.file.size)} →</span> <b>${fmt(item.size)}</b> <span class="badge">−${saved}%</span>`;
  } else if (item.status === 'error') {
    fill.style.width = '0%';
    stat.innerHTML = `<span class="err">${item.error}</span>`;
  } else {
    fill.style.width = '0%';
    stat.innerHTML = `<span class="muted">${item.status === 'work' ? 'сжимаю…' : 'в очереди'}</span>`;
  }
}

function updateSummary(): void {
  const done = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'error').length;
  const before = done.reduce((sum, i) => sum + i.file.size, 0);
  const after = done.reduce((sum, i) => sum + (i.size || 0), 0);
  const busy = currentRun ? currentRun.active > 0 : false;

  el('saving-value').textContent = before ? `−${Math.round((1 - after / before) * 100)}%` : '…';
  el('summary-sizes').textContent = before ? `${fmt(before)} → ${fmt(after)}` : 'обработка';
  el('summary-count').textContent =
    `${done.length} из ${items.length}` + (failed ? ` · ${failed} с ошибкой` : '');
  el('progress-bar').style.width = `${items.length ? ((done.length + failed) / items.length) * 100 : 0}%`;

  downloadBtn.disabled = busy || !done.length;
  downloadBtn.textContent = busy ? 'Сжимаю…' : done.length === 1 ? 'Скачать файл' : 'Скачать ZIP';
}

/* ---------- output ---------- */

function invalidateZip(): void {
  if (zipUrl) {
    URL.revokeObjectURL(zipUrl);
    zipUrl = null;
  }
}

// Items whose original was kept carry no bytes until now, so the archive holds
// one copy of the data instead of two for the whole session.
async function materialize(item: Item): Promise<{ bytes: Bytes; crc: number }> {
  if (item.bytes && item.crc !== undefined) return { bytes: item.bytes, crc: item.crc };
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  return { bytes, crc: crc32(bytes) };
}

async function entriesOf(done: Item[]): Promise<ZipEntry[]> {
  const seen = new Map<string, number>();
  const entries: ZipEntry[] = [];
  for (const item of done) {
    const { bytes, crc } = await materialize(item);
    let name = item.outName || item.name;
    const count = seen.get(name.toLowerCase()) || 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count) name = name.replace(/(\.[^./\\]+)$/, ` (${count})$1`);
    entries.push({ name, bytes, crc });
  }
  return entries;
}

function save(blob: Blob, filename: string): void {
  invalidateZip();
  zipUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = zipUrl;
  link.download = filename;
  link.click();
}

downloadBtn.addEventListener('click', async () => {
  const done = items.filter((i) => i.status === 'done');
  if (!done.length) return;

  downloadBtn.disabled = true;
  const label = downloadBtn.textContent;
  downloadBtn.textContent = 'Собираю…';
  try {
    if (done.length === 1) {
      const { bytes } = await materialize(done[0]);
      save(new Blob([bytes]), (done[0].outName || done[0].name).split('/').pop()!);
    } else {
      save(buildZip(await entriesOf(done)), `makemesmall-${done.length}.zip`);
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Не удалось собрать архив');
  }
  downloadBtn.textContent = label;
  updateSummary();
});

el('clear').addEventListener('click', () => {
  pool?.dispose();
  pool = null;
  currentRun = null;
  items.length = 0;
  list.innerHTML = '';
  summary.hidden = true;
  bar.hidden = true;
  drop.classList.remove('compact');
  invalidateZip();
  inputFolder.value = '';
  inputFiles.value = '';
});

/* ---------- wiring ---------- */

document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
  group.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (!button || button.classList.contains('active')) return;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
    const value = button.dataset.value!;
    if (group.dataset.setting === 'preset') settings.preset = value as QualityPreset;
    else settings.format = value as FormatMode;
    reprocessAll();
  });
});

el<HTMLButtonElement>('pick-folder').addEventListener('click', () => inputFolder.click());
el<HTMLButtonElement>('pick-files').addEventListener('click', () => inputFiles.click());
inputFolder.addEventListener('change', () => addFiles(Array.from(inputFolder.files || [])));
inputFiles.addEventListener('change', () => addFiles(Array.from(inputFiles.files || [])));

['dragenter', 'dragover'].forEach((type) =>
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((type) =>
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === 'dragleave' && drop.contains((event as DragEvent).relatedTarget as Node)) return;
    drop.classList.remove('over');
  }),
);
drop.addEventListener('drop', async (event) => {
  const dt = (event as DragEvent).dataTransfer;
  if (dt) addFiles(await filesFromDrop(dt));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

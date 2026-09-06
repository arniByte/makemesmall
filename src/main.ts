import './style.css';
import { WorkerPool } from './pool';
import { buildZip, type Bytes, type ZipEntry } from './zip';
import type { FormatMode, JobResult, QualityPreset } from './worker';

type Item = {
  id: number;
  file: File;
  name: string;
  status: 'queue' | 'work' | 'done' | 'error';
  outName?: string;
  bytes?: Bytes;
  crc?: number;
  size?: number;
  quality?: number;
  untouched?: boolean;
  error?: string;
  row?: HTMLElement;
};

const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|avif)$/i;

const settings = {
  preset: 'balanced' as QualityPreset,
  format: 'webp' as FormatMode,
  maxDim: 0,
};

const items: Item[] = [];
let nextId = 0;
let running = 0;
let pool: WorkerPool | null = null;
let zipUrl: string | null = null;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main class="shell">
    <header class="hero">
      <h1>MakeMeSmall</h1>
      <p>Сжимает картинки прямо в браузере. Ничего не уходит на сервер.</p>
    </header>

    <section class="controls" aria-label="Настройки">
      <div class="control">
        <span class="control-label">Качество</span>
        <div class="segmented" data-setting="preset">
          <button data-value="max">Максимум</button>
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
      <div class="control">
        <span class="control-label">Разрешение</span>
        <div class="segmented" data-setting="maxDim">
          <button data-value="0" class="active">Оригинал</button>
          <button data-value="3840">4K</button>
          <button data-value="2560">2.5K</button>
          <button data-value="1920">1080p</button>
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

/* ---------- input collection ---------- */

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_RE.test(file.name);
}

async function readDirectory(entry: FileSystemDirectoryEntry, prefix: string, out: Promise<void>[], files: File[]): Promise<void> {
  const reader = entry.createReader();
  for (;;) {
    const batch: FileSystemEntry[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return;
    for (const child of batch) await walkEntry(child, prefix, out, files);
  }
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: Promise<void>[], files: File[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    if (isImage(file)) {
      Object.defineProperty(file, 'relPath', { value: prefix + file.name });
      files.push(file);
    }
    return;
  }
  await readDirectory(entry as FileSystemDirectoryEntry, prefix + entry.name + '/', out, files);
}

async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return Array.from(dt.files).filter(isImage);

  const files: File[] = [];
  for (const entry of entries) await walkEntry(entry, '', [], files);
  return files;
}

function pathOf(file: File): string {
  return (file as File & { relPath?: string }).relPath || file.webkitRelativePath || file.name;
}

/* ---------- processing ---------- */

function addFiles(files: File[]): void {
  const images = files.filter(isImage);
  if (!images.length) return;

  for (const file of images) {
    const item: Item = { id: nextId++, file, name: pathOf(file), status: 'queue' };
    items.push(item);
    item.row = renderRow(item);
    list.append(item.row);
  }
  summary.hidden = false;
  bar.hidden = false;
  drop.classList.add('compact');
  process(images.map((_, i) => items[items.length - images.length + i]));
}

function process(batch: Item[]): void {
  pool ??= new WorkerPool();
  invalidateZip();

  for (const item of batch) {
    running++;
    item.status = 'work';
    updateRow(item);
    pool
      .run({
        id: item.id,
        file: item.file,
        name: item.name,
        preset: settings.preset,
        format: settings.format,
        maxDim: settings.maxDim,
      })
      .then((result) => apply(item, result))
      .finally(() => {
        running--;
        updateSummary();
      });
  }
  updateSummary();
}

function apply(item: Item, result: JobResult): void {
  if (result.ok) {
    item.status = 'done';
    item.outName = result.name;
    item.bytes = result.bytes;
    item.crc = result.crc;
    item.size = result.size;
    item.quality = result.quality;
    item.untouched = result.untouched;
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
    item.size = undefined;
    item.error = undefined;
    updateRow(item);
  }
  process(items.slice());
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

  if (item.status === 'done' && item.size !== undefined) {
    const ratio = item.size / item.file.size;
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    const saved = Math.round((1 - ratio) * 100);
    const badge = saved >= 0 ? `<span class="badge">−${saved}%</span>` : `<span class="badge grew">+${-saved}%</span>`;
    stat.innerHTML = item.untouched
      ? `<span class="muted">уже оптимально</span> <b>${fmt(item.size)}</b>`
      : `<span class="muted">${fmt(item.file.size)} →</span> <b>${fmt(item.size)}</b> ${badge}`;
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
  const saving = before ? Math.round((1 - after / before) * 100) : 0;

  el('saving-value').textContent = before ? `${saving >= 0 ? '−' : '+'}${Math.abs(saving)}%` : '…';
  el('summary-sizes').textContent = before ? `${fmt(before)} → ${fmt(after)}` : 'обработка';
  el('summary-count').textContent =
    `${done.length} из ${items.length}` + (failed ? ` · ${failed} с ошибкой` : '');
  el('progress-bar').style.width = `${items.length ? ((done.length + failed) / items.length) * 100 : 0}%`;

  downloadBtn.disabled = running > 0 || !done.length;
  downloadBtn.textContent = running > 0 ? 'Сжимаю…' : done.length === 1 ? 'Скачать файл' : 'Скачать ZIP';
}

/* ---------- output ---------- */

function invalidateZip(): void {
  if (zipUrl) {
    URL.revokeObjectURL(zipUrl);
    zipUrl = null;
  }
}

function uniqueNames(entries: Item[]): ZipEntry[] {
  const seen = new Map<string, number>();
  return entries.map((item) => {
    let name = item.outName!;
    const count = seen.get(name.toLowerCase()) || 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count) name = name.replace(/(\.[^./\\]+)$/, ` (${count})$1`);
    return { name, bytes: item.bytes!, crc: item.crc! };
  });
}

function save(blob: Blob, filename: string): void {
  invalidateZip();
  zipUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = zipUrl;
  link.download = filename;
  link.click();
}

downloadBtn.addEventListener('click', () => {
  const done = items.filter((i) => i.status === 'done' && i.bytes);
  if (!done.length) return;

  if (done.length === 1) {
    const only = done[0];
    save(new Blob([only.bytes!]), only.outName!.split('/').pop()!);
    return;
  }
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Собираю ZIP…';
  setTimeout(() => {
    try {
      save(buildZip(uniqueNames(done)), `makemesmall-${done.length}.zip`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Не удалось собрать архив');
    }
    updateSummary();
  }, 16);
});

el('clear').addEventListener('click', () => {
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
    if (!button) return;
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
    const key = group.dataset.setting!;
    const value = button.dataset.value!;
    if (key === 'maxDim') settings.maxDim = Number(value);
    else if (key === 'preset') settings.preset = value as QualityPreset;
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

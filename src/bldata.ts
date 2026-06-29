// Real radio astronomy data fetcher
// Format: .fil (SIGPROC filterbank) — https://sigproc.sourceforge.net/
//
// Source : API publique Breakthrough Listen (UC Berkeley)
//   → https://seti.berkeley.edu/opendata/api (HTTPS)
//   → Fichiers GCS uniquement (storage.googleapis.com — HTTPS, range requests OK)
//   → 0 auth requise
//
// Données réelles GBT analysées pour signaux narrowband uniquement (turboSETI)
// Notre algo SNR cherche signaux LARGE-BANDE — non couverts par BL pipeline

import { v4 as uuidv4 } from 'uuid';

const BL_API_BASE = 'https://seti.berkeley.edu/opendata/api';
const CHUNK_SAMPLES = 1024;
const HEADER_FETCH_BYTES = 8192;
const FETCH_TIMEOUT_MS = 20000;

// Cibles SETI avec données GBT
const SETI_TARGETS = [
  'TRAPPIST1', 'PROXCEN', 'ALPHACEN', 'TAUCETI', 'EPSILON_ERI',
  'KEPLER452B', 'GJ667C', 'HIP99427', 'HIP45293', 'HIP88972',
  'HIP17092', 'HIP66765', 'GJ832', 'GJ876', 'GJ1214',
  'BARNARDS_STAR', 'WOLF359', 'HIP22627', 'HIP75181', 'HD40307G',
];

// URLs GCS confirmées — HTTPS, range requests 206 OK, données GBT réelles
// Ces fichiers sont des vraies observations analysées pour narrowband seulement
const GCS_STATIC_POOL: Array<{ url: string; target: string; telescope: string; utc: string; center_freq: number }> = [
  {
    url: 'https://storage.googleapis.com/gbt_fil/voyager_f1032192_t300_v2.fil',
    target: 'Voyager1',
    telescope: 'GBT',
    utc: 'Wed, 18 Dec 2013 00:00:00 GMT',
    center_freq: 8420,
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface BLFileEntry {
  target: string;
  telescope: string;
  utc: string;
  center_freq: number;
  url: string;
  size?: number;
}

interface FilterbankHeader {
  nchans: number;
  nbits: number;
  fch1: number;
  foff: number;
  tsamp: number;
  headerSize: number;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const fileCache = new Map<string, { files: BLFileEntry[]; ts: number }>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const headerCache = new Map<string, FilterbankHeader>();

// ─── Query API BL — filtre GCS uniquement ────────────────────────────────────

async function queryFilesForTarget(target: string): Promise<BLFileEntry[]> {
  const cached = fileCache.get(target);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.files;

  const params = new URLSearchParams({ target, 'file-types': 'filterbank', limit: '30' });
  const url = `${BL_API_BASE}/query-files?${params}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return [];

    const json = await res.json() as { result: string; data?: BLFileEntry[] };
    if (json.result !== 'success' || !json.data?.length) return [];

    // On garde UNIQUEMENT les URLs GCS (HTTPS, fiables depuis Railway)
    const files = json.data.filter(f =>
      f.url &&
      f.url.startsWith('https://storage.googleapis.com') &&
      (!f.size || f.size < 200 * 1024 * 1024)
    );

    console.log(`[BL] ${target}: ${json.data.length} fichiers total, ${files.length} sur GCS`);

    if (files.length > 0) fileCache.set(target, { files, ts: Date.now() });
    return files;
  } catch (err) {
    console.warn(`[BL] API query ${target} échouée:`, String(err));
    return [];
  }
}

// ─── Parser header filterbank (SIGPROC) ──────────────────────────────────────

function parseFilterbankHeader(buf: Buffer): FilterbankHeader | null {
  const HEADER_START = 'HEADER_START';
  const HEADER_END = 'HEADER_END';

  const startIdx = buf.indexOf(HEADER_START);
  if (startIdx === -1) return null;
  const endIdx = buf.indexOf(HEADER_END);
  if (endIdx === -1) return null;

  const headerSize = endIdx + HEADER_END.length;
  const header: Partial<FilterbankHeader> = { headerSize };

  const intKeys = ['nchans', 'nbits', 'nifs', 'machine_id', 'telescope_id', 'data_type'];
  const dblKeys = ['fch1', 'foff', 'tsamp', 'tstart', 'refdm', 'az_start', 'za_start', 'src_raj', 'src_dej'];
  const strKeys = ['source_name', 'rawdatafile'];

  let pos = startIdx + HEADER_START.length;

  while (pos < endIdx - 4) {
    if (pos + 4 > buf.length) break;
    const keyLen = buf.readInt32LE(pos); pos += 4;
    if (keyLen <= 0 || keyLen > 80 || pos + keyLen > buf.length) break;
    const key = buf.subarray(pos, pos + keyLen).toString('ascii'); pos += keyLen;
    if (key === HEADER_END) break;

    if (intKeys.includes(key)) {
      if (pos + 4 > buf.length) break;
      const val = buf.readInt32LE(pos); pos += 4;
      if (key === 'nchans') header.nchans = val;
      if (key === 'nbits') header.nbits = val;
    } else if (dblKeys.includes(key)) {
      if (pos + 8 > buf.length) break;
      const val = buf.readDoubleBE(pos); pos += 8;
      if (key === 'fch1') header.fch1 = val;
      if (key === 'foff') header.foff = val;
      if (key === 'tsamp') header.tsamp = val;
    } else if (strKeys.includes(key)) {
      if (pos + 4 > buf.length) break;
      const strLen = buf.readInt32LE(pos); pos += 4;
      if (strLen > 0 && strLen < 256) pos += strLen;
    }
  }

  if (!header.nchans || !header.nbits || !header.fch1) return null;
  return header as FilterbankHeader;
}

// ─── Fetch d'un chunk depuis un fichier .fil ──────────────────────────────────

async function tryFetchFromEntry(entry: BLFileEntry): Promise<{
  data: number[];
  frequencyHz: number;
  source: 'breakthrough_listen';
  target: string;
  telescope: string;
  observationUtc: string;
  chunkId: string;
} | null> {
  const { url, target, telescope, utc } = entry;
  if (!url) return null;

  try {
    let header = headerCache.get(url);

    if (!header) {
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${HEADER_FETCH_BYTES - 1}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status !== 206 && !res.ok) return null;

      const buf = Buffer.from(await res.arrayBuffer());
      header = parseFilterbankHeader(buf) ?? undefined;
      if (!header) { console.warn(`[BL] Header non parseable: ${target}`); return null; }

      headerCache.set(url, header);
      console.log(`[BL] ✓ Header ${target} — ${header.nchans}ch ${header.nbits}bits ${header.fch1.toFixed(1)}MHz`);
    }

    const bytesPerSample = Math.ceil((header.nbits * (header.nchans || 1)) / 8);
    const chunkBytes = CHUNK_SAMPLES * bytesPerSample;
    const maxDataOffset = 2 * 1024 * 1024;

    const dataOffset = header.headerSize + Math.floor(Math.random() * maxDataOffset);
    const rangeEnd = dataOffset + chunkBytes - 1;

    const dataRes = await fetch(url, {
      headers: { Range: `bytes=${dataOffset}-${rangeEnd}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (dataRes.status !== 206 && !dataRes.ok) return null;

    const dataBuf = Buffer.from(await dataRes.arrayBuffer());
    const samples: number[] = [];

    if (header.nbits === 8) {
      for (let i = 0; i < Math.min(CHUNK_SAMPLES, dataBuf.length); i++)
        samples.push((dataBuf[i]! - 128) / 128);
    } else if (header.nbits === 32) {
      const n = Math.min(CHUNK_SAMPLES, Math.floor(dataBuf.length / 4));
      for (let i = 0; i < n; i++) {
        const val = dataBuf.readFloatLE(i * 4);
        samples.push(isFinite(val) ? Math.max(-1, Math.min(1, val / 100)) : 0);
      }
    } else if (header.nbits === 2) {
      for (let i = 0; i < Math.min(CHUNK_SAMPLES / 4, dataBuf.length); i++) {
        const byte = dataBuf[i]!;
        samples.push(((byte & 0x03) - 1.5) / 1.5);
        samples.push((((byte >> 2) & 0x03) - 1.5) / 1.5);
        samples.push((((byte >> 4) & 0x03) - 1.5) / 1.5);
        samples.push((((byte >> 6) & 0x03) - 1.5) / 1.5);
      }
    }

    if (samples.length < 100) return null;
    while (samples.length < CHUNK_SAMPLES) samples.push(0);

    const frequencyHz = header.fch1 && Math.abs(header.fch1) > 1
      ? Math.abs(header.fch1) * 1_000_000
      : entry.center_freq * 1_000_000;

    return {
      data: samples.slice(0, CHUNK_SAMPLES),
      frequencyHz,
      source: 'breakthrough_listen',
      target: target.replace(/^DIAG_/, ''),
      telescope,
      observationUtc: utc,
      chunkId: uuidv4(),
    };
  } catch (err) {
    console.warn(`[BL] Erreur fetch ${target}:`, String(err));
    return null;
  }
}

// ─── Export principal ─────────────────────────────────────────────────────────

export async function fetchBLChunk(): Promise<{
  data: number[];
  frequencyHz: number;
  source: 'breakthrough_listen';
  target: string;
  telescope: string;
  observationUtc: string;
  chunkId: string;
} | null> {
  const customUrl = process.env.BREAKTHROUGH_LISTEN_URL;
  if (customUrl) {
    const result = await tryFetchFromEntry({
      url: customUrl, target: 'Custom_BL', telescope: 'GBT',
      utc: new Date().toISOString(), center_freq: 1420,
    });
    if (result) return result;
  }

  console.log('[BL] fetchBLChunk() appelé');

  // 1. Essai API BL (HTTPS) — récupère fichiers GCS uniquement
  const shuffledTargets = [...SETI_TARGETS].sort(() => Math.random() - 0.5);
  for (const target of shuffledTargets.slice(0, 3)) {
    const files = await queryFilesForTarget(target);
    if (!files.length) continue;
    const entry = files[Math.floor(Math.random() * files.length)]!;
    const result = await tryFetchFromEntry(entry);
    if (result) return result;
  }

  // 2. Fallback : pool statique GCS confirmé (HTTPS, Railway-compatible)
  console.log('[BL] Passage au fallback GCS statique...');
  const pool = [...GCS_STATIC_POOL].sort(() => Math.random() - 0.5);
  for (const entry of pool) {
    console.log('[BL] Tentative GCS:', entry.url.split('/').pop());
    const result = await tryFetchFromEntry(entry);
    if (result) { console.log('[BL] ✓ GCS fallback OK'); return result; }
  }

  console.log('[BL] Tous les fetch ont échoué → simulation');
  return null;
}

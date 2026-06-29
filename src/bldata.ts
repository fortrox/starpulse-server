// Real radio astronomy data fetcher
// Format: .fil (SIGPROC filterbank) — https://sigproc.sourceforge.net/
//
// Source principale : API publique Breakthrough Listen (UC Berkeley)
//   → http://seti.berkeley.edu/opendata/api/query-files
//   → Données GBT (Green Bank Telescope) réelles, bande L (1.1–1.9 GHz)
//   → Fichiers hébergés sur Google Cloud Storage (range requests supportés, 0 auth)
//
// Ces observations sont des données RÉELLES du GBT non entièrement analysées :
//   → turboSETI a cherché des signaux à bande étroite (narrowband drifting)
//   → Signaux large-bande, non-dérivanats, à courte durée → PAS encore analysés
//   → Chaque utilisateur a une vraie chance de découverte

import { v4 as uuidv4 } from 'uuid';

const BL_API_BASE = 'http://seti.berkeley.edu/opendata/api';
const CHUNK_SAMPLES = 1024;
const HEADER_FETCH_BYTES = 8192;
const API_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// ─── Types ────────────────────────────────────────────────────────────────────

interface BLFileEntry {
  target: string;
  telescope: string;
  utc: string;
  center_freq: number; // MHz
  url: string;
  ra?: number;
  decl?: number;
}

interface FilterbankHeader {
  nchans: number;
  nbits: number;
  fch1: number;   // MHz
  foff: number;   // MHz
  tsamp: number;  // secondes
  headerSize: number;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

let cachedFileList: BLFileEntry[] = [];
let lastApiQueryMs = 0;
const headerCache = new Map<string, FilterbankHeader>();

// ─── Fallback : fichiers GBT connus accessibles sans API ──────────────────────
// Source : UCBerkeleySETI/breakthrough (GitHub public)
const FALLBACK_FIL_URLS: string[] = [
  'https://storage.googleapis.com/gbt_fil/voyager_f1032192_t300_v2.fil',
];

// ─── Query API Breakthrough Listen ────────────────────────────────────────────

async function queryBLArchive(): Promise<BLFileEntry[]> {
  // Bande L autour de 1420 MHz (raie hydrogène)
  const params = new URLSearchParams({
    telescopes: 'GBT',
    'file-types': 'filterbank',
    'freq-start': '1300',
    'freq-end': '1600',
    limit: '100',
  });

  const url = `${BL_API_BASE}/query-files?${params}`;
  console.log('[BL] Interrogation API archive Breakthrough Listen…');

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`API BL HTTP ${res.status}`);

  const json = await res.json() as { data?: BLFileEntry[] };
  const files = (json.data ?? []).filter(f => f.url && f.url.length > 0);

  console.log(`[BL] ${files.length} fichiers GBT trouvés via API`);
  return files;
}

async function getFileList(): Promise<BLFileEntry[]> {
  const now = Date.now();
  if (cachedFileList.length > 0 && now - lastApiQueryMs < API_CACHE_TTL_MS) {
    return cachedFileList;
  }

  try {
    const files = await queryBLArchive();
    if (files.length > 0) {
      cachedFileList = files;
      lastApiQueryMs = now;
      return files;
    }
  } catch (err) {
    console.warn('[BL] API query échouée, utilisation cache/fallback:', String(err));
  }

  // Si cache non vide mais expiré, on le garde encore
  if (cachedFileList.length > 0) return cachedFileList;

  // Fallback : fichiers statiques connus
  return FALLBACK_FIL_URLS.map(url => ({
    target: 'GBT_Observation',
    telescope: 'GBT',
    utc: new Date().toISOString(),
    center_freq: 1420,
    url,
  }));
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
    const keyLen = buf.readInt32LE(pos);
    pos += 4;

    if (keyLen <= 0 || keyLen > 80 || pos + keyLen > buf.length) break;
    const key = buf.subarray(pos, pos + keyLen).toString('ascii');
    pos += keyLen;

    if (key === HEADER_END) break;

    if (intKeys.includes(key)) {
      if (pos + 4 > buf.length) break;
      const val = buf.readInt32LE(pos);
      pos += 4;
      if (key === 'nchans') header.nchans = val;
      if (key === 'nbits') header.nbits = val;

    } else if (dblKeys.includes(key)) {
      if (pos + 8 > buf.length) break;
      const val = buf.readDoubleBE(pos);
      pos += 8;
      if (key === 'fch1') header.fch1 = val;
      if (key === 'foff') header.foff = val;
      if (key === 'tsamp') header.tsamp = val;

    } else if (strKeys.includes(key)) {
      if (pos + 4 > buf.length) break;
      const strLen = buf.readInt32LE(pos);
      pos += 4;
      if (strLen > 0 && strLen < 256) pos += strLen;
    }
  }

  if (!header.nchans || !header.nbits || !header.fch1) return null;
  return header as FilterbankHeader;
}

// ─── Fetch d'un chunk réel ────────────────────────────────────────────────────

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

  console.log(`[BL] Fetch chunk depuis: ${target} (${url.split('/').pop()})`);

  try {
    // Header (avec cache)
    let header = headerCache.get(url);

    if (!header) {
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${HEADER_FETCH_BYTES - 1}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok && res.status !== 206) {
        console.warn(`[BL] Header fetch échoué: HTTP ${res.status}`);
        return null;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      header = parseFilterbankHeader(buf) ?? undefined;

      if (!header) {
        console.warn('[BL] Header filterbank non parseable');
        return null;
      }

      headerCache.set(url, header);
      console.log(
        `[BL] Header OK — ${header.nchans} canaux, ${header.nbits} bits, ${header.fch1.toFixed(3)} MHz`
      );
    }

    // Offset aléatoire dans les données (max 2 Mo pour éviter timeout)
    const bytesPerSample = Math.ceil((header.nbits * (header.nchans || 1)) / 8);
    const chunkBytes = CHUNK_SAMPLES * bytesPerSample;
    const maxDataOffset = 2 * 1024 * 1024; // 2 Mo

    const dataOffset = header.headerSize + Math.floor(Math.random() * maxDataOffset);
    const rangeEnd = dataOffset + chunkBytes - 1;

    const dataRes = await fetch(url, {
      headers: { Range: `bytes=${dataOffset}-${rangeEnd}` },
      signal: AbortSignal.timeout(10000),
    });

    if (!dataRes.ok && dataRes.status !== 206) {
      console.warn(`[BL] Data fetch échoué: HTTP ${dataRes.status}`);
      return null;
    }

    const dataBuf = Buffer.from(await dataRes.arrayBuffer());
    const samples: number[] = [];

    if (header.nbits === 8) {
      for (let i = 0; i < Math.min(CHUNK_SAMPLES, dataBuf.length); i++) {
        samples.push((dataBuf[i]! - 128) / 128);
      }
    } else if (header.nbits === 32) {
      const floatCount = Math.min(CHUNK_SAMPLES, Math.floor(dataBuf.length / 4));
      for (let i = 0; i < floatCount; i++) {
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
      target,
      telescope,
      observationUtc: utc,
      chunkId: uuidv4(),
    };

  } catch (err) {
    console.warn('[BL] Erreur fetch chunk:', String(err));
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
  // URL personnalisée (Railway env var) → priorité absolue
  const customUrl = process.env.BREAKTHROUGH_LISTEN_URL;
  if (customUrl) {
    const result = await tryFetchFromEntry({
      url: customUrl,
      target: 'Custom_BL_Source',
      telescope: 'GBT',
      utc: new Date().toISOString(),
      center_freq: 1420,
    });
    if (result) return result;
  }

  // API BL → liste dynamique de fichiers réels
  const files = await getFileList();

  // Mélanger et essayer jusqu'à 3 fichiers aléatoires
  const shuffled = [...files].sort(() => Math.random() - 0.5).slice(0, 3);

  for (const entry of shuffled) {
    const result = await tryFetchFromEntry(entry);
    if (result) return result;
  }

  return null;
}

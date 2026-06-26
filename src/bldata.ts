// Real radio astronomy data fetcher
// Format: .fil (SIGPROC filterbank) — https://sigproc.sourceforge.net/
//
// Sources par défaut : données publiques du télescope Parkes (Australie)
// Source personnalisée : variable BREAKTHROUGH_LISTEN_URL dans Railway

const CHUNK_SAMPLES = 1024;
const HEADER_FETCH_BYTES = 8192;

// Fichiers .fil publics — données réelles de radiotélescopes
const PUBLIC_FIL_URLS = [
  'https://raw.githubusercontent.com/FRBs/sigpyproc3/main/tests/data/tutorial.fil',
  'https://raw.githubusercontent.com/FRBs/sigpyproc3/main/tests/data/parkes_8bit_1.fil',
  'https://raw.githubusercontent.com/FRBs/sigpyproc3/main/tests/data/parkes_8bit_2.fil',
  'https://raw.githubusercontent.com/thepetabyteproject/your/main/tests/data/28.fil',
];

interface FilterbankHeader {
  nchans: number;
  nbits: number;
  fch1: number;   // MHz — fréquence du premier canal
  foff: number;   // MHz — largeur de canal (négatif = fréquence décroissante)
  tsamp: number;  // secondes — temps d'échantillonnage
  headerSize: number;
}

// Cache des headers pour éviter de re-télécharger à chaque chunk
const headerCache = new Map<string, FilterbankHeader>();

// ─── Parser de header filterbank ─────────────────────────────────────────────

function parseFilterbankHeader(buf: Buffer): FilterbankHeader | null {
  const HEADER_START = 'HEADER_START';
  const HEADER_END = 'HEADER_END';

  const startIdx = buf.indexOf(HEADER_START);
  if (startIdx === -1) return null;

  const endIdx = buf.indexOf(HEADER_END);
  if (endIdx === -1) return null;

  const headerSize = endIdx + HEADER_END.length;
  const header: Partial<FilterbankHeader> = { headerSize };

  // Mots-clés numériques entiers
  const intKeys = ['nchans', 'nbits', 'nifs', 'machine_id', 'telescope_id', 'data_type'];
  // Mots-clés numériques doubles
  const dblKeys = ['fch1', 'foff', 'tsamp', 'tstart', 'refdm', 'az_start', 'za_start', 'src_raj', 'src_dej'];
  // Mots-clés chaînes
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

export async function fetchBLChunk(): Promise<{
  data: number[];
  frequencyHz: number;
  source: 'breakthrough_listen';
} | null> {
  // Priorité : URL personnalisée BL, sinon données publiques Parkes
  const customUrl = process.env.BREAKTHROUGH_LISTEN_URL;
  const candidates = customUrl ? [customUrl] : PUBLIC_FIL_URLS;
  const url = candidates[Math.floor(Math.random() * candidates.length)];

  if (!url) return null;

  try {
    // Récupérer (ou utiliser le cache) du header
    let header = headerCache.get(url);

    if (!header) {
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${HEADER_FETCH_BYTES - 1}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok && res.status !== 206) return null;

      const buf = Buffer.from(await res.arrayBuffer());
      header = parseFilterbankHeader(buf) ?? undefined;

      if (!header) {
        console.warn('[BL] Impossible de parser le header filterbank');
        return null;
      }

      headerCache.set(url, header);
      console.log(`[BL] Header parsé — ${header.nchans} canaux, ${header.nbits} bits, ${header.fch1.toFixed(3)} MHz`);
    }

    // Calculer l'offset aléatoire dans les données
    const bytesPerSample = Math.ceil(header.nbits / 8) * (header.nchans || 1);
    const chunkBytes = CHUNK_SAMPLES * bytesPerSample;
    const maxDataOffset = 50 * 1024 * 1024; // Échantillonner dans les 50 premiers Mo

    const dataOffset = header.headerSize + Math.floor(Math.random() * maxDataOffset);
    const rangeEnd = dataOffset + chunkBytes - 1;

    const dataRes = await fetch(url, {
      headers: { Range: `bytes=${dataOffset}-${rangeEnd}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!dataRes.ok && dataRes.status !== 206) return null;

    const dataBuf = Buffer.from(await dataRes.arrayBuffer());

    // Convertir en tableau float normalisé [-1, 1]
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

    // Compléter si trop court
    while (samples.length < CHUNK_SAMPLES) samples.push(0);

    const frequencyHz = Math.abs(header.fch1) * 1_000_000;

    return { data: samples.slice(0, CHUNK_SAMPLES), frequencyHz, source: 'breakthrough_listen' };

  } catch (err) {
    console.warn('[BL] Erreur fetch:', String(err));
    return null;
  }
}

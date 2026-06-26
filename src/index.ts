import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contributors (
      user_id       TEXT PRIMARY KEY,
      points        DOUBLE PRECISION DEFAULT 0,
      tokens        DOUBLE PRECISION DEFAULT 0,
      anomalies     INTEGER DEFAULT 0,
      compute_minutes DOUBLE PRECISION DEFAULT 0,
      streak        INTEGER DEFAULT 0,
      last_seen     BIGINT DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS results (
      id              SERIAL PRIMARY KEY,
      chunk_id        TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      anomaly_detected BOOLEAN DEFAULT FALSE,
      confidence      DOUBLE PRECISION DEFAULT 0,
      snr_db          DOUBLE PRECISION DEFAULT 0,
      duration        DOUBLE PRECISION DEFAULT 0,
      timestamp       BIGINT NOT NULL
    )
  `);

  console.log('✓ Database ready');
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function generateChunk() {
  const size = 1024;
  const data: number[] = [];

  for (let i = 0; i < size; i++) {
    data.push((Math.random() - 0.5) * 2);
  }

  if (Math.random() < 0.005) {
    const pos = Math.floor(Math.random() * size);
    const width = Math.floor(Math.random() * 20) + 5;
    for (let i = pos; i < Math.min(pos + width, size); i++) {
      data[i] += Math.sin(i * 0.5) * 8;
    }
  }

  return {
    id: uuidv4(),
    frequencyHz: 1420000000 + Math.floor(Math.random() * 1000000),
    data,
    createdAt: Date.now(),
  };
}

function calculateRewards(minutes: number, anomalies: number, streak: number) {
  const base = Math.floor(minutes * 10);
  const bonus = anomalies * 500;
  const multiplier = 1 + streak * 0.1;
  const points = Math.floor((base + bonus) * multiplier);
  const tokens = parseFloat((points / 10000).toFixed(4));
  return { points, tokens };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /health
app.get('/health', async (_req, res) => {
  try {
    const [c, r, a] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM contributors'),
      pool.query('SELECT COUNT(*) FROM results'),
      pool.query('SELECT COUNT(*) FROM results WHERE anomaly_detected = TRUE'),
    ]);
    res.json({
      status: 'ok',
      version: '2.0.0',
      contributors: parseInt(c.rows[0].count),
      resultsProcessed: parseInt(r.rows[0].count),
      anomaliesFound: parseInt(a.rows[0].count),
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// GET /chunk
app.get('/chunk', (_req, res) => {
  res.json(generateChunk());
});

// POST /result
app.post('/result', async (req, res) => {
  const body = req.body;

  if (!body.chunkId || !body.userId) {
    return res.status(400).json({ error: 'chunkId and userId required' });
  }

  const anomalyDetected = body.anomalyDetected ?? false;
  const confidence = body.confidence ?? 0;
  const snrDb = body.snrDb ?? 0;
  const duration = body.duration ?? 0;
  const timestamp = Date.now();

  try {
    await pool.query(
      `INSERT INTO results (chunk_id, user_id, anomaly_detected, confidence, snr_db, duration, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [body.chunkId, body.userId, anomalyDetected, confidence, snrDb, duration, timestamp]
    );

    // Récupérer le streak actuel
    const existing = await pool.query(
      'SELECT streak FROM contributors WHERE user_id = $1',
      [body.userId]
    );
    const streak = existing.rows[0]?.streak ?? 0;
    const minutes = Math.ceil(duration / 60);
    const { points, tokens } = calculateRewards(minutes, anomalyDetected ? 1 : 0, streak);

    // Upsert contributeur
    await pool.query(
      `INSERT INTO contributors (user_id, points, tokens, anomalies, compute_minutes, streak, last_seen)
       VALUES ($1, $2, $3, $4, $5, 0, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         points          = contributors.points + $2,
         tokens          = contributors.tokens + $3,
         anomalies       = contributors.anomalies + $4,
         compute_minutes = contributors.compute_minutes + $5,
         last_seen       = $6`,
      [body.userId, points, tokens, anomalyDetected ? 1 : 0, minutes, timestamp]
    );

    return res.json({ success: true, pointsEarned: points, tokensEarned: tokens });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// GET /leaderboard
app.get('/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id, points, tokens, anomalies, compute_minutes, streak
       FROM contributors
       ORDER BY points DESC
       LIMIT 20`
    );
    const total = await pool.query('SELECT COUNT(*) FROM contributors');
    const leaderboard = rows.map((r, i) => ({
      rank: i + 1,
      userId: r.user_id,
      points: r.points,
      tokens: r.tokens,
      anomalies: r.anomalies,
      computeMinutes: r.compute_minutes,
      streak: r.streak,
    }));
    res.json({ leaderboard, total: parseInt(total.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /stats/global
app.get('/stats/global', async (_req, res) => {
  try {
    const [contrib, processed, anomalies, minutes, recent] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM contributors'),
      pool.query('SELECT COUNT(*) FROM results'),
      pool.query('SELECT COUNT(*) FROM results WHERE anomaly_detected = TRUE'),
      pool.query('SELECT COALESCE(SUM(compute_minutes), 0) AS total FROM contributors'),
      pool.query(
        'SELECT * FROM results WHERE anomaly_detected = TRUE ORDER BY timestamp DESC LIMIT 5'
      ),
    ]);
    res.json({
      totalContributors: parseInt(contrib.rows[0].count),
      totalResultsProcessed: parseInt(processed.rows[0].count),
      totalAnomaliesFound: parseInt(anomalies.rows[0].count),
      totalComputeMinutes: parseFloat(minutes.rows[0].total),
      recentAnomalies: recent.rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /stats/user/:userId
app.get('/stats/user/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM contributors WHERE user_id = $1',
      [req.params.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const rankResult = await pool.query(
      `SELECT COUNT(*) FROM contributors WHERE points > $1`,
      [rows[0].points]
    );
    const rank = parseInt(rankResult.rows[0].count) + 1;
    const u = rows[0];

    return res.json({
      userId: u.user_id,
      points: u.points,
      tokens: u.tokens,
      anomalies: u.anomalies,
      computeMinutes: u.compute_minutes,
      streak: u.streak,
      lastSeen: u.last_seen,
      rank,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ─── Démarrage ───────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`★ StarPulse Server v2.0.0 running on port ${PORT}`);
    console.log(`   Health : http://localhost:${PORT}/health`);
    console.log(`   Chunk  : http://localhost:${PORT}/chunk`);
    console.log(`   Board  : http://localhost:${PORT}/leaderboard`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

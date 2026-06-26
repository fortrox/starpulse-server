import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Types ───────────────────────────────────────────────────────────────────

interface Chunk {
  id: string;
  frequencyHz: number;
  data: number[];
  createdAt: number;
}

interface AnalysisResult {
  chunkId: string;
  userId: string;
  anomalyDetected: boolean;
  confidence: number;
  snrDb: number;
  duration: number;
  timestamp: number;
}

interface Contributor {
  userId: string;
  points: number;
  tokens: number;
  anomalies: number;
  computeMinutes: number;
  streak: number;
  lastSeen: number;
}

// ─── Stockage en mémoire (V1 — remplacer par DB en V2) ───────────────────────

const results: AnalysisResult[] = [];
const contributors = new Map<string, Contributor>();
const anomalyLog: AnalysisResult[] = [];

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function generateChunk(): Chunk {
  const size = 1024;
  const data: number[] = [];

  // Bruit de fond cosmique synthétique
  for (let i = 0; i < size; i++) {
    data.push((Math.random() - 0.5) * 2);
  }

  // 3% de chance d'injecter un signal
  if (Math.random() < 0.03) {
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

// GET /health — vérification serveur
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    contributors: contributors.size,
    resultsProcessed: results.length,
    anomaliesFound: anomalyLog.length,
    uptime: Math.floor(process.uptime()),
  });
});

// GET /chunk — récupère un chunk à analyser
app.get('/chunk', (_req, res) => {
  const chunk = generateChunk();
  res.json(chunk);
});

// POST /result — soumet le résultat d'un chunk analysé
app.post('/result', (req, res) => {
  const body = req.body as AnalysisResult;

  if (!body.chunkId || !body.userId) {
    return res.status(400).json({ error: 'chunkId and userId required' });
  }

  const result: AnalysisResult = {
    chunkId: body.chunkId,
    userId: body.userId,
    anomalyDetected: body.anomalyDetected ?? false,
    confidence: body.confidence ?? 0,
    snrDb: body.snrDb ?? 0,
    duration: body.duration ?? 0,
    timestamp: Date.now(),
  };

  results.push(result);
  if (result.anomalyDetected) anomalyLog.push(result);

  // Mettre à jour les stats du contributeur
  const existing = contributors.get(result.userId) ?? {
    userId: result.userId,
    points: 0,
    tokens: 0,
    anomalies: 0,
    computeMinutes: 0,
    streak: 0,
    lastSeen: 0,
  };

  const minutes = Math.ceil(result.duration / 60);
  if (result.anomalyDetected) existing.anomalies += 1;
  existing.computeMinutes += minutes;
  existing.lastSeen = Date.now();

  const { points, tokens } = calculateRewards(minutes, result.anomalyDetected ? 1 : 0, existing.streak);
  existing.points += points;
  existing.tokens += tokens;

  contributors.set(result.userId, existing);

  return res.json({ success: true, pointsEarned: points, tokensEarned: tokens });
});

// GET /leaderboard — top 20 contributeurs
app.get('/leaderboard', (_req, res) => {
  const top = Array.from(contributors.values())
    .sort((a, b) => b.points - a.points)
    .slice(0, 20)
    .map((c, i) => ({ rank: i + 1, ...c }));

  res.json({ leaderboard: top, total: contributors.size });
});

// GET /stats/global — stats globales du réseau
app.get('/stats/global', (_req, res) => {
  const totalMinutes = Array.from(contributors.values())
    .reduce((sum, c) => sum + c.computeMinutes, 0);

  res.json({
    totalContributors: contributors.size,
    totalResultsProcessed: results.length,
    totalAnomaliesFound: anomalyLog.length,
    totalComputeMinutes: totalMinutes,
    recentAnomalies: anomalyLog.slice(-5),
  });
});

// GET /stats/user/:userId — stats d'un contributeur
app.get('/stats/user/:userId', (req, res) => {
  const user = contributors.get(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rank = Array.from(contributors.values())
    .sort((a, b) => b.points - a.points)
    .findIndex((c) => c.userId === req.params.userId) + 1;

  return res.json({ ...user, rank });
});

// ─── Démarrage ───────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`★ StarPulse Server running on port ${PORT}`);
  console.log(`   Health : http://localhost:${PORT}/health`);
  console.log(`   Chunk  : http://localhost:${PORT}/chunk`);
  console.log(`   Board  : http://localhost:${PORT}/leaderboard`);
});

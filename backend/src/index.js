import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import { parseStream } from 'music-metadata';
import Busboy from 'busboy';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const prisma = new PrismaClient();
const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });
app.use(pinoHttp({ logger }));
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Audio storage
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const CURRENT_DIR = path.join(DATA_DIR, 'current');
const QUEUE_DIR = path.join(DATA_DIR, 'queue');
const CURRENT_FILE = path.join(CURRENT_DIR, 'current.mp3'); // normalized name

// Playback state in-memory
let currentTimer = null;

// Utility: schedule next track switch based on duration
async function scheduleAdvance(track) {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  const startedAt = new Date(track.startedAt || Date.now());
  const remainingMs = Math.max((track.durationS * 1000) - (Date.now() - startedAt.getTime()), 1000);
  logger.info({ trackId: track.id, remainingMs }, 'Scheduling advance to next track');

  currentTimer = setTimeout(async () => {
    try {
      await advanceQueue();
    } catch (err) {
      logger.error({ err }, 'advanceQueue failed');
    }
  }, remainingMs);
}

// Move to next track in the queue
async function advanceQueue() {
  const current = await prisma.track.findFirst({ where: { status: 'CURRENT' } });
  if (current) {
    await prisma.track.update({
      where: { id: current.id },
      data: { status: 'PLAYED', finishedAt: new Date() }
    });
    try { fs.rmSync(CURRENT_FILE, { force: true }); } catch {}
  }

  const next = await prisma.track.findFirst({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    include: { owner: true }
  });
  if (!next) {
    logger.info('Queue empty; nothing to play');
    return;
  }

  try {
    fs.copyFileSync(next.filePath, CURRENT_FILE);
    fs.rmSync(next.filePath, { force: true });
    console.log('Moved next track to slot:', { from: next.filePath, to: CURRENT_FILE });
  } catch (err) {
    logger.error({ err }, 'Failed to move next track file');
  }

  const startedAt = new Date();
  const updated = await prisma.track.update({
    where: { id: next.id },
    data: { status: 'CURRENT', startedAt }
  });

  await scheduleAdvance({ ...updated, startedAt });
}

// API: create or fetch user by username (simple auth placeholder)
app.post('/api/auth', async (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'username is required' });
  }
  let user = await prisma.user.findUnique({ where: { username } });
  if (!user) user = await prisma.user.create({ data: { username } });
  res.json({ user });
});

// API: get queue and current
app.get('/api/state', async (_req, res) => {
  const current = await prisma.track.findFirst({ where: { status: 'CURRENT' }, include: { owner: true } });
  const queue = await prisma.track.findMany({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' }, include: { owner: true } });
  res.json({ current, queue });
});

// API: upload
app.post('/api/upload', async (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  let userId = null;
  let title = null;
  let finalPath = null;

  busboy.on('field', (name, val) => {
    if (name === 'userId') userId = val;
    if (name === 'title') title = val;
  });

  busboy.on('file', (_name, file, info) => {
    const { filename, mimeType } = info;
    if (!mimeType || !mimeType.startsWith('audio/')) {
      file.resume();
      res.status(400).json({ error: 'Only audio files are allowed' });
      return;
    }
    const id = uuidv4();
    const ext = path.extname(filename) || '.mp3';
    finalPath = path.join(QUEUE_DIR, `${id}${ext}`);
    const tmp = `${finalPath}.uploading`;
    const ws = fs.createWriteStream(tmp);
    file.pipe(ws);
    ws.on('close', () => fs.renameSync(tmp, finalPath));
  });

  busboy.on('close', async () => {
    try {
      if (!userId || !finalPath) return res.status(400).json({ error: 'userId and audio file are required' });
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const activeCount = await prisma.track.count({
        where: { ownerId: userId, status: { in: ['QUEUED', 'CURRENT'] } }
      });
      if (activeCount > 0) {
        try { fs.rmSync(finalPath, { force: true }); } catch {}
        return res.status(409).json({ error: 'У вас уже есть активный трек. Дождитесь его проигрывания.' });
      }

      // Parse duration
      let durationS = 60;
      try {
        const stream = fs.createReadStream(finalPath);
        const meta = await parseStream(stream);
        durationS = Math.max(1, Math.round(meta?.format?.duration || 60));
        stream.destroy();
      } catch {}

      const created = await prisma.track.create({
        data: {
          ownerId: userId,
          title: title || 'Без названия',
          filePath: finalPath,
          durationS,
          status: 'QUEUED'
        }
      });

      const hasCurrent = await prisma.track.count({ where: { status: 'CURRENT' } });
      if (hasCurrent === 0) await advanceQueue();

      res.json({ ok: true, track: created });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  req.pipe(busboy);
});

// API: stream current audio  (updated)
app.get('/api/stream', async (req, res) => {
  const current = await prisma.track.findFirst({ where: { status: 'CURRENT' } });

  // Автовосстановление слота: если в БД есть CURRENT, а файла нет — попробуем скопировать заново
  if (current && !fs.existsSync(CURRENT_FILE)) {
    try {
      if (current.filePath && fs.existsSync(current.filePath)) {
        fs.copyFileSync(current.filePath, CURRENT_FILE);
        console.warn('STREAM: slot restored from', current.filePath);
      }
    } catch (e) {
      console.warn('STREAM restore failed:', e);
    }
  }

  if (!current || !fs.existsSync(CURRENT_FILE)) {
    console.warn('STREAM 404: current=%s, hasFile=%s', !!current, fs.existsSync(CURRENT_FILE));
    // не кэшируем отрицательный ответ, чтобы <audio> не залипал
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.status(404).send('No track playing');
  }

  const stat = fs.statSync(CURRENT_FILE);
  const range = req.headers.range;

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = (end - start) + 1;
    const file = fs.createReadStream(CURRENT_FILE, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg'
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(CURRENT_FILE).pipe(res);
  }
});

// API: delete queued track (owner only)
app.delete('/api/queue/:id', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const track = await prisma.track.findUnique({ where: { id } });
  if (!track) return res.status(404).json({ error: 'Not found' });
  if (track.ownerId !== userId) return res.status(403).json({ error: 'Not your track' });
  if (track.status !== 'QUEUED') return res.status(409).json({ error: 'Track already started' });

  try { fs.rmSync(track.filePath, { force: true }); } catch {}
  await prisma.track.delete({ where: { id } });
  res.json({ ok: true });
});

// Health
app.get('/api/health', async (_req, res) => {
  const counts = await prisma.track.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []);
  res.json({ ok: true, counts });
});

async function bootstrap() {
  await prisma.$connect();
  const current = await prisma.track.findFirst({ where: { status: 'CURRENT' } });
  if (current) {
    if (!fs.existsSync(CURRENT_FILE)) {
      try {
        if (fs.existsSync(current.filePath)) {
          fs.copyFileSync(current.filePath, CURRENT_FILE);
        }
      } catch {}
    }
    const startedAt = current.startedAt ? new Date(current.startedAt) : new Date();
    if (!current.startedAt) await prisma.track.update({ where: { id: current.id }, data: { startedAt } });
    await scheduleAdvance({ ...current, startedAt });
  } else {
    await advanceQueue();
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API on :${PORT}`);
  bootstrap().catch(err => console.error('bootstrap failed', err));
});


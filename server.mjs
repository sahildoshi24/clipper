import http from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
// These defaults keep local Windows development simple. Set the CLIPPER_*
// environment variables in a container to place all mutable state on a
// persistent volume instead of inside the deployed application image.
function configuredPath(environmentVariable, fallback) {
  const value = process.env[environmentVariable]?.trim();
  return value ? path.resolve(value) : fallback;
}

const DATA_DIR = configuredPath('CLIPPER_DATA_DIR', path.join(ROOT, 'data'));
const STORAGE_DIR = configuredPath('CLIPPER_STORAGE_DIR', path.join(ROOT, 'storage'));
const LOG_DIR = configuredPath('CLIPPER_LOG_DIR', path.join(ROOT, 'logs'));
const DATABASE_PATH = configuredPath('CLIPPER_DATABASE_PATH', path.join(DATA_DIR, 'clipper.db'));
const USER_ID = 'local-user';
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB, suitable for local MVP testing.
const YTDLP_PATH = process.env.CLIPPER_YTDLP_PATH?.trim() || (process.platform === 'win32' ? path.join(ROOT, 'bin', 'yt-dlp.exe') : '/usr/local/bin/yt-dlp');

for (const directory of [DATA_DIR, STORAGE_DIR, LOG_DIR, path.dirname(DATABASE_PATH)]) mkdirSync(directory, { recursive: true });

const db = new DatabaseSync(DATABASE_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT,
    source_url TEXT,
    source_video_id TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    fps REAL,
    video_codec TEXT,
    audio_codec TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clip_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    duration REAL NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    score REAL NOT NULL,
    transcript TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clip_generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    clip_id TEXT,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    output_path TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES clip_candidates(id),
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration REAL NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    status TEXT NOT NULL,
    thumbnail_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
  CREATE INDEX IF NOT EXISTS idx_videos_project ON videos(project_id);
  CREATE INDEX IF NOT EXISTS idx_candidates_project ON clip_candidates(project_id);
  CREATE INDEX IF NOT EXISTS idx_clips_project ON clips(project_id);
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class LocalStorageService {
  relative(...segments) {
    return path.join(...segments).replaceAll('\\', '/');
  }

  absolute(relativePath) {
    const resolved = path.resolve(STORAGE_DIR, relativePath);
    const root = `${path.resolve(STORAGE_DIR)}${path.sep}`;
    if (!resolved.startsWith(root)) throw new HttpError(400, 'Invalid storage path.');
    return resolved;
  }

  projectRelative(projectId, ...segments) {
    return this.relative('users', USER_ID, 'projects', projectId, ...segments);
  }

  async uploadBuffer(buffer, relativePath) {
    const destination = this.absolute(relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);
    return relativePath;
  }

  async downloadTo(sourceUrl, relativePath) {
    const destination = this.absolute(relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const response = await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(90_000) });
    if (!response.ok || !response.body) throw new HttpError(422, `Direct-video download failed (${response.status}).`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Remote video exceeds the 1 GB MVP limit.');
    await pipeline(response.body, createWriteStream(destination, { flags: 'w' }));
    const stat = await fs.stat(destination);
    if (!stat.size) throw new HttpError(422, 'Remote video download produced an empty file.');
    if (stat.size > MAX_UPLOAD_BYTES) {
      await fs.rm(destination, { force: true });
      throw new HttpError(413, 'Remote video exceeds the 1 GB MVP limit.');
    }
    return relativePath;
  }

  exists(relativePath) {
    return existsSync(this.absolute(relativePath));
  }

  async delete(relativePath) {
    await fs.rm(this.absolute(relativePath), { force: true });
  }
}

const storage = new LocalStorageService();
const now = () => new Date().toISOString();
const id = () => randomUUID();

function logJob(event, details) {
  const record = { at: now(), event, ...details };
  fs.appendFile(path.join(LOG_DIR, 'jobs.log'), `${JSON.stringify(record)}\n`).catch(() => undefined);
}

function row(statement, ...values) {
  return db.prepare(statement).get(...values);
}

function rows(statement, ...values) {
  return db.prepare(statement).all(...values);
}

function run(statement, ...values) {
  return db.prepare(statement).run(...values);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Unexpected server error.';
  if (status === 500) console.error(error);
  sendJson(res, status, { error: message });
}

async function readBody(req, limit = MAX_UPLOAD_BYTES + 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 2 * 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!match) throw new HttpError(400, 'Upload is missing a multipart boundary.');
  const boundary = match[1] || match[2];
  const marker = Buffer.from(`--${boundary}`);
  const nextMarker = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const parts = [];
  let position = body.indexOf(marker);
  if (position !== 0) throw new HttpError(400, 'Malformed multipart upload.');
  position += marker.length + 2;

  while (position < body.length) {
    const headerEnd = body.indexOf(headerSeparator, position);
    if (headerEnd < 0) break;
    const headerText = body.subarray(position, headerEnd).toString('utf8');
    const contentStart = headerEnd + headerSeparator.length;
    const contentEnd = body.indexOf(nextMarker, contentStart);
    if (contentEnd < 0) break;
    const disposition = /content-disposition:\s*form-data;\s*([^\r\n]+)/i.exec(headerText)?.[1] || '';
    const name = /name="([^"]+)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const mimeType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
    parts.push({ name, filename, mimeType, data: body.subarray(contentStart, contentEnd) });
    position = contentEnd + nextMarker.length;
    if (body.subarray(position, position + 2).toString() === '--') break;
    position += 2;
  }
  return parts;
}

function sanitizeName(filename) {
  const value = path.basename(filename || 'source.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
  return value || 'source.mp4';
}

function mimeFor(filename) {
  const extension = path.extname(filename).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[extension] || 'application/octet-stream';
}

function getProject(projectId) {
  const project = row('SELECT * FROM projects WHERE id = ? AND user_id = ?', projectId, USER_ID);
  if (!project) throw new HttpError(404, 'Project not found.');
  return project;
}

function getVideoForProject(projectId) {
  getProject(projectId);
  const video = row('SELECT * FROM videos WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', projectId);
  if (!video) throw new HttpError(404, 'This project has no stored source video yet.');
  return video;
}

function getClip(clipId) {
  const clip = row(`SELECT clips.*, projects.name AS project_name FROM clips
    JOIN projects ON projects.id = clips.project_id
    WHERE clips.id = ? AND projects.user_id = ?`, clipId, USER_ID);
  if (!clip) throw new HttpError(404, 'Clip not found.');
  return clip;
}

function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    sourceType: project.source_type,
    sourceUrl: project.source_url,
    sourceVideoId: project.source_video_id,
    status: project.status,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
  };
}

function publicVideo(video) {
  if (!video) return null;
  return {
    id: video.id, filename: video.filename, mimeType: video.mime_type, fileSize: video.file_size,
    duration: video.duration, width: video.width, height: video.height, fps: video.fps,
    videoCodec: video.video_codec, audioCodec: video.audio_codec, status: video.status,
    createdAt: video.created_at, updatedAt: video.updated_at,
  };
}

function publicCandidate(candidate) {
  return {
    id: candidate.id, projectId: candidate.project_id, videoId: candidate.video_id,
    startTime: candidate.start_time, endTime: candidate.end_time, duration: candidate.duration,
    title: candidate.title, description: candidate.description, score: candidate.score,
    transcript: candidate.transcript, status: candidate.status, createdAt: candidate.created_at,
  };
}

function publicClip(clip) {
  return {
    id: clip.id, projectId: clip.project_id, projectName: clip.project_name,
    videoId: clip.video_id, candidateId: clip.candidate_id, filename: clip.filename,
    mimeType: clip.mime_type, fileSize: clip.file_size, duration: clip.duration,
    startTime: clip.start_time, endTime: clip.end_time, status: clip.status,
    createdAt: clip.created_at, updatedAt: clip.updated_at,
    videoUrl: `/api/clips/${clip.id}/video`, thumbnailUrl: clip.thumbnail_path ? `/api/clips/${clip.id}/thumbnail` : null,
    downloadUrl: `/api/clips/${clip.id}/download`,
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => reject(error));

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = signal
        ? `signal ${signal}`
        : `exit code ${code}`;

      reject(new Error(
        `${command} terminated with ${reason}: ${stderr.slice(-2000)}`
      ));
    });
  });
}

function parseFrameRate(value) {
  if (!value || value === '0/0') return null;
  const [numerator, denominator] = value.split('/').map(Number);
  return denominator ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

async function probeMedia(absolutePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', absolutePath,
  ]);
  let report;
  try { report = JSON.parse(stdout); } catch { throw new Error('FFprobe returned unreadable metadata.'); }
  const videoStream = report.streams?.find((stream) => stream.codec_type === 'video');
  if (!videoStream) throw new Error('The file contains no readable video stream.');
  const audioStream = report.streams?.find((stream) => stream.codec_type === 'audio');
  const duration = Number(report.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The source has no valid duration.');
  const stat = await fs.stat(absolutePath);
  return {
    duration: Math.round(duration * 1000) / 1000,
    width: videoStream.width || null,
    height: videoStream.height || null,
    fps: parseFrameRate(videoStream.r_frame_rate),
    videoCodec: videoStream.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    fileSize: stat.size,
    format: report.format?.format_name || '',
  };
}

function candidateWindows(duration) {
  const clipLength = Math.min(30, duration);
  const starts = duration <= clipLength + 0.25
    ? [0]
    : [0, Math.max(0, (duration - clipLength) / 2), Math.max(0, duration - clipLength)];
  const seen = new Set();
  return starts
    .map((start) => Math.round(start * 1000) / 1000)
    .filter((start) => {
      const key = start.toFixed(3);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((start, index) => ({ start, end: Math.round(Math.min(duration, start + clipLength) * 1000) / 1000, index }));
}

function formatSeconds(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateJob(jobId, status, progress, extras = {}) {
  const columns = ['status = ?', 'progress = ?'];
  const values = [status, progress];
  for (const [column, value] of Object.entries(extras)) {
    columns.push(`${column} = ?`);
    values.push(value);
  }
  values.push(jobId);
  run(`UPDATE clip_generation_jobs SET ${columns.join(', ')} WHERE id = ?`, ...values);
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

async function downloadYouTubeVideo(sourceUrl, projectId) {
  if (!existsSync(YTDLP_PATH)) throw new Error('YouTube downloader is not installed on this server.');
  const tempRelative = storage.projectRelative(projectId, 'source', 'youtube-download');
  const tempDir = storage.absolute(tempRelative);
  const sourceRelative = storage.projectRelative(projectId, 'source', 'source.mp4');
  const sourcePath = storage.absolute(sourceRelative);
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });
  try {
    const ytDlpArgs = [
      '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames', '--max-filesize', '1G',
      '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4',
      '--output', path.join(tempDir, 'download.%(ext)s'),
    ];
    if (process.env.CLIPPER_YTDLP_POT_ENABLED === '1') {
      ytDlpArgs.push(
        '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
        '--extractor-args', 'youtube:player-client=mweb',
      );
    }
    ytDlpArgs.push(sourceUrl);
    await runProcess(YTDLP_PATH, ytDlpArgs);
    const entries = await fs.readdir(tempDir, { withFileTypes: true });
    const candidates = entries.filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name)).map((entry) => path.join(tempDir, entry.name));
    if (!candidates.length) throw new Error('YouTube download completed without producing an MP4 file.');
    const downloaded = candidates[0];
    const stat = await fs.stat(downloaded);
    if (!stat.size) throw new Error('Downloaded YouTube video is empty.');
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error('Downloaded YouTube video exceeds the 1 GB MVP limit.');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.rm(sourcePath, { force: true });
    await fs.rename(downloaded, sourcePath);
    return sourceRelative;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ingestVideo(project, { buffer, originalFilename, mimeType, sourceUrl }) {
  const sourceRelative = storage.projectRelative(project.id, 'source', 'source.mp4');
  const sourcePath = storage.absolute(sourceRelative);
  const updateProject = (status, fields = {}) => {
    const timestamp = now();
    run(`UPDATE projects SET status = ?, source_type = COALESCE(?, source_type), source_url = COALESCE(?, source_url), updated_at = ? WHERE id = ?`, status, fields.sourceType || null, fields.sourceUrl || null, timestamp, project.id);
  };
  updateProject('ingesting', { sourceType: sourceUrl ? (isYouTubeUrl(sourceUrl) ? 'youtube' : 'direct_url') : 'local_upload', sourceUrl });
  try {
    if (buffer) {
      await storage.uploadBuffer(buffer, sourceRelative);
    } else if (isYouTubeUrl(sourceUrl)) {
      await downloadYouTubeVideo(sourceUrl, project.id);
    } else {
      await storage.downloadTo(sourceUrl, sourceRelative);
    }
    updateProject('processing');
    const metadata = await probeMedia(sourcePath);
    const videoId = id();
    const timestamp = now();
    run(`INSERT INTO videos (id, project_id, filename, storage_path, mime_type, file_size, duration, width, height, fps, video_codec, audio_codec, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      videoId, project.id, sanitizeName(originalFilename || (sourceUrl && isYouTubeUrl(sourceUrl) ? 'youtube-source.mp4' : path.basename(new URL(sourceUrl).pathname) || 'source.mp4')), sourceRelative,
      mimeType || 'video/mp4', metadata.fileSize, metadata.duration, metadata.width, metadata.height, metadata.fps, metadata.videoCodec, metadata.audioCodec, timestamp, timestamp);
    run('UPDATE projects SET source_video_id = ?, status = ?, updated_at = ? WHERE id = ?', videoId, 'created', timestamp, project.id);
    return getVideoForProject(project.id);
  } catch (error) {
    await storage.delete(sourceRelative).catch(() => undefined);
    run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', 'failed', now(), project.id);
    throw new HttpError(422, `Video ingestion failed: ${error.message.replace(sourcePath, 'source file')}`);
  }
}

async function analyzeProject(projectId) {
  const project = getProject(projectId);
  const video = getVideoForProject(projectId);
  run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', 'analyzing', now(), project.id);
  try {
    const sourcePath = storage.absolute(video.storage_path);
    const metadata = await probeMedia(sourcePath);
    // The MVP's deterministic analysis service only emits intervals bounded by actual FFprobe duration.
    const windows = candidateWindows(metadata.duration);
    run('DELETE FROM clip_candidates WHERE project_id = ?', project.id);
    for (const window of windows) {
      const candidateId = id();
      const score = Math.round((0.9 - window.index * 0.08) * 100) / 100;
      run(`INSERT INTO clip_candidates (id, project_id, video_id, start_time, end_time, duration, title, description, score, transcript, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
        candidateId, project.id, video.id, window.start, window.end, window.end - window.start,
        `Clip opportunity ${window.index + 1}`, `Valid source segment from ${formatSeconds(window.start)} to ${formatSeconds(window.end)}.`, score,
        'Deterministic MVP analysis: timestamps are derived from the source duration.', now());
    }
    run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', 'ready', now(), project.id);
    return rows('SELECT * FROM clip_candidates WHERE project_id = ? ORDER BY start_time', project.id).map(publicCandidate);
  } catch (error) {
    run('UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', 'failed', now(), project.id);
    throw new HttpError(422, `Video analysis failed: ${error.message}`);
  }
}

async function generateClip(projectId, candidateId) {
  const project = getProject(projectId);
  const candidate = row('SELECT * FROM clip_candidates WHERE id = ? AND project_id = ?', candidateId, project.id);
  if (!candidate) throw new HttpError(404, 'Clip candidate not found.');
  const video = getVideoForProject(project.id);
  if (candidate.video_id !== video.id) throw new HttpError(409, 'Candidate does not belong to this source video.');
  if (candidate.start_time < 0 || candidate.end_time <= candidate.start_time || candidate.end_time > video.duration + 0.05) {
    throw new HttpError(422, 'Candidate timestamps are outside the actual source duration.');
  }

  const jobId = id();
  const createdAt = now();
  run(`INSERT INTO clip_generation_jobs (id, project_id, video_id, start_time, end_time, status, progress, created_at)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)`, jobId, project.id, video.id, candidate.start_time, candidate.end_time, createdAt);
  const existingCount = row('SELECT COUNT(*) AS count FROM clips WHERE project_id = ?', project.id).count;
  const ordinal = String(Number(existingCount) + 1).padStart(3, '0');
  const filename = `clip_${ordinal}.mp4`;
  const outputRelative = storage.projectRelative(project.id, 'clips', filename);
  const thumbnailRelative = storage.projectRelative(project.id, 'thumbnails', `clip_${ordinal}.jpg`);
  const inputPath = storage.absolute(video.storage_path);
  const outputPath = storage.absolute(outputRelative);
  const thumbnailPath = storage.absolute(thumbnailRelative);
  const duration = Math.round((candidate.end_time - candidate.start_time) * 1000) / 1000;

  logJob('queued', { jobId, projectId: project.id, videoId: video.id, inputPath: video.storage_path, outputPath: outputRelative, startTime: candidate.start_time, endTime: candidate.end_time });
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    updateJob(jobId, 'processing', 15);
    logJob('processing', { jobId, projectId: project.id, videoId: video.id, inputPath: video.storage_path, outputPath: outputRelative });
    await runProcess('ffmpeg', [
      '-hide_banner', '-y', '-ss', String(candidate.start_time), '-i', inputPath, '-t', String(duration),
      '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', outputPath,
    ]);
    updateJob(jobId, 'rendering', 65);
    if (!existsSync(outputPath) || (await fs.stat(outputPath)).size <= 0) throw new Error('FFmpeg did not create a non-empty output file.');
    updateJob(jobId, 'validating', 78);
    const outputMetadata = await probeMedia(outputPath);
    if (!outputMetadata.format.includes('mp4')) throw new Error(`Output format is not MP4 (${outputMetadata.format || 'unknown'}).`);
    if (outputMetadata.duration <= 0 || outputMetadata.duration > duration + 1.5) throw new Error('Rendered output duration is invalid.');
    await runProcess('ffmpeg', ['-hide_banner', '-y', '-ss', String(Math.min(1, outputMetadata.duration / 2)), '-i', outputPath, '-frames:v', '1', '-q:v', '2', thumbnailPath]);
    if (!existsSync(thumbnailPath) || (await fs.stat(thumbnailPath)).size <= 0) throw new Error('Thumbnail generation did not create a non-empty file.');
    const clipId = id();
    const timestamp = now();
    run(`INSERT INTO clips (id, project_id, video_id, candidate_id, filename, storage_path, mime_type, file_size, duration, start_time, end_time, status, thumbnail_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'video/mp4', ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      clipId, project.id, video.id, candidate.id, filename, outputRelative, outputMetadata.fileSize, outputMetadata.duration,
      candidate.start_time, candidate.end_time, thumbnailRelative, timestamp, timestamp);
    updateJob(jobId, 'completed', 100, { clip_id: clipId, output_path: outputRelative, completed_at: timestamp });
    logJob('completed', { jobId, projectId: project.id, videoId: video.id, outputPath: outputRelative, outputFileSize: outputMetadata.fileSize, validationResult: 'passed', storageResult: 'persisted', databaseResult: 'created' });
    return publicClip(getClip(clipId));
  } catch (error) {
    updateJob(jobId, 'failed', 100, { error: error.message.slice(-1500), completed_at: now() });
    logJob('failed', { jobId, projectId: project.id, videoId: video.id, outputPath: outputRelative, error: error.message.slice(-1500), validationResult: 'failed' });
    throw new HttpError(422, `Clip generation failed: ${error.message.replaceAll(ROOT, '')}`);
  }
}

function streamFile(req, res, absolutePath, mimeType, downloadName) {
  if (!existsSync(absolutePath)) throw new HttpError(404, 'Stored file is missing.');
  const stat = requireStat(absolutePath);
  const range = req.headers.range;
  const commonHeaders = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=0' };
  if (downloadName) commonHeaders['Content-Disposition'] = `attachment; filename="${sanitizeName(downloadName)}"`;
  if (!range) {
    res.writeHead(200, { ...commonHeaders, 'Content-Length': stat.size });
    createReadStream(absolutePath).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (match[1] === '' && match[2]) { start = Math.max(0, stat.size - Number(match[2])); end = stat.size - 1; }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, { ...commonHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
  createReadStream(absolutePath, { start, end }).pipe(res);
}

function requireStat(filePath) {
  try { return statSync(filePath); } catch { throw new HttpError(404, 'Stored file is missing.'); }
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const absolute = path.resolve(PUBLIC_DIR, requested);
  if (!absolute.startsWith(`${PUBLIC_DIR}${path.sep}`) && absolute !== path.join(PUBLIC_DIR, 'index.html')) throw new HttpError(404, 'Not found.');
  if (!existsSync(absolute)) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    createReadStream(index).pipe(res);
    return;
  }
  const stat = await fs.stat(absolute);
  if (stat.isDirectory()) throw new HttpError(404, 'Not found.');
  res.writeHead(200, { 'Content-Type': mimeFor(absolute), 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
  createReadStream(absolute).pipe(res);
}

async function handleApi(req, res, url) {
  const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method || 'GET';
  const [api, resource, resourceId, action, subAction] = pathParts;
  if (api !== 'api') throw new HttpError(404, 'Not found.');
  if (method === 'GET' && resource === 'health') return sendJson(res, 200, { ok: true, ffmpeg: true });

  if (resource === 'projects' && !resourceId && method === 'GET') {
    const projects = rows('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC', USER_ID).map(publicProject);
    return sendJson(res, 200, { projects });
  }
  if (resource === 'projects' && !resourceId && method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) throw new HttpError(400, 'Project name must be between 1 and 120 characters.');
    const project = { id: id(), user_id: USER_ID, name, status: 'created', created_at: now(), updated_at: now() };
    run('INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', project.id, project.user_id, project.name, project.status, project.created_at, project.updated_at);
    return sendJson(res, 201, { project: publicProject(project) });
  }
  if (resource === 'projects' && resourceId && !action && method === 'GET') {
    const project = getProject(resourceId);
    const video = row('SELECT * FROM videos WHERE project_id = ? ORDER BY created_at DESC LIMIT 1', project.id);
    const candidates = rows('SELECT * FROM clip_candidates WHERE project_id = ? ORDER BY start_time', project.id).map(publicCandidate);
    const jobs = rows('SELECT id, status, progress, error, created_at, completed_at FROM clip_generation_jobs WHERE project_id = ? ORDER BY created_at DESC', project.id);
    return sendJson(res, 200, { project: publicProject(project), video: publicVideo(video), candidates, jobs });
  }
  if (resource === 'projects' && resourceId && action === 'source' && method === 'POST') {
    const project = getProject(resourceId);
    if (row('SELECT id FROM videos WHERE project_id = ?', project.id)) throw new HttpError(409, 'This project already has a source video. Create another project for a different source.');
    const type = req.headers['content-type'] || '';
    let video;
    if (type.startsWith('multipart/form-data')) {
      const parts = parseMultipart(await readBody(req), type);
      const file = parts.find((part) => part.name === 'file' && part.filename);
      if (!file || !file.data.length) throw new HttpError(400, 'Select a non-empty local video file.');
      video = await ingestVideo(project, { buffer: file.data, originalFilename: file.filename, mimeType: file.mimeType });
    } else {
      const body = await readJson(req);
      const sourceUrl = String(body.sourceUrl || '').trim();
      let parsed;
      try { parsed = new URL(sourceUrl); } catch { throw new HttpError(400, 'Enter a valid HTTP(S) video URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Only HTTP(S) video URLs are supported.');
      if (!isYouTubeUrl(parsed.toString()) && !/\.mp4(?:$|[?#])/i.test(parsed.pathname + parsed.search)) throw new HttpError(400, 'Direct URL sources must point to an .mp4 file, or enter a supported YouTube URL.');
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(parsed.hostname)) throw new HttpError(400, 'Local network URLs are not accepted as remote sources. Upload the file instead.');
      video = await ingestVideo(project, { sourceUrl: parsed.toString(), originalFilename: path.basename(parsed.pathname), mimeType: 'video/mp4' });
    }
    return sendJson(res, 201, { video: publicVideo(video) });
  }
  if (resource === 'projects' && resourceId && action === 'source' && subAction === 'video' && method === 'GET') {
    const video = getVideoForProject(resourceId);
    return streamFile(req, res, storage.absolute(video.storage_path), video.mime_type);
  }
  if (resource === 'projects' && resourceId && action === 'analyze' && method === 'POST') {
    const candidates = await analyzeProject(resourceId);
    return sendJson(res, 200, { candidates });
  }
  if (resource === 'projects' && resourceId && action === 'analysis-status' && method === 'GET') {
    const project = getProject(resourceId);
    const candidates = rows('SELECT * FROM clip_candidates WHERE project_id = ? ORDER BY start_time', project.id).map(publicCandidate);
    return sendJson(res, 200, { status: project.status, candidates });
  }
  if (resource === 'projects' && resourceId && action === 'candidates' && method === 'GET') {
    getProject(resourceId);
    return sendJson(res, 200, { candidates: rows('SELECT * FROM clip_candidates WHERE project_id = ? ORDER BY start_time', resourceId).map(publicCandidate) });
  }
  if (resource === 'projects' && resourceId && action === 'candidates' && subAction && method === 'POST') {
    const clip = await generateClip(resourceId, subAction);
    return sendJson(res, 201, { clip });
  }
  if (resource === 'projects' && resourceId && action === 'clips' && method === 'GET') {
    getProject(resourceId);
    return sendJson(res, 200, { clips: rows(`SELECT clips.*, projects.name AS project_name FROM clips JOIN projects ON projects.id = clips.project_id WHERE clips.project_id = ? AND projects.user_id = ? ORDER BY clips.created_at DESC`, resourceId, USER_ID).map(publicClip) });
  }
  if (resource === 'clips' && !resourceId && method === 'GET') {
    const clips = rows(`SELECT clips.*, projects.name AS project_name FROM clips JOIN projects ON projects.id = clips.project_id WHERE projects.user_id = ? ORDER BY clips.created_at DESC`, USER_ID).map(publicClip);
    return sendJson(res, 200, { clips });
  }
  if (resource === 'clips' && resourceId && !action && method === 'GET') return sendJson(res, 200, { clip: publicClip(getClip(resourceId)) });
  if (resource === 'clips' && resourceId && action === 'video' && method === 'GET') {
    const clip = getClip(resourceId);
    return streamFile(req, res, storage.absolute(clip.storage_path), clip.mime_type);
  }
  if (resource === 'clips' && resourceId && action === 'thumbnail' && method === 'GET') {
    const clip = getClip(resourceId);
    if (!clip.thumbnail_path) throw new HttpError(404, 'Clip has no thumbnail.');
    return streamFile(req, res, storage.absolute(clip.thumbnail_path), 'image/jpeg');
  }
  if (resource === 'clips' && resourceId && action === 'download' && method === 'GET') {
    const clip = getClip(resourceId);
    return streamFile(req, res, storage.absolute(clip.storage_path), clip.mime_type, clip.filename);
  }
  if (resource === 'clips' && resourceId && !action && method === 'DELETE') {
    const clip = getClip(resourceId);
    await storage.delete(clip.storage_path);
    if (clip.thumbnail_path) await storage.delete(clip.thumbnail_path);
    run('DELETE FROM clips WHERE id = ?', clip.id);
    return sendJson(res, 200, { deleted: true });
  }
  throw new HttpError(404, 'API route not found.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') sendJson(res, 200, { status: 'ok' });
    else if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CLIPPER is listening on 0.0.0.0:${PORT}`);
});


const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let toastTimer;

const api = async (endpoint, options = {}) => {
  const response = await fetch(endpoint, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
};

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const seconds = (value) => {
  const total = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
const bytes = (value) => {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
};
const date = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const status = (value) => `<span class="status ${escapeHtml(value)}">${escapeHtml(value)}</span>`;

function showToast(message, error = false) {
  toast.textContent = message;
  toast.hidden = false;
  toast.style.background = error ? '#ffe9e9' : '#e9fff5';
  toast.style.color = error ? '#5b0f0f' : '#063021';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function loading(label = 'Loading…') {
  app.innerHTML = `<div class="loading"><span class="spinner"></span>${escapeHtml(label)}</div>`;
}

function setRoute(route) { location.hash = route; }

function projectCard(project) {
  return `<article class="card project-card">
    <div><h3>${escapeHtml(project.name)}</h3><p>Updated ${date(project.updatedAt)} · ${project.sourceType ? escapeHtml(project.sourceType.replace('_', ' ')) : 'awaiting source'}</p></div>
    <div class="inline">${status(project.status)} <a class="button secondary" href="#project/${project.id}">Open</a></div>
  </article>`;
}

function clipRow(clip, controls = true) {
  return `<article class="card clip-row">
    ${clip.thumbnailUrl ? `<img class="thumb" src="${clip.thumbnailUrl}" alt="Thumbnail for ${escapeHtml(clip.filename)}" />` : '<div class="thumb"></div>'}
    <div><div class="inline"><h3>${escapeHtml(clip.filename)}</h3>${status(clip.status)}</div>
      <p>${escapeHtml(clip.projectName || 'Project')} · ${seconds(clip.duration)} · ${bytes(clip.fileSize)} · ${date(clip.createdAt)}</p>
      <p>Source range: ${seconds(clip.startTime)}–${seconds(clip.endTime)}</p></div>
    ${controls ? `<div class="clip-actions"><button class="secondary" data-play="${clip.id}">Play</button><a class="button secondary" href="${clip.downloadUrl}">Download</a><button class="danger" data-delete="${clip.id}">Delete</button></div>` : ''}
  </article>`;
}

async function dashboard() {
  loading();
  try {
    const [{ projects }, { clips }] = await Promise.all([api('/api/projects'), api('/api/clips')]);
    app.innerHTML = `<section class="page-head"><div><p class="eyebrow">Projects</p><h1>Turn videos into real clips.</h1><p>Upload a video, then render persistent, streamable MP4 clips using FFmpeg.</p></div><a class="button" href="#create">Create project</a></section>
      <section class="grid two"><div><div class="inline" style="justify-content:space-between;margin-bottom:12px"><h2>Projects</h2><span>${projects.length}</span></div>
        <div class="grid">${projects.length ? projects.map(projectCard).join('') : '<div class="empty">No projects yet. Create one to upload a local MP4.</div>'}</div></div>
      <div><div class="inline" style="justify-content:space-between;margin-bottom:12px"><h2>Recent clips</h2><a href="#files">Open File Manager</a></div>
        <div class="grid">${clips.length ? clips.slice(0, 3).map((clip) => clipRow(clip, false)).join('') : '<div class="empty">Generated clips will appear here after FFmpeg has rendered and validated them.</div>'}</div></div></section>`;
  } catch (error) { renderFailure(error); }
}

function createProjectPage() {
  app.innerHTML = `<section class="page-head"><div><p class="eyebrow">New project</p><h1>Add a video source.</h1><p>Upload a local video file. It is inspected and stored before clipping.</p></div></section>
    <section class="card" style="max-width:720px"><form id="create-project-form">
      <label>Project name<input name="name" required maxlength="120" placeholder="e.g. August product interview" /></label>
      <label>Local video file<input name="file" required type="file" accept="video/mp4,video/*" /></label>
      <p class="help">The file is uploaded to the server, inspected by FFprobe, and stored as the project source. The MVP upload limit is 1 GB.</p>
      <button type="submit">Create and ingest source</button>
      <div id="form-message"></div>
    </form></section>`;
  document.querySelector('#create-project-form').addEventListener('submit', submitProject);
}

async function submitProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const message = form.querySelector('#form-message');
  const formData = new FormData(form);
  const name = String(formData.get('name') || '').trim();
  const file = formData.get('file');
  if (!(file instanceof File && file.size)) { message.innerHTML = '<div class="notice error">Choose a non-empty local video file.</div>'; return; }
  button.disabled = true;
  message.innerHTML = '<div class="notice">Creating project and ingesting the source… this uses the actual file.</div>';
  try {
    const { project } = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const upload = new FormData();
    upload.append('file', file, file.name);
    await api(`/api/projects/${project.id}/source`, { method: 'POST', body: upload });
    showToast('Source stored and metadata extracted.');
    setRoute(`project/${project.id}`);
  } catch (error) {
    message.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    button.disabled = false;
  }
}

function generatedClipsSection(clips) {
  return `<section style="margin-top:22px" id="generated-clips"><div class="inline" style="justify-content:space-between;margin-bottom:12px"><div><h2>Generated clips</h2><span class="help">Real MP4 files rendered and saved to persistent storage.</span></div><a class="button secondary compact" href="#files">Open File Manager</a></div>
    ${clips.length ? `<div class="clip-list">${clips.map((clip) => clipRow(clip)).join('')}</div><section id="project-player-panel" style="margin-top:16px"></section>` : '<div class="empty">No MP4 clips have been generated yet. Choose a candidate above and click Generate actual MP4.</div>'}</section>`;
}

async function projectPage(projectId) {
  loading('Loading project…');
  try {
    const [{ project, video, candidates, jobs }, { clips }] = await Promise.all([
      api(`/api/projects/${projectId}`),
      api(`/api/projects/${projectId}/clips`),
    ]);
    const failedJob = jobs.find((job) => job.status === 'failed');
    app.innerHTML = `<section class="page-head"><div><p class="eyebrow">Project</p><h1>${escapeHtml(project.name)}</h1><p>Project status: ${status(project.status)}</p></div><div class="inline"><a class="button secondary" href="#files">File Manager</a><a class="button secondary" href="#dashboard">All projects</a></div></section>
      ${project.status === 'failed' ? '<div class="notice error">The last source or processing operation failed. Review the message when performing the next action.</div>' : ''}
      ${video ? sourceSection(project, video) : sourceAttachSection(project)}
      ${video ? analysisSection(project, candidates, failedJob) : ''}
      ${video && candidates.length ? candidatesSection(project, candidates) : ''}
      ${video ? generatedClipsSection(clips) : ''}
      <section id="project-action-message"></section>`;
    document.querySelector('#analyze')?.addEventListener('click', () => analyze(project.id));
    document.querySelector('#attach-source-form')?.addEventListener('submit', attachSource);
    document.querySelectorAll('[data-generate]').forEach((button) => button.addEventListener('click', () => generate(project.id, button.dataset.generate, button)));
    document.querySelectorAll('[data-play]').forEach((button) => button.addEventListener('click', () => playProjectClip(button.dataset.play)));
  } catch (error) { renderFailure(error); }
}

function sourceSection(project, video) {
  return `<section class="card"><div class="inline" style="justify-content:space-between"><div><h2>Stored source video</h2><p class="help">This is the actual persistent file uploaded to this project.</p></div>${status(video.status)}</div>
    <div class="metadata"><div><span>File</span><strong>${escapeHtml(video.filename)}</strong></div><div><span>Duration</span><strong>${seconds(video.duration)}</strong></div><div><span>Video</span><strong>${video.width}×${video.height} · ${escapeHtml(video.videoCodec || 'unknown')}</strong></div><div><span>Audio / size</span><strong>${escapeHtml(video.audioCodec || 'no audio')} · ${bytes(video.fileSize)}</strong></div></div>
    <div style="margin-top:18px"><video controls preload="metadata" src="/api/projects/${project.id}/source/video"></video></div></section>`;
}

function sourceAttachSection(project) {
  return `<section class="card"><h2>Attach a source</h2><p>This project exists but has no source video. Attach a real local video to continue.</p><form id="attach-source-form"><label>Local video file<input name="file" required type="file" accept="video/mp4,video/*" /></label><button type="submit">Store and inspect video</button></form></section>`;
}

function analysisSection(project, candidates, failedJob) {
  const statusText = candidates.length ? `${candidates.length} valid timestamp candidate${candidates.length === 1 ? '' : 's'} are ready.` : 'No candidates yet. Run deterministic analysis to derive valid ranges from the source duration.';
  return `<section class="card" style="margin-top:16px"><div class="inline" style="justify-content:space-between"><div><h2>Analysis</h2><p>${statusText}</p></div><button id="analyze">${candidates.length ? 'Re-run analysis' : 'Run analysis'}</button></div>${failedJob ? `<div class="notice error">Last clip job failed: ${escapeHtml(failedJob.error || 'Unknown error')}</div>` : ''}</section>`;
}

function candidatesSection(project, candidates) {
  return `<section style="margin-top:22px"><div class="inline" style="justify-content:space-between;margin-bottom:12px"><h2>Clip candidates</h2><span>${candidates.length} from backend</span></div><div class="grid three">${candidates.map((candidate) => `<article class="card candidate"><div class="candidate-top"><h3>${escapeHtml(candidate.title)}</h3>${status(candidate.status)}</div><strong>${seconds(candidate.startTime)} → ${seconds(candidate.endTime)} <span style="color:#91a0b3;font-weight:500">(${seconds(candidate.duration)})</span></strong><p>${escapeHtml(candidate.description)}</p><p>Score ${candidate.score} · source-bounded timestamp</p><button data-generate="${candidate.id}">Generate actual MP4</button></article>`).join('')}</div></section>`;
}

async function attachSource(event) {
  event.preventDefault();
  const projectId = location.hash.split('/')[1];
  const file = new FormData(event.currentTarget).get('file');
  const button = event.currentTarget.querySelector('button');
  if (!(file instanceof File) || !file.size) return;
  button.disabled = true;
  const payload = new FormData(); payload.append('file', file, file.name);
  try { await api(`/api/projects/${projectId}/source`, { method: 'POST', body: payload }); showToast('Source stored and inspected.'); projectPage(projectId); }
  catch (error) { showToast(error.message, true); button.disabled = false; }
}

async function analyze(projectId) {
  const button = document.querySelector('#analyze');
  button.disabled = true; button.innerHTML = '<span class="spinner"></span>Analyzing';
  try { const { candidates } = await api(`/api/projects/${projectId}/analyze`, { method: 'POST' }); showToast(`${candidates.length} valid clip candidate${candidates.length === 1 ? '' : 's'} found.`); projectPage(projectId); }
  catch (error) { showToast(error.message, true); button.disabled = false; button.textContent = 'Run analysis'; }
}

async function generate(projectId, candidateId, button) {
  button.disabled = true; button.innerHTML = '<span class="spinner"></span>Rendering';
  const actionMessage = document.querySelector('#project-action-message');
  actionMessage.innerHTML = '<div class="notice">FFmpeg is rendering the selected source range, validating the output MP4, and generating a real thumbnail… Keep this page open until rendering finishes.</div>';
  try {
    const { clip } = await api(`/api/projects/${projectId}/candidates/${candidateId}`, { method: 'POST' });
    showToast(`${clip.filename} rendered, validated, and stored.`);
    await projectPage(projectId);
    setTimeout(() => document.querySelector('#generated-clips')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  } catch (error) {
    actionMessage.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    button.disabled = false;
    button.textContent = 'Retry actual MP4 generation';
  }
}

async function playProjectClip(clipId) {
  try {
    const { clip } = await api(`/api/clips/${clipId}`);
    const panel = document.querySelector('#project-player-panel');
    if (!panel) return;
    panel.innerHTML = `<article class="card"><div class="inline" style="justify-content:space-between"><div><h3>Playing ${escapeHtml(clip.filename)}</h3><p class="help">This is the actual rendered MP4 stored by CLIPPER.</p></div><a class="button secondary" href="${clip.downloadUrl}">Download MP4</a></div><div style="margin-top:15px"><video controls autoplay preload="metadata" src="${clip.videoUrl}"></video></div></article>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { showToast(error.message, true); }
}

async function filesPage() {
  loading('Loading persistent clips…');
  try {
    const { clips } = await api('/api/clips');
    app.innerHTML = `<section class="page-head"><div><p class="eyebrow">Persistent storage</p><h1>File Manager</h1><p>Every entry below is a SQLite record backed by a real MP4 and JPEG stored on the server.</p></div><a class="button secondary" href="#dashboard">Projects</a></section>
      <section class="clip-list">${clips.length ? clips.map((clip) => clipRow(clip)).join('') : '<div class="empty">No generated clips yet. Render a candidate from a project first.</div>'}</section>
      <section id="player-panel" style="margin-top:22px"></section>`;
    document.querySelectorAll('[data-play]').forEach((button) => button.addEventListener('click', () => play(button.dataset.play)));
    document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteClip(button.dataset.delete)));
  } catch (error) { renderFailure(error); }
}

async function play(clipId) {
  try {
    const { clip } = await api(`/api/clips/${clipId}`);
    const panel = document.querySelector('#player-panel');
    panel.innerHTML = `<article class="card"><div class="inline" style="justify-content:space-between"><div><h2>Playing ${escapeHtml(clip.filename)}</h2><p class="help">Served as a persistent MP4 with HTTP Range support for seeking.</p></div><a class="button secondary" href="${clip.downloadUrl}">Download</a></div><div style="margin-top:15px"><video controls autoplay preload="metadata" src="${clip.videoUrl}"></video></div></article>`;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) { showToast(error.message, true); }
}

async function deleteClip(clipId) {
  if (!confirm('Delete this generated MP4 and its thumbnail from persistent storage?')) return;
  try { await api(`/api/clips/${clipId}`, { method: 'DELETE' }); showToast('Clip files and database record deleted.'); filesPage(); }
  catch (error) { showToast(error.message, true); }
}

function renderFailure(error) {
  app.innerHTML = `<section class="card"><h1>Something went wrong</h1><div class="notice error">${escapeHtml(error.message)}</div><p><a href="#dashboard">Return to projects</a></p></section>`;
}

function router() {
  const [route = 'dashboard', identifier] = location.hash.slice(1).split('/');
  if (route === 'create') return createProjectPage();
  if (route === 'project' && identifier) return projectPage(identifier);
  if (route === 'files') return filesPage();
  dashboard();
}

window.addEventListener('hashchange', router);
router();

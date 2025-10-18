const API = (path) => path.startsWith('/api') ? path : '/api' + path;

let user = null;
let userId = null;
let lastCurrentId = null;
let userInteracted = false;
let retryTimer = null;
let retryDelay = 500;
let expectingStream = false; // <- добавили

function markInteractionAndTryPlay() {
  userInteracted = true;
  const player = document.getElementById('player');
  player.muted = false;
  player.play().catch(()=>{});
}

['click','keydown','touchstart'].forEach(evt =>
  document.addEventListener(evt, markInteractionAndTryPlay, { once: true })
);

async function login() {
  const username = document.getElementById('username').value.trim();
  if (!username) return;
  const res = await fetch(API('/auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });
  const data = await res.json();
  user = data.user;
  userId = user.id;
  document.getElementById('hello').textContent = `Привет, ${user.username}!`;
  markInteractionAndTryPlay(); // логин — «жест»
  refreshState();
}

function clearStream() {
  const player = document.getElementById('player');
  expectingStream = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  player.removeAttribute('src');
  player.load();
}

function attachStreamSrc() {
  const player = document.getElementById('player');
  expectingStream = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  player.src = API('/stream') + '?ts=' + Date.now();
  player.load();
  if (userInteracted) {
    player.muted = false;
    player.play().catch(()=>{});
  }
}

document.getElementById('player').addEventListener('canplay', () => {
  if (!expectingStream) return;
  const player = document.getElementById('player');
  if (userInteracted) {
    player.muted = false;
    player.play().catch(()=>{});
  }
});

// Ретраи только если МЫ реально ждём поток (есть current)
document.getElementById('player').addEventListener('error', () => {
  if (!expectingStream) return;
  const player = document.getElementById('player');
  if (!retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 2, 5000);
      player.src = API('/stream') + '?ts=' + Date.now();
      player.load();
      if (userInteracted) {
        player.muted = false;
        player.play().catch(()=>{});
      }
    }, retryDelay);
  }
});

async function refreshState() {
  const res = await fetch(API('/state'));
  const data = await res.json();
  const current = data.current;
  const queue = data.queue || [];

  const currentEl = document.getElementById('current');
  currentEl.innerHTML = current
    ? `<div class="title">${current.title}</div><div class="meta">Загрузил: ${current.owner.username} • Длительность: ${current.durationS} секунд</div>`
    : '<div>Ничего не играет</div>';

  const newId = current ? current.id : null;
  if (newId !== lastCurrentId) {
    lastCurrentId = newId;
    if (newId) attachStreamSrc(); else clearStream();
  }

  const queueEl = document.getElementById('queue');
  queueEl.innerHTML = '';
  queue.forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = `<div><div>${item.title}</div><div class="meta">Загрузил: ${item.owner.username} • ${item.durationS}s</div></div>`;
    if (userId && item.owner.id === userId) {
      const btn = document.createElement('button');
      btn.textContent = 'Отменить';
      btn.onclick = async () => {
        await fetch(API(`/queue/${item.id}?userId=${userId}`), { method: 'DELETE' });
        await refreshState();
      };
      li.appendChild(btn);
    }
    queueEl.appendChild(li);
  });
}

async function upload(ev) {
  ev.preventDefault();
  if (!userId) {
    document.getElementById('uploadMsg').textContent = 'Сначала войдите';
    return;
  }
  const file = document.getElementById('fileInput').files[0];
  const title = document.getElementById('title').value.trim();
  if (!file) return;
  const fd = new FormData();
  fd.append('userId', userId);
  fd.append('title', title);
  fd.append('file', file);
  const res = await fetch(API('/upload'), { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById('uploadMsg').textContent =
      data.error || (res.status === 409 ? 'Ваш трек уже в очереди/играет, подождите окончания.' : 'Ошибка');
  } else {
    document.getElementById('uploadMsg').textContent = 'Готово! Трек в очереди';
    document.getElementById('fileInput').value = '';
    document.getElementById('title').value = '';
    // дальше refreshState увидит CURRENT и вызовет attachStreamSrc()
    refreshState();
  }
}

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('uploadForm').addEventListener('submit', upload);
setInterval(refreshState, 5000);

// рекомендую оставить без запрета перемотки, чтобы не мешать Range-запросам


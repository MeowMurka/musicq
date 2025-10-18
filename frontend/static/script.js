<script>
// ========= БАЗОВЫЙ URL ДЛЯ API =========
// Берём из config.js (window.API_BASE). Если его вдруг нет — используем текущий origin.
// На Render у тебя в config.js прописано: window.API_BASE = "https://musicq.onrender.com";
const API_BASE = (typeof window !== 'undefined' && window.API_BASE && window.API_BASE.trim())
  ? window.API_BASE.trim().replace(/\/+$/,'')
  : window.location.origin;

// Строим абсолютный URL к API
const API = (path) => {
  const p = path.startsWith('/api') ? path : '/api' + path;
  return API_BASE + p;
};

// Осторожный парсер JSON: не падаем на текстовые 404/500
async function jsonOrThrow(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(`HTTP ${res.status}: ${text.trim() || '<empty>'}`);
  }
}

// ========= ГЛОБАЛЬНОЕ СОСТОЯНИЕ =========
let user = null;
let userId = null;
let lastCurrentId = null;
let userInteracted = false;
let retryTimer = null;
let retryDelay = 500;      // экспоненциальный бэкофф до 5с
let expectingStream = false;

// ========= ВСПОМОГАТЕЛЬНОЕ =========
function markInteractionAndTryPlay() {
  userInteracted = true;
  const player = document.getElementById('player');
  if (!player) return;
  player.muted = false;
  player.play().catch(()=>{ /* политика автоплея — ок */ });
}

// Один раз отметим "юзер-жест", чтобы сработал автоплей со звуком
['click','keydown','touchstart'].forEach(evt =>
  document.addEventListener(evt, markInteractionAndTryPlay, { once: true })
);

function clearStream() {
  const player = document.getElementById('player');
  if (!player) return;
  expectingStream = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  player.removeAttribute('src');
  player.load();
}

function attachStreamSrc() {
  const player = document.getElementById('player');
  if (!player) return;
  expectingStream = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryDelay = 500;
  // кэш-бастер, чтобы не липла старая 404
  player.src = API('/stream') + '?ts=' + Date.now();
  player.load();
  if (userInteracted) {
    player.muted = false;
    player.play().catch(()=>{});
  }
}

// Когда браузер готов играть — стартуем, если можно
document.getElementById('player')?.addEventListener('canplay', () => {
  if (!expectingStream) return;
  const player = document.getElementById('player');
  if (userInteracted) {
    player.muted = false;
    player.play().catch(()=>{});
  }
});

// Ретраи стрима только если мы реально ожидаем поток (есть current)
document.getElementById('player')?.addEventListener('error', () => {
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

// ========= API ВЗАИМОДЕЙСТВИЕ =========
async function login(ev) {
  if (ev) ev.preventDefault();
  const username = document.getElementById('username').value.trim();
  if (!username) return;

  const res = await fetch(API('/auth'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });

  const data = await jsonOrThrow(res);
  user = data.user;
  userId = user.id;
  document.getElementById('hello').textContent = `Привет, ${user.username}!`;

  // логин — это жест пользователя, можно пытаться играть со звуком
  markInteractionAndTryPlay();
  await refreshState();
}

async function refreshState() {
  try {
    const res = await fetch(API('/state'), { cache: 'no-store' });
    const data = await jsonOrThrow(res);
    const current = data.current;
    const queue = data.queue || [];

    const currentEl = document.getElementById('current');
    const player = document.getElementById('player');

    if (current) {
      currentEl.innerHTML =
        `<div class="title">${current.title}</div>
         <div class="meta">Загрузил: ${current.owner.username} • Длительность: ${current.durationS} секунд</div>`;

      // если сменился трек — переназначим источник
      const newId = current.id;
      if (newId !== lastCurrentId) {
        lastCurrentId = newId;
        attachStreamSrc();
      }
    } else {
      currentEl.innerHTML = '<div>Ничего не играет</div>';
      lastCurrentId = null;
      if (player && !player.paused) player.pause();
      clearStream();
    }

    // очередь
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
  } catch (e) {
    console.error('refreshState failed:', e);
  }
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

  try {
    const res = await fetch(API('/upload'), { method: 'POST', body: fd });
    const data = await jsonOrThrow(res);
    if (!res.ok || !data.ok) {
      document.getElementById('uploadMsg').textContent =
        (data && data.error) || (res.status === 409
          ? 'Ваш трек уже в очереди/играет, подождите окончания.'
          : 'Ошибка');
    } else {
      document.getElementById('uploadMsg').textContent = 'Готово! Трек в очереди';
      document.getElementById('fileInput').value = '';
      document.getElementById('title').value = '';
      await refreshState(); // увидим CURRENT и подцепим стрим
    }
  } catch (e) {
    console.error('upload failed:', e);
    document.getElementById('uploadMsg').textContent = 'Ошибка загрузки';
  }
}

// ========= ИНИЦИАЛИЗАЦИЯ UI =========
document.getElementById('loginBtn')?.addEventListener('click', login);
document.getElementById('uploadForm')?.addEventListener('submit', upload);

// периодическое обновление состояния
setInterval(refreshState, 5000);

// Перемотку лучше не трогать — она нужна для корректной работы Range-запросов
</script>


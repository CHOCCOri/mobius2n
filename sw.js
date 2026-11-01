/* ============================================================================
   R202 · 定时任务交接 Service Worker（sw.js）
   ----------------------------------------------------------------------------
   主线程把「几分钟后要做的事」交到这里：落 IndexedDB → 到点弹系统通知。
   页面被冻结 / 被系统杀掉都不影响 —— 每次本 SW 被唤醒（install / activate /
   message / notificationclick / periodicsync / sync）都会扫一遍过期任务补发，
   所以最坏的情况是「迟到」，不会是「丢失」。

   三条铁律（写代码前先记住，不然会写出自我感觉良好的 bug）：
   1) SW 里的 setTimeout 不是闹钟。浏览器 30 秒没事件就来杀进程，
      waitUntil() 只能把寿命延长，Chrome 单次事件最多约 5 分钟。
      → 所以只敢用 setTimeout 兜「≤ MAX_HOLD_MS」的活，更远的靠扫表。
   2) 任务必须落盘。SW 随时会被重启，内存里的东西全没。
   3) 弹通知要判断「页面前台可见吗」。用户正盯着页面时再弹一条系统通知很吵，
      这时改成给页面 postMessage，让站内横幅（R201）去接。
   ========================================================================== */

const DB_NAME = 'cg-notify';
const DB_VERSION = 1;
const STORE = 'tasks';

/** 一次 setTimeout 最多抱多久。留 30 秒余量给 waitUntil 的上限。 */
const MAX_HOLD_MS = 4.5 * 60 * 1000;
/** 同一批任务被两个入口同时扫到时，避免重复弹（看 firedAt） */
const DEDUPE_MS = 3000;
/** 迟到超过这个时间就不弹了，只回报给页面（免得醒来被一堆旧通知轰炸） */
const STALE_MS = 6 * 60 * 60 * 1000;

let armedTimer = 0;
let sweeping = false;

/* ---------------------------------------------------------------- IndexedDB */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('at', 'at');
        store.createIndex('state', 'state');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const req = r => ({ __req: r });
const putTask = task => withStore('readwrite', s => s.put(task));
const getTask = id => withStore('readonly', s => req(s.get(id)));
const deleteTask = id => withStore('readwrite', s => s.delete(id));
const allTasks = () => withStore('readonly', s => req(s.getAll()));

/* ------------------------------------------------------------------ 任务模型 */

function normalizeTask(raw) {
  const task = raw && typeof raw === 'object' ? raw : {};
  const at = Number(task.at);
  return {
    id: String(task.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    at: Number.isFinite(at) ? at : Date.now(),
    title: String(task.title || '新消息').slice(0, 120),
    body: String(task.body || '').slice(0, 200),
    tag: String(task.tag || task.id || '').slice(0, 64),
    url: String(task.url || './').slice(0, 512),
    icon: typeof task.icon === 'string' ? task.icon : '',
    data: task.data && typeof task.data === 'object' ? task.data : {},
    /* 页面在前台时也强制弹系统通知（默认关闭：前台交给站内横幅） */
    forceSystem: task.forceSystem === true,
    state: 'pending',
    createdAt: Date.now(),
    firedAt: 0,
    deliveredAs: ''
  };
}

/* ------------------------------------------------------------------- 定时器 */

function clearArmed() {
  if (armedTimer) {
    clearTimeout(armedTimer);
    armedTimer = 0;
  }
}

/** 把「离现在最近、且还没到点太久」的那一条挂到 setTimeout 上 */
async function arm() {
  clearArmed();
  const list = (await allTasks()).filter(t => t && t.state === 'pending');
  if (!list.length) return;
  list.sort((a, b) => a.at - b.at);
  const next = list[0];
  const delay = next.at - Date.now();
  if (delay > MAX_HOLD_MS) return;   /* 太远，等下次唤醒再 arm */
  armedTimer = setTimeout(() => {
    armedTimer = 0;
    fireTask(next.id);
  }, Math.max(0, delay));
}

/* --------------------------------------------------------------- 派发通知 */

async function showNotificationFor(task) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
    await self.registration.showNotification(task.title, {
      body: task.body,
      tag: task.tag,                 /* 同 tag 覆盖，避免堆积一屏 */
      renotify: true,
      icon: task.icon || undefined,          /* 对方头像（页面裁好的 192 方圆形 PNG） */
      badge: task.badge || task.icon || undefined,
      timestamp: task.at,
      data: Object.assign({ taskId: task.id, at: task.at, url: task.url }, task.data)
    });
    return true;
  } catch (err) {
    console.warn('[sw] showNotification 失败', err);
    return false;
  }
}

/**
 * 派发一条任务：
 *  - 页面前台可见 → postMessage 交给站内横幅（R201），不弹系统通知
 *  - 否则 → 弹系统通知；没权限 / 失败也记一笔，等页面回来补
 */
async function deliver(task) {
  const now = Date.now();
  const age = now - task.at;
  if (age > STALE_MS) {
    task.state = 'fired';
    task.firedAt = now;
    task.deliveredAs = 'stale';
    await putTask(task);
    broadcast({ type: 'task-fired', task });
    return;
  }

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.find(c => c.visibilityState === 'visible');

  if (visible && !task.forceSystem) {
    visible.postMessage({ type: 'due', task });
    task.state = 'fired';
    task.firedAt = now;
    task.deliveredAs = 'in-app';
    await putTask(task);
    broadcast({ type: 'task-fired', task }, visible);
    return;
  }

  const ok = await showNotificationFor(task);
  task.state = 'fired';
  task.firedAt = now;
  task.deliveredAs = ok ? 'system' : 'failed';
  await putTask(task);
  broadcast({ type: 'task-fired', task });
}

function fireTask(id) {
  return getTask(id).then(task => {
    if (!task || task.state !== 'pending') return;
    if (task.firedAt && Date.now() - task.firedAt < DEDUPE_MS) return;
    return deliver(task);
  });
}

/* ------------------------------------------------------------------ 扫表 */

/** 过期任务立刻补发；剩下的重新挂定时器。所有入口都走这里。 */
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const list = (await allTasks()).filter(t => t && t.state === 'pending');
    const now = Date.now();
    const overdue = list.filter(t => t.at <= now).sort((a, b) => a.at - b.at).slice(0, 8);
    for (const task of overdue) await deliver(task);
    await arm();
  } finally {
    sweeping = false;
  }
}

function broadcast(message, except) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    list.forEach(client => {
      if (client === except) return;
      try { client.postMessage(message); } catch (_) { /* 页面已经关了 */ }
    });
  });
}

/* ------------------------------------------------------------------- 生命周期 */

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(sweep());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await sweep();
  })());
});

self.addEventListener('message', event => {
  const msg = event.data || {};
  const source = event.source;

  if (msg.type === 'ping') {
    source?.postMessage({ type: 'pong', at: Date.now() });
    return;
  }

  if (msg.type === 'schedule') {
    const task = normalizeTask(msg.task);
    event.waitUntil((async () => {
      await putTask(task);
      await sweep();                     /* 顺手把「已经过点」的直接发掉 */
      source?.postMessage({ type: 'scheduled', id: task.id, at: task.at });
    })());
    return;
  }

  if (msg.type === 'cancel') {
    const id = String(msg.id || '');
    event.waitUntil((async () => {
      if (id) await deleteTask(id);
      await arm();
      source?.postMessage({ type: 'cancelled', id });
    })());
    return;
  }

  if (msg.type === 'sync') {
    event.waitUntil((async () => {
      await sweep();
      const list = await allTasks();
      source?.postMessage({
        type: 'sync-result',
        now: Date.now(),
        tasks: list.filter(t => t.state === 'fired' && Date.now() - t.firedAt < STALE_MS)
      });
    })());
    return;
  }

  /* 调试用：看看「谁被挂到 setTimeout 上、谁只是躺在库里」 */
  if (msg.type === 'debug-state') {
    event.waitUntil((async () => {
      const list = await allTasks();
      source?.postMessage({
        type: 'debug-state',
        armed: armedTimer ? true : false,
        pending: list.filter(t => t.state === 'pending').map(t => ({ id: t.id, at: t.at })),
        maxHoldMs: MAX_HOLD_MS,
        now: Date.now()
      });
    })());
    return;
  }

  /* 调试用：notificationclick 没法在自动化里真点，这条消息跑的是同一个函数 */
  if (msg.type === 'debug-click') {
    event.waitUntil(activateFromNotification(msg.taskId, msg.data || {}, msg.data?.url));
    return;
  }

  if (msg.type === 'clear') {
    event.waitUntil((async () => {
      const list = await allTasks();
      await Promise.all(list.filter(t => t.state === 'fired').map(t => deleteTask(t.id)));
      source?.postMessage({ type: 'cleared' });
    })());
  }
});

/** 点了通知之后：已经开着同源页面就聚焦 + 告知；否则开一个新窗口带 ?nid= */
async function activateFromNotification(taskId, data, baseUrl) {
  const id = taskId || '';
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const same = list.find(c => c.url.startsWith(self.registration.scope));
  if (same) {
    try { await same.focus(); } catch (_) { /* 有些环境不让 focus */ }
    same.postMessage({ type: 'notification-click', taskId: id, data: data || {} });
    return;
  }
  const url = new URL(baseUrl || './', self.registration.scope);
  if (id) url.searchParams.set('nid', id);
  const win = await self.clients.openWindow(url.href);
  /* 新窗口的脚本还没跑起来，postMessage 可能丢；页面自己读 ?nid= 兜底 */
  win?.postMessage?.({ type: 'notification-click', taskId: id, data: data || {} });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(activateFromNotification(data.taskId, data, data.url));
});

self.addEventListener('notificationclose', event => {
  const data = event.notification.data || {};
  broadcast({ type: 'notification-close', taskId: data.taskId || '' });
});

/* Periodic Background Sync：装了 PWA 之后系统会隔一段时间叫醒一次，
   正好拿来当「扫表」的免费闹钟（别指望它的精度，Chrome 最短 12 小时）。 */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'cg-notify-sweep') event.waitUntil(sweep());
});

/* 有后端时（Web Push）在 push 里叫醒一下就行；
   没有后端也没关系，这条只是为了让以后接推送不用改结构。 */
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = {}; }
  event.waitUntil((async () => {
    if (payload && payload.title) {
      await deliver(Object.assign(normalizeTask(payload), { at: Date.now() }));
      return;
    }
    await sweep();
  })());
});

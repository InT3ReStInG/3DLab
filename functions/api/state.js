const json = (body, status = 200, headers = {}) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", ...headers },
});

const overlaps = (startA, endA, startB, endB) => startA < endB && endA > startB;
const minutes = value => Math.max(1, Math.round(Number(value) || 1));
const SESSION_COOKIE = "pl750_session";
const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: encoder.encode(salt),
    iterations: 10000,
  }, key, 256);
  return base64url(new Uint8Array(bits));
}

function safeEqual(first, second) {
  if (typeof first !== "string" || typeof second !== "string" || first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return difference === 0;
}

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.split(";").map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function sessionTokenFromRequest(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  return match?.[1] || cookieValue(request, SESSION_COOKIE);
}

function sessionCookie(token, maxAge) {
  const age = Number.isFinite(maxAge) ? `; Max-Age=${maxAge}` : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax${age}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function ensureAuthTables(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, can_edit INTEGER NOT NULL DEFAULT 0, printer_order TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)").run();
  try {
    await db.prepare("ALTER TABLE users ADD COLUMN printer_order TEXT NOT NULL DEFAULT '[]'").run();
  } catch (_) {}
  await db.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)").run();
}

function publicUser(row) {
  if (!row) return null;
  let printerOrder = [];
  try { printerOrder = JSON.parse(row.printer_order || "[]"); } catch (_) {}
  return { id: row.id, name: row.name, canEdit: Boolean(row.can_edit), printerOrder: Array.isArray(printerOrder) ? printerOrder : [] };
}

async function currentUser(request, db) {
  await ensureAuthTables(db);
  const token = sessionTokenFromRequest(request);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare("SELECT users.id,users.name,users.can_edit,users.printer_order,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?")
    .bind(tokenHash).first();
  if (!row || Number(row.expires_at) <= Date.now()) {
    if (row) await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
    return null;
  }
  return publicUser(row);
}

function stateForUser(state, user) {
  if (!user?.printerOrder?.length) return { ...state, user };
  const positions = new Map(user.printerOrder.map((id, index) => [id, index]));
  const fallback = state.printers.length + 1;
  return {
    ...state,
    printers: [...state.printers].sort((first, second) =>
      (positions.get(first.id) ?? fallback) - (positions.get(second.id) ?? fallback)
    ),
    user,
  };
}

function validateSameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function createSession(db, userId, remember) {
  const token = randomToken();
  const lifetime = remember ? 30 * 24 * 60 * 60 : 12 * 60 * 60;
  await db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)")
    .bind(await sha256(token), userId, Date.now() + lifetime * 1000, Date.now()).run();
  return { token, lifetime, remember };
}

function normalizePrinter(printer) {
  return {
    ...printer,
    queue: Array.isArray(printer.queue) ? printer.queue : [],
    reservations: Array.isArray(printer.reservations) ? printer.reservations : [],
    printHistory: Array.isArray(printer.printHistory) ? printer.printHistory : [],
  };
}

function queueSlots(printer, now = Date.now()) {
  let cursor = printer.status === "printing" && printer.endsAt > now ? printer.endsAt : now;
  const reservations = printer.reservations
    .filter(item => item.endAt > now)
    .sort((a, b) => a.startAt - b.startAt);

  return printer.queue.map(job => {
    const length = minutes(job.duration) * 60000;
    for (const reservation of reservations) {
      if (reservation.endAt <= cursor) continue;
      if (cursor + length <= reservation.startAt) break;
      cursor = Math.max(cursor, reservation.endAt);
    }
    const slot = { ...job, startAt: cursor, endAt: cursor + length };
    cursor = slot.endAt;
    return slot;
  });
}

function busyConflict(printer, startAt, endAt, options = {}) {
  const now = Date.now();
  if (printer.status === "printing" && printer.endsAt > now) {
    const activeStart = printer.startedAt || Math.min(now, printer.endsAt - minutes(printer.duration || 60) * 60000);
    if (overlaps(startAt, endAt, activeStart, printer.endsAt)) return "devam eden baskı";
  }

  const reservation = printer.reservations.find(item =>
    item.id !== options.ignoreReservationId && overlaps(startAt, endAt, item.startAt, item.endAt)
  );
  if (reservation) return `“${reservation.purpose}” rezervasyonu`;

  if (options.includeQueue) {
    const queued = queueSlots(printer, now).find(item => overlaps(startAt, endAt, item.startAt, item.endAt));
    if (queued) return `“${queued.name}” sıralı işi`;
  }
  return null;
}

async function ensureTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS lab_state (id INTEGER PRIMARY KEY, printers TEXT NOT NULL, activity TEXT NOT NULL, saved_jobs TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)").run();
  try {
    await db.prepare("ALTER TABLE lab_state ADD COLUMN saved_jobs TEXT NOT NULL DEFAULT '[]'").run();
  } catch (_) {}
  const found = await db.prepare("SELECT id FROM lab_state WHERE id=1").first();
  if (found) return;

  const now = Date.now();
  const printers = [
    { id: "printer-01", name: "Yazıcı 01", color: "#dc2626", status: "printing", job: "İHA sensör braketi v4", owner: "Ece Yılmaz", startedAt: now - 2820000, endsAt: now + 8280000, duration: 185, queue: [{ id: "q1", name: "Hava girişi prototipi", owner: "Kerem", duration: 150 }], reservations: [] },
    { id: "printer-02", name: "Yazıcı 02", color: "#2563eb", status: "free", queue: [], reservations: [] },
    { id: "printer-03", name: "Yazıcı 03", color: "#64748b", status: "finished", job: "Kanat nervürü test parçası", owner: "Mert Kaya", endsAt: now - 1440000, queue: [], reservations: [] },
    { id: "printer-04", name: "Yazıcı 04", color: "#64748b", status: "maintenance", maintenanceNote: "Nozul değişimi", queue: [], reservations: [] },
    { id: "printer-05", name: "Yazıcı 05", color: "#2563eb", status: "free", queue: [{ id: "q2", name: "Motor bağlantı parçası", owner: "Selin", duration: 95 }], reservations: [] },
  ];
  const activity = [
    { id: "a1", action: "Baskı başlatıldı", detail: "İHA sensör braketi v4 · Yazıcı 01", user: "Ece Yılmaz", at: now - 2820000 },
    { id: "a2", action: "Baskı tamamlandı", detail: "Kanat nervürü test parçası · Yazıcı 03", user: "Mert Kaya", at: now - 4920000 },
    { id: "a3", action: "Bakım modu açıldı", detail: "Nozul değişimi · Yazıcı 04", user: "Laboratuvar Sorumlusu", at: now - 11520000 },
  ];
  await db.prepare("INSERT INTO lab_state (id,printers,activity,saved_jobs,updated_at) VALUES (1,?,?,?,?)")
    .bind(JSON.stringify(printers), JSON.stringify(activity), "[]", now).run();
}

async function readState(db) {
  await ensureTable(db);
  const row = await db.prepare("SELECT printers,activity,saved_jobs FROM lab_state WHERE id=1").first();
  const state = {
    printers: JSON.parse(row.printers).map(normalizePrinter),
    activity: JSON.parse(row.activity),
    savedJobs: JSON.parse(row.saved_jobs || "[]"),
  };
  let changed = false;
  state.printers = state.printers.map(printer => {
    if (["printing", "finished"].includes(printer.status) && printer.endsAt && !printer.startedAt) {
      const matchingEntries = state.activity.filter(entry =>
        Number(entry.at) <= Number(printer.endsAt)
        && /Baskı başlatıldı|Sıradaki baskı başlatıldı/.test(String(entry.action || ""))
        && String(entry.detail || "").includes(String(printer.job || ""))
      );
      const strictMatch = matchingEntries.find(entry => String(entry.detail || "").includes(String(printer.name || "")));
      const recovered = strictMatch || matchingEntries[0];
      if (recovered?.at) {
        printer = {
          ...printer,
          startedAt: Number(recovered.at),
          duration: Math.max(1, Math.round((Number(printer.endsAt) - Number(recovered.at)) / 60000)),
        };
        changed = true;
      } else if (printer.duration) {
        printer = { ...printer, startedAt: Number(printer.endsAt) - minutes(printer.duration) * 60000 };
        changed = true;
      }
    }
    if (printer.status === "printing" && printer.endsAt && printer.endsAt <= Date.now()) {
      changed = true;
      return { ...printer, status: "finished" };
    }
    return printer;
  });

  const now = Date.now();
  state.printers = state.printers.map(printer => {
    if (printer.status !== "free") return printer;
    const due = printer.reservations
      .filter(item => item.kind === "scheduled" && Number(item.startAt) <= now)
      .sort((a, b) => Number(a.startAt) - Number(b.startAt));
    if (!due.length) return printer;

    const active = due.find(item => Number(item.endAt) > now);
    const current = active || due[due.length - 1];
    const archived = due
      .filter(item => item.id !== current.id)
      .map(item => ({ id: `print-${item.id}`, label: item.purpose, owner: item.owner, startAt: Number(item.startAt), endAt: Number(item.endAt) }));
    const dueIds = new Set(due.map(item => item.id));
    const finished = Number(current.endAt) <= now;
    const next = {
      ...printer,
      status: finished ? "finished" : "printing",
      job: current.purpose,
      owner: current.owner,
      startedAt: Number(current.startAt),
      endsAt: Number(current.endAt),
      duration: Math.max(1, Math.round((Number(current.endAt) - Number(current.startAt)) / 60000)),
      reservations: printer.reservations.filter(item => !dueIds.has(item.id)),
      printHistory: [...printer.printHistory, ...archived].slice(-100),
    };
    state.activity.unshift({
      id: crypto.randomUUID(),
      action: finished ? "Planlı baskı otomatik tamamlandı" : "Planlı baskı otomatik başlatıldı",
      detail: `${current.purpose} · ${printer.name}`,
      user: "Sistem",
      at: now,
    });
    changed = true;
    return next;
  });
  if (changed) await writeState(db, state);
  return state;
}

async function writeState(db, state) {
  await db.prepare("UPDATE lab_state SET printers=?,activity=?,saved_jobs=?,updated_at=? WHERE id=1")
    .bind(JSON.stringify(state.printers), JSON.stringify(state.activity.slice(0, 500)), JSON.stringify(state.savedJobs || []), Date.now()).run();
}

function findPrinter(state, id) {
  return state.printers.find(printer => printer.id === id);
}

function replacePrinter(state, next) {
  state.printers = state.printers.map(printer => printer.id === next.id ? next : printer);
}

function requireText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} boş bırakılamaz`);
  return text;
}

function applyAction(state, body) {
  const action = body.action;
  const printer = body.printerId ? findPrinter(state, body.printerId) : null;

  if (action === "addSavedJob") {
    state.savedJobs.unshift({
      id: crypto.randomUUID(),
      name: requireText(body.savedJob?.name, "İş adı"),
      duration: minutes(body.savedJob?.duration),
      createdBy: requireText(body.entry?.user, "Ad"),
      createdAt: Date.now(),
    });
    return;
  }

  if (action === "editSavedJob") {
    const existing = state.savedJobs.find(item => item.id === body.savedJobId);
    if (!existing) throw new Error("Kayıtlı iş bulunamadı");
    state.savedJobs = state.savedJobs.map(item => item.id === body.savedJobId ? {
      ...item,
      name: requireText(body.name, "İş adı"),
      duration: minutes(body.duration),
      updatedAt: Date.now(),
    } : item);
    return;
  }

  if (action === "deleteSavedJob") {
    if (!state.savedJobs.some(item => item.id === body.savedJobId)) throw new Error("Kayıtlı iş bulunamadı");
    state.savedJobs = state.savedJobs.filter(item => item.id !== body.savedJobId);
    return;
  }

  if (action === "addPrinter") {
    const next = normalizePrinter(body.printer || {});
    next.name = requireText(next.name, "Yazıcı adı");
    if (!next.id || state.printers.some(item => item.id === next.id)) throw new Error("Bu yazıcı zaten mevcut");
    state.printers.push(next);
    return;
  }

  if (action === "deletePrinter") {
    if (!printer) throw new Error("Yazıcı bulunamadı");
    state.printers = state.printers.filter(item => item.id !== printer.id);
    return;
  }

  if (action === "reorderPrinters") {
    const positions = new Map((body.order || []).map((id, index) => [id, index]));
    state.printers.sort((a, b) => (positions.get(a.id) ?? 9999) - (positions.get(b.id) ?? 9999));
    return;
  }

  if (!printer) throw new Error("Yazıcı bulunamadı");

  if (action === "deletePrintHistory") {
    if (!printer.printHistory.some(item => item.id === body.printId)) throw new Error("Baskı geçmişi kaydı bulunamadı");
    replacePrinter(state, { ...printer, printHistory: printer.printHistory.filter(item => item.id !== body.printId) });
    return;
  }

  if (action === "editCurrentPrintName") {
    if (!["printing", "finished"].includes(printer.status) || !printer.job) throw new Error("Mevcut baskı bulunamadı");
    replacePrinter(state, { ...printer, job: requireText(body.name, "Baskı adı") });
    return;
  }

  if (action === "editScheduledPrintName") {
    const reservation = printer.reservations.find(item => item.id === body.reservationId && item.kind === "scheduled");
    if (!reservation) throw new Error("Planlı baskı bulunamadı");
    replacePrinter(state, {
      ...printer,
      reservations: printer.reservations.map(item => item.id === reservation.id
        ? { ...item, purpose: requireText(body.name, "Baskı adı") }
        : item),
    });
    return;
  }

  if (action === "startJob") {
    if (["maintenance", "broken"].includes(printer.status)) throw new Error(printer.status === "broken" ? "Arızalı yazıcıya iş eklenemez" : "Bakımdaki yazıcıya iş eklenemez");
    const job = {
      id: crypto.randomUUID(),
      name: requireText(body.job?.name, "İş adı"),
      owner: requireText(body.job?.owner, "Ad"),
      duration: minutes(body.job?.duration),
    };
    if (printer.status === "free" && printer.queue.length === 0) {
      const startedAt = Date.now();
      const endsAt = startedAt + job.duration * 60000;
      const conflict = busyConflict(printer, startedAt, endsAt);
      if (conflict) throw new Error(`Bu süre ${conflict} ile çakışıyor. Süreyi kısaltın veya rezervasyon sonrasına sıraya ekleyin.`);
      replacePrinter(state, { ...printer, status: "printing", job: job.name, owner: job.owner, duration: job.duration, startedAt, endsAt });
      body.resultMode = "started";
      body.entry.action = "Baskı başlatıldı";
    } else {
      replacePrinter(state, { ...printer, queue: [...printer.queue, job] });
      body.resultMode = "queued";
      body.entry.action = "Sıraya eklendi";
    }
    return;
  }

  if (action === "startQueuedJob") {
    if (printer.status !== "free") throw new Error("Yazıcı şu anda uygun değil");
    const [job, ...rest] = printer.queue;
    if (!job) throw new Error("Sırada başlatılacak iş yok");
    const startedAt = Date.now();
    const endsAt = startedAt + minutes(job.duration) * 60000;
    const conflict = busyConflict(printer, startedAt, endsAt);
    if (conflict) throw new Error(`Bu iş şu anda başlatılırsa ${conflict} ile çakışır`);
    replacePrinter(state, { ...printer, queue: rest, status: "printing", job: job.name, owner: job.owner, duration: minutes(job.duration), startedAt, endsAt });
    return;
  }

  if (action === "clearFinished") {
    if (printer.status !== "finished") throw new Error("Bu baskı henüz tamamlanmadı");
    const completedPrint = printer.startedAt && printer.endsAt ? {
      id: `print-${crypto.randomUUID()}`,
      label: printer.job,
      owner: printer.owner,
      startAt: Number(printer.startedAt),
      endAt: Number(printer.endsAt),
    } : null;
    const next = {
      ...printer,
      status: "free",
      printHistory: completedPrint ? [...printer.printHistory, completedPrint].slice(-100) : printer.printHistory,
    };
    delete next.job;
    delete next.owner;
    delete next.duration;
    delete next.startedAt;
    delete next.endsAt;
    replacePrinter(state, next);
    return;
  }

  if (action === "cancelCurrentPrint") {
    if (printer.status !== "printing") throw new Error("İptal edilecek devam eden baskı bulunamadı");
    const next = { ...printer, status: "free" };
    delete next.job;
    delete next.owner;
    delete next.duration;
    delete next.startedAt;
    delete next.endsAt;
    replacePrinter(state, next);
    return;
  }

  if (action === "editPrinter") {
    const next = { ...printer, name: requireText(body.name, "Yazıcı adı"), color: body.color || printer.color };
    if (printer.job && body.jobName !== undefined) next.job = requireText(body.jobName, "İş adı");
    replacePrinter(state, next);
    return;
  }

  if (action === "editQueueJob") {
    const nextQueue = printer.queue.map(job => job.id === body.jobId ? {
      ...job,
      name: requireText(body.name, "İş adı"),
      duration: minutes(body.duration),
    } : job);
    if (!nextQueue.some(job => job.id === body.jobId)) throw new Error("Sıra işi bulunamadı");
    replacePrinter(state, { ...printer, queue: nextQueue });
    return;
  }

  if (action === "deleteQueueJob") {
    replacePrinter(state, { ...printer, queue: printer.queue.filter(job => job.id !== body.jobId) });
    return;
  }

  if (action === "setMaintenance") {
    const requested = ["maintenance", "broken", "free"].includes(body.status)
      ? body.status
      : body.active ? "maintenance" : "free";
    if (requested !== "free" && printer.status === "printing") throw new Error("Devam eden baskı varken servis durumu değiştirilemez");
    const next = { ...printer, status: requested };
    if (requested !== "free") next.maintenanceNote = requireText(body.note, requested === "broken" ? "Arıza açıklaması" : "Bakım nedeni");
    else delete next.maintenanceNote;
    replacePrinter(state, next);
    return;
  }

  if (action === "addReservation" || action === "addScheduledPrint") {
    if (["maintenance", "broken"].includes(printer.status)) throw new Error(printer.status === "broken" ? "Arızalı yazıcı rezerve edilemez" : "Bakımdaki yazıcı rezerve edilemez");
    const savedJob = action === "addScheduledPrint" && body.savedJobId
      ? state.savedJobs.find(item => item.id === body.savedJobId)
      : null;
    if (body.savedJobId && !savedJob) throw new Error("Kayıtlı iş bulunamadı");
    const startAt = Number(body.reservation?.startAt);
    const reservation = {
      id: crypto.randomUUID(),
      purpose: requireText(body.reservation?.purpose, "Amaç"),
      owner: requireText(body.reservation?.owner, "Ad"),
      startAt,
      endAt: savedJob ? startAt + minutes(savedJob.duration) * 60000 : Number(body.reservation?.endAt),
      kind: action === "addScheduledPrint" ? "scheduled" : "reservation",
    };
    if (!Number.isFinite(reservation.startAt) || !Number.isFinite(reservation.endAt) || reservation.endAt <= reservation.startAt) throw new Error("Rezervasyon zamanı geçersiz");
    if (reservation.startAt < Date.now() - 60000) throw new Error("Geçmiş bir saate rezervasyon yapılamaz");
    const conflict = busyConflict(printer, reservation.startAt, reservation.endAt, { includeQueue: true });
    if (conflict) throw new Error(`Seçilen zaman ${conflict} ile çakışıyor`);
    replacePrinter(state, { ...printer, reservations: [...printer.reservations, reservation].sort((a, b) => a.startAt - b.startAt) });
    body.createdReservation = reservation;
    return;
  }

  if (action === "deleteReservation") {
    replacePrinter(state, { ...printer, reservations: printer.reservations.filter(item => item.id !== body.reservationId) });
    return;
  }

  if (action === "editReservation") {
    const existing = printer.reservations.find(item => item.id === body.reservationId);
    if (!existing) throw new Error("Planlanan iş bulunamadı");
    const startAt = Number(body.startAt);
    const endAt = Number(body.endAt);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error("Planlanan zaman geçersiz");
    if (startAt < Date.now() - 60000) throw new Error("Geçmiş bir saate planlama yapılamaz");
    const conflict = busyConflict(printer, startAt, endAt, { includeQueue: true, ignoreReservationId: existing.id });
    if (conflict) throw new Error(`Seçilen zaman ${conflict} ile çakışıyor`);
    replacePrinter(state, {
      ...printer,
      reservations: printer.reservations.map(item => item.id === existing.id ? {
        ...item,
        purpose: requireText(body.purpose, "İş adı"),
        startAt,
        endAt,
      } : item).sort((a, b) => a.startAt - b.startAt),
    });
    return;
  }

  throw new Error("Geçersiz işlem");
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "D1 veritabanı bağlantısı eksik. DB bağlantısını ekleyip yeniden yayınlayın." }, 500);
  try {
    const [state, user] = await Promise.all([readState(env.DB), currentUser(request, env.DB)]);
    return json(stateForUser(state, user));
  } catch (error) {
    return json({ error: error.message || "Veritabanı hatası" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "D1 veritabanı bağlantısı eksik. DB bağlantısını ekleyip yeniden yayınlayın." }, 500);
  if (!validateSameOrigin(request)) return json({ error: "Geçersiz istek kaynağı" }, 403);
  try {
    const user = await currentUser(request, env.DB);
    if (!user) return json({ error: "Değişiklik yapmak için giriş yapın", code: "AUTH_REQUIRED" }, 401);
    const body = await request.json();
    const state = await readState(env.DB);

    if (body.action === "reorderPrinters") {
      const existingIds = new Set(state.printers.map(printer => printer.id));
      const order = [...new Set(Array.isArray(body.order) ? body.order.map(String) : [])]
        .filter(id => existingIds.has(id));
      if (order.length !== existingIds.size) {
        state.printers.forEach(printer => {
          if (!order.includes(printer.id)) order.push(printer.id);
        });
      }
      await env.DB.prepare("UPDATE users SET printer_order=? WHERE id=?")
        .bind(JSON.stringify(order), user.id).run();
      user.printerOrder = order;
      return json({ ok: true, state: stateForUser(state, user) });
    }

    if (!user.canEdit) return json({ error: "Hesabınız henüz değişiklik yapmak için onaylanmadı", code: "APPROVAL_REQUIRED" }, 403);
    body.entry = { ...(body.entry || {}), user: user.name };
    if (body.job) body.job.owner = user.name;
    if (body.reservation) body.reservation.owner = user.name;
    applyAction(state, body);
    body.entry = {
      id: crypto.randomUUID(),
      action: requireText(body.entry?.action, "İşlem"),
      detail: String(body.entry?.detail || "").trim(),
      user: user.name,
      at: Date.now(),
    };
    state.activity.unshift(body.entry);
    await writeState(env.DB, state);
    return json({ ok: true, mode: body.resultMode, state: stateForUser(state, user) });
  } catch (error) {
    const status = /çakış|uygun değil|geçmiş|devam eden/.test(error.message || "") ? 409 : 400;
    return json({ error: error.message || "Veritabanı hatası" }, status);
  }
}

export async function onAuthRequest({ request, env }) {
  if (!env.DB) return json({ error: "D1 veritabanı bağlantısı eksik." }, 500);
  await ensureAuthTables(env.DB);

  if (request.method === "GET") {
    return json({ user: await currentUser(request, env.DB) });
  }
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405, { Allow: "GET, POST" });
  if (!validateSameOrigin(request)) return json({ error: "Geçersiz istek kaynağı" }, 403);

  try {
    const body = await request.json();
    const mode = String(body.mode || "");

    if (mode === "logout") {
      const token = sessionTokenFromRequest(request);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
      return json({ ok: true, user: null }, 200, { "Set-Cookie": clearSessionCookie() });
    }

    const name = requireText(body.name, "Ad");
    const nameKey = name.toLocaleLowerCase("tr-TR");
    const password = String(body.password || "");
    if (name.length < 2 || name.length > 80) throw new Error("Ad 2–80 karakter olmalıdır");
    if (password.length < 6 || password.length > 128) throw new Error("Şifre 6–128 karakter olmalıdır");

    let user;
    if (mode === "register") {
      if (password !== String(body.passwordRepeat || "")) throw new Error("Şifreler eşleşmiyor");
      const existing = await env.DB.prepare("SELECT id FROM users WHERE name_key=?").bind(nameKey).first();
      if (existing) return json({ error: "Bu adla bir hesap zaten var" }, 409);
      const salt = randomToken(18);
      user = { id: crypto.randomUUID(), name, can_edit: 0 };
      await env.DB.prepare("INSERT INTO users (id,name,name_key,password_hash,salt,can_edit,created_at) VALUES (?,?,?,?,?,0,?)")
        .bind(user.id, name, nameKey, await passwordHash(password, salt), salt, Date.now()).run();
    } else if (mode === "login") {
      user = await env.DB.prepare("SELECT id,name,password_hash,salt,can_edit,printer_order FROM users WHERE name_key=?").bind(nameKey).first();
      const attempted = await passwordHash(password, user?.salt || "invalid-user-salt");
      if (!user || !safeEqual(attempted, user.password_hash)) return json({ error: "Ad veya şifre yanlış" }, 401);
    } else {
      throw new Error("Geçersiz kimlik doğrulama işlemi");
    }

    const session = await createSession(env.DB, user.id, Boolean(body.remember));
    const cookie = sessionCookie(session.token, session.remember ? session.lifetime : undefined);
    return json({
      ok: true,
      user: publicUser(user),
      sessionToken: session.token,
      remember: session.remember,
    }, 200, { "Set-Cookie": cookie });
  } catch (error) {
    return json({ error: error.message || "Kimlik doğrulama hatası" }, 400);
  }
}

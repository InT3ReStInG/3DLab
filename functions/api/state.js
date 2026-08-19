const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

const overlaps = (startA, endA, startB, endB) => startA < endB && endA > startB;
const minutes = value => Math.max(1, Math.round(Number(value) || 1));

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
  await db.prepare("CREATE TABLE IF NOT EXISTS lab_state (id INTEGER PRIMARY KEY, printers TEXT NOT NULL, activity TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
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
  await db.prepare("INSERT INTO lab_state (id,printers,activity,updated_at) VALUES (1,?,?,?)")
    .bind(JSON.stringify(printers), JSON.stringify(activity), now).run();
}

async function readState(db) {
  await ensureTable(db);
  const row = await db.prepare("SELECT printers,activity FROM lab_state WHERE id=1").first();
  const state = {
    printers: JSON.parse(row.printers).map(normalizePrinter),
    activity: JSON.parse(row.activity),
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
  await db.prepare("UPDATE lab_state SET printers=?,activity=?,updated_at=? WHERE id=1")
    .bind(JSON.stringify(state.printers), JSON.stringify(state.activity.slice(0, 500)), Date.now()).run();
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

  if (action === "startJob") {
    if (printer.status === "maintenance") throw new Error("Bakımdaki yazıcıya iş eklenemez");
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
    const active = Boolean(body.active);
    if (active && printer.status === "printing") throw new Error("Devam eden baskı varken bakım modu açılamaz");
    const next = { ...printer, status: active ? "maintenance" : "free" };
    if (active) next.maintenanceNote = requireText(body.note, "Bakım nedeni");
    else delete next.maintenanceNote;
    replacePrinter(state, next);
    return;
  }

  if (action === "addReservation" || action === "addScheduledPrint") {
    if (printer.status === "maintenance") throw new Error("Bakımdaki yazıcı rezerve edilemez");
    const reservation = {
      id: crypto.randomUUID(),
      purpose: requireText(body.reservation?.purpose, "Amaç"),
      owner: requireText(body.reservation?.owner, "Ad"),
      startAt: Number(body.reservation?.startAt),
      endAt: Number(body.reservation?.endAt),
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

  throw new Error("Geçersiz işlem");
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "D1 veritabanı bağlantısı eksik. DB bağlantısını ekleyip yeniden yayınlayın." }, 500);
  try {
    return json(await readState(env.DB));
  } catch (error) {
    return json({ error: error.message || "Veritabanı hatası" }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: "D1 veritabanı bağlantısı eksik. DB bağlantısını ekleyip yeniden yayınlayın." }, 500);
  try {
    const state = await readState(env.DB);
    const body = await request.json();
    if (!body.entry?.user?.trim()) return json({ error: "Adınızı girmeniz gerekiyor" }, 400);
    applyAction(state, body);
    state.activity.unshift(body.entry);
    await writeState(env.DB, state);
    return json({ ok: true, mode: body.resultMode, state });
  } catch (error) {
    const status = /çakış|uygun değil|geçmiş|devam eden/.test(error.message || "") ? 409 : 400;
    return json({ error: error.message || "Veritabanı hatası" }, status);
  }
}

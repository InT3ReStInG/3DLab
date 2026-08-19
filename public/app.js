const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

let printers = [];
let activity = [];
let savedJobs = [];
let tab = "fleet";
let reorderMode = false;
let reorderActor = "";
let reorderOriginal = [];
let reorderDrag = null;
let reorderScrollFrame = null;
let calendarMode = "day";
let calendarDate = startOfDay(new Date());
let calendarSelectedPrinters = new Set();
let calendarKnownPrinters = new Set();
let calendarFilterInitialized = false;
let calendarScroll = { top: 0, left: 0 };
let calendarShouldFocusNow = true;
let rememberedActor = "";
let pendingSavedJobId = null;

try { rememberedActor = sessionStorage.getItem("pl750-actor") || ""; } catch (_) {}

const statusText = {
  free: "UYGUN",
  printing: "BASKI YAPIYOR",
  finished: "TAMAMLANDI",
  maintenance: "BAKIMDA",
  broken: "ARIZALI",
};

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, count) {
  const date = new Date(value);
  date.setDate(date.getDate() + count);
  return date;
}

function dateValue(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function timeValue(value) {
  return new Date(value).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

function dateTime(value) {
  return new Date(value).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}

function makeId() {
  const cryptoApi = window.crypto || window.msCrypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `pl750-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function updateHeaderClock() {
  const now = new Date();
  $("#headerTime").textContent = now.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#headerDate").textContent = now.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const calendarTodayDate = $("#calendarTodayDate");
  if (calendarTodayDate) calendarTodayDate.textContent = `Bugün · ${now.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" })}`;
}

function remaining(at) {
  if (!at) return "—";
  const total = Math.ceil((at - Date.now()) / 60000);
  if (total <= 0) return "Tamamlandı";
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours ? `${hours} sa ${mins} dk` : `${mins} dk`;
}

function printStartedAt(printer) {
  if (Number(printer.startedAt)) return Number(printer.startedAt);
  const matches = activity.filter(entry =>
    Number(entry.at) <= Number(printer.endsAt)
    && /Baskı başlatıldı|Sıradaki baskı başlatıldı/.test(String(entry.action || ""))
    && String(entry.detail || "").includes(String(printer.job || ""))
  );
  const strictMatch = matches.find(entry => String(entry.detail || "").includes(String(printer.name || "")));
  if (strictMatch?.at || matches[0]?.at) return Number(strictMatch?.at || matches[0].at);
  if (printer.duration) return Number(printer.endsAt) - Number(printer.duration) * 60000;
  return null;
}

function printProgress(printer) {
  if (printer.status === "finished") return 100;
  const startAt = printStartedAt(printer);
  const endAt = Number(printer.endsAt);
  if (!startAt || !endAt || endAt <= startAt) return 0;
  return Math.max(0, Math.min(100, Math.round((Date.now() - startAt) / (endAt - startAt) * 100)));
}

function durationText(total) {
  const value = Math.max(1, Number(total) || 1);
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return hours ? `${hours} sa ${mins ? `${mins} dk` : ""}`.trim() : `${mins} dk`;
}

function relative(at) {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "az önce";
  if (mins < 60) return `${mins} dk önce`;
  if (mins < 1440) return `${Math.round(mins / 60)} sa önce`;
  return new Date(at).toLocaleDateString("tr-TR");
}

function makeEntry(action, detail, user) {
  return { id: makeId(), action, detail, user: user.trim(), at: Date.now() };
}

function samePerson(first, second) {
  const clean = value => String(value || "").trim().replace(/\s+/g, " ");
  return clean(first).localeCompare(clean(second), "tr", { sensitivity: "base" }) === 0;
}

function rememberActor(value) {
  const actor = String(value || "").trim();
  if (!actor) return;
  rememberedActor = actor;
  try { sessionStorage.setItem("pl750-actor", actor); } catch (_) {}
}

async function api(body) {
  const options = body ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } : {};
  const response = await fetch("/api/state", options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Değişiklik kaydedilemedi");
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3000);
}

async function load(silent = false) {
  if (silent && reorderMode) return;
  try {
    const data = await api();
    printers = (data.printers || []).map(normalizePrinter);
    activity = data.activity || [];
    savedJobs = Array.isArray(data.savedJobs) ? data.savedJobs : [];
    render();
  } catch (error) {
    if (!silent) toast(error.message);
  }
}

function normalizePrinter(printer) {
  return {
    ...printer,
    queue: Array.isArray(printer.queue) ? printer.queue : [],
    reservations: Array.isArray(printer.reservations) ? printer.reservations : [],
    printHistory: Array.isArray(printer.printHistory) ? printer.printHistory : [],
  };
}

async function mutate(action, payload, entry, successMessage = "Kaydedildi") {
  try {
    const data = await api({ action, ...payload, entry });
    printers = (data.state?.printers || printers).map(normalizePrinter);
    activity = data.state?.activity || activity;
    savedJobs = Array.isArray(data.state?.savedJobs) ? data.state.savedJobs : savedJobs;
    render();
    toast(successMessage);
    return data;
  } catch (error) {
    toast(error.message);
    throw error;
  }
}

function queueSlots(printer) {
  let cursor = printer.status === "printing" && printer.endsAt > Date.now() ? printer.endsAt : Date.now();
  const reservations = printer.reservations
    .filter(item => item.endAt > Date.now())
    .sort((a, b) => a.startAt - b.startAt);

  return printer.queue.map(job => {
    const length = Math.max(1, Number(job.duration) || 1) * 60000;
    for (const reservation of reservations) {
      if (reservation.endAt <= cursor) continue;
      if (cursor + length <= reservation.startAt) break;
      cursor = Math.max(cursor, reservation.endAt);
    }
    const slot = { ...job, printerId: printer.id, printer: printer.name, color: printer.color, startAt: cursor, endAt: cursor + length };
    cursor = slot.endAt;
    return slot;
  });
}

function queueRows() {
  return printers.flatMap(printer => queueSlots(printer));
}

function plannedRows() {
  return printers.flatMap(printer => {
    if (["maintenance", "broken"].includes(printer.status)) return [];
    const queued = queueSlots(printer).map(item => ({ ...item, type: "queue" }));
    const reservations = printer.reservations
      .filter(item => item.endAt > Date.now())
      .map(item => ({
        ...item,
        type: item.kind === "scheduled" ? "scheduled" : "reservation",
        name: item.purpose,
        duration: Math.max(1, Math.round((item.endAt - item.startAt) / 60000)),
        printerId: printer.id,
        printer: printer.name,
        color: printer.color,
        reservationId: item.id,
      }));
    return [...queued, ...reservations];
  }).sort((a, b) => a.startAt - b.startAt);
}

function mergedBusyIntervals(printer) {
  const intervals = scheduleEvents(printer)
    .filter(item => item.endAt > Date.now())
    .map(item => ({ startAt: Math.max(item.startAt, Date.now()), endAt: item.endAt }))
    .sort((a, b) => a.startAt - b.startAt);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.startAt <= previous.endAt) previous.endAt = Math.max(previous.endAt, interval.endAt);
    else merged.push({ ...interval });
  }
  return merged;
}

function friendlyAvailabilityTime(value) {
  const date = new Date(value);
  const today = startOfDay(new Date()).getTime();
  const targetDay = startOfDay(date).getTime();
  const prefix = targetDay === today ? "Bugün" : targetDay === addDays(today, 1).getTime() ? "Yarın" : date.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  return `${prefix} ${timeValue(date)}`;
}

function availabilitySummary(printer) {
  if (printer.status === "maintenance") return "Bakımda · uygunluk zamanı bilinmiyor";
  if (printer.status === "broken") return "Arızalı · uygunluk zamanı bilinmiyor";
  const now = Date.now();
  const twoDays = 48 * 60 * 60000;
  const intervals = mergedBusyIntervals(printer);
  let availableAt = now;
  let index = 0;

  while (index < intervals.length && intervals[index].startAt <= availableAt + 60000) {
    availableAt = Math.max(availableAt, intervals[index].endAt);
    index += 1;
  }
  while (index < intervals.length && intervals[index].endAt <= availableAt) index += 1;
  const nextBusyAt = intervals[index]?.startAt;
  const availableFor = nextBusyAt ? nextBusyAt - availableAt : Infinity;

  if (availableAt <= now + 1000 && availableFor >= twoDays) return "Önümüzdeki 2 gün planlanmış baskı yok";
  const startText = availableAt <= now + 1000 ? "Şimdi uygun" : `Sonraki uygun: ${friendlyAvailabilityTime(availableAt)}`;
  if (availableFor >= twoDays) return `${startText} · en az 2 gün uygun`;
  return `${startText} · ${durationText(Math.max(1, Math.ceil(availableFor / 60000)))} uygun`;
}

function approachingPlan(printer) {
  const now = Date.now();
  return [...printer.reservations]
    .filter(item => item.startAt > now && item.startAt - now <= 60 * 60000)
    .sort((a, b) => a.startAt - b.startAt)[0] || null;
}

function approachingPlanText(printer) {
  const plan = approachingPlan(printer);
  if (!plan) return "";
  const type = plan.kind === "scheduled" ? "Planlı baskı" : "Rezervasyon";
  return `${type} ${remaining(plan.startAt)} sonra: ${plan.purpose}`;
}

function render() {
  printers = printers.map(printer => printer.status === "printing" && printer.endsAt <= Date.now()
    ? { ...printer, status: "finished" }
    : printer);

  const counts = {
    free: printers.filter(printer => printer.status === "free").length,
    printing: printers.filter(printer => printer.status === "printing").length,
    attention: printers.filter(printer => ["finished", "maintenance", "broken"].includes(printer.status)).length,
  };
  $("#stats").innerHTML = `
    <div class="stat"><b>${counts.free}</b><span>Uygun</span></div>
    <div class="stat"><b>${counts.printing}</b><span>Baskıda</span></div>
    <div class="stat"><b>${counts.attention}</b><span>İlgilenilmeli</span></div>`;

  const rows = plannedRows();
  const printed = completedPrintRows();
  $("#queueCount").textContent = rows.length;
  $("#savedJobCount").textContent = savedJobs.length;
  $("#printHistoryCount").textContent = printed.length;
  $("#printerRail").classList.toggle("is-reordering", reorderMode);
  $("#printerRail").innerHTML = printers.map((printer, index) => card(printer, index)).join("")
    + (reorderMode ? "" : `<button class="add-card" data-add><i>＋</i><b>YAZICI EKLE</b><small>Yeni cihaz kaydet</small></button>`);
  $("#recentActivity").innerHTML = activity.slice(0, 5).map(item => activityRow(item, false)).join("") || empty("Henüz işlem yok");
  $("#allActivity").innerHTML = activity.map(item => activityRow(item, true)).join("") || empty("Henüz işlem yok");
  $("#shortQueue").innerHTML = printers.filter(printer => !["maintenance", "broken"].includes(printer.status)).map(nextPrinterRow).join("") || empty("Gösterilecek yazıcı yok");
  $("#allQueue").innerHTML = rows.map((item, index) => plannedRow(item, index)).join("") || empty("Planlanmış iş yok");
  $("#savedJobs").innerHTML = savedJobs.map(savedJobRow).join("") || empty("Henüz kayıtlı iş yok");
  $("#printedJobs").innerHTML = printed.map(printedJobRow).join("") || empty("Henüz tamamlanan baskı kaydı yok");
  $("#reorderButton").textContent = reorderMode ? "Sıralamayı kaydet" : "↕ Sıralamayı düzenle";
  $("#cancelReorder").classList.toggle("hidden", !reorderMode);
  $("#reorderHint").textContent = reorderMode ? "Kartı sürükleyin; kenara götürünce liste otomatik kayar." : "Kartlara basarak baskı ekleyebilirsiniz.";
  renderCalendar();
  bindDynamicControls();
}

function card(printer, index) {
  const serviceLocked = ["maintenance", "broken"].includes(printer.status);
  const icon = printer.status === "printing"
    ? `<i class="state-spinner" aria-hidden="true"></i><em class="state-symbol">▣</em><b>${remaining(printer.endsAt)}</b>`
    : printer.status === "finished"
    ? `<em class="state-check" aria-label="Baskı tamamlandı">✓</em>`
    : printer.status === "maintenance"
    ? `<em class="state-symbol">⚙</em>`
    : printer.status === "broken"
    ? `<em class="state-broken" aria-label="Arızalı">×</em>`
    : `<em class="state-symbol">▣</em>`;
  const queueNote = printer.queue.length ? `<span class="queue-note">${printer.queue.length} iş sırada</span>` : "";
  const warningText = ["maintenance", "broken"].includes(printer.status) ? "" : approachingPlanText(printer);
  const planWarning = warningText ? `<span class="upcoming-warning">⚠ ${esc(warningText)}</span>` : "";
  const availability = `<span class="availability-line">${esc(availabilitySummary(printer))}</span>`;
  let body;
  if (printer.status === "free") {
    body = printer.queue.length
      ? `<p>${esc(printer.queue[0].name)}</p><span class="primary-action">▶ SIRADAKİ İŞİ BAŞLAT</span>${queueNote}${planWarning}${availability}`
      : `<p>Yeni bir iş için hazır</p><span class="primary-action">＋ BASKI EKLE</span>${planWarning}${availability}`;
  } else if (printer.status === "maintenance") {
    body = `<p>${esc(printer.maintenanceNote)}</p><span class="maintenance-action">SERVİS DIŞI</span>${availability}`;
  } else if (printer.status === "broken") {
    body = `<p>${esc(printer.maintenanceNote)}</p><span class="broken-action">ARIZALI · SERVİS DIŞI</span>${availability}`;
  } else {
    const progress = printProgress(printer);
    body = `<p class="job">${esc(printer.job)}</p><span class="owner">◯ ${esc(printer.owner)}</span><div class="progress"><i style="width:${progress}%"></i></div><div class="time-row"><span>İlerleme</span><b>%${progress}</b></div><div class="time-row"><span>${printer.status === "finished" ? "Temizlenmeyi bekliyor" : "Tahmini kalan süre"}</span><b>${remaining(printer.endsAt)}</b></div>${queueNote}${planWarning}${availability}`;
  }

  const reorderControls = reorderMode ? `
    <div class="reorder-controls">
      <button data-move="-1" data-id="${printer.id}" ${index === 0 ? "disabled" : ""}>←</button>
      <span>⠿ Sürükle</span>
      <button data-move="1" data-id="${printer.id}" ${index === printers.length - 1 ? "disabled" : ""}>→</button>
    </div>` : "";

  return `<article class="printer-card status-${printer.status} ${reorderMode ? "reorder-mode" : ""}" data-printer="${printer.id}" draggable="false" style="--accent:${esc(printer.color)}">
    <div class="card-top"><span class="status"><i></i>${statusText[printer.status]}</span><button class="trash" data-delete="${printer.id}" aria-label="${esc(printer.name)} yazıcısını sil">⌫</button></div>
    <button class="printer-main" data-open="${printer.id}" aria-disabled="${reorderMode}"><div class="printer-icon"><span>${icon}</span></div><h3>${esc(printer.name)}</h3>${body}</button>
    ${reorderControls || `<div class="card-tools"><button data-reserve="${printer.id}" ${serviceLocked ? "disabled" : ""}>▦ Rezerve et</button><button data-edit-printer="${printer.id}">✎ Düzenle</button>${printer.status === "printing" ? `<button class="cancel-print" data-cancel-print="${printer.id}" aria-label="Mevcut baskıyı iptal et" title="Mevcut baskıyı iptal et">■</button>` : `<button data-maintenance="${printer.id}" aria-label="Servis durumu" title="Bakım / arıza durumu">⚙</button>`}</div>`}
  </article>`;
}

function activityRow(item, exact) {
  return `<div class="activity-row"><i class="activity-dot"></i><div><b>${esc(item.action)}</b><p>${esc(item.detail)}</p></div><div class="activity-meta"><b>${esc(item.user)}</b><span>${exact ? dateTime(item.at) : relative(item.at)}</span></div></div>`;
}

function nextPrinterRow(printer) {
  const next = plannedRows().find(item => item.printerId === printer.id);
  const content = printer.status === "finished"
    ? `<b>Temizlenmeyi bekliyor</b><span>Baskı tamamlandı</span>`
    : next
    ? `<b>${esc(next.name)}</b><span>${next.type === "reservation" ? "Rezervasyon" : next.type === "scheduled" ? "Planlı baskı" : "Sıradaki iş"} · ${esc(next.owner)}</span><small>${dateTime(next.startAt)} → ${timeValue(next.endAt)}</small>`
    : `<b>Uygun</b><span>${esc(availabilitySummary(printer))}</span>`;
  return `<div class="next-printer-row"><i style="background:${esc(printer.color)}"></i><div class="next-printer-name"><b>${esc(printer.name)}</b></div><div class="next-printer-job">${content}</div></div>`;
}

function plannedRow(item, index) {
  const type = item.type === "reservation" ? "Rezervasyon" : item.type === "scheduled" ? "Planlı baskı" : "Sıra";
  const actions = ["reservation", "scheduled"].includes(item.type)
    ? `<div class="row-actions"><button class="danger-link" data-cancel-reservation="${item.printerId}" data-reservation="${item.reservationId}">İptal et</button></div>`
    : `<div class="row-actions"><button data-edit-queue="${item.printerId}" data-job="${item.id}">Düzenle</button><button class="danger-link" data-delete-queue="${item.printerId}" data-job="${item.id}">Sil</button></div>`;
  return `<div class="queue-row"><span>${String(index + 1).padStart(2, "0")}</span><i style="background:${esc(item.color)}"></i><div><b>${esc(item.name)}</b><span>${type} · ${esc(item.owner)} · ${esc(item.printer)}</span><small>${dateTime(item.startAt)} → ${timeValue(item.endAt)}</small></div><strong>${durationText(item.duration)}</strong>${actions}</div>`;
}

function completedPrintRows() {
  return printers.flatMap(printer => printer.printHistory.map(item => ({
    ...item,
    printerId: printer.id,
    printer: printer.name,
    color: printer.color,
    duration: Math.max(1, Math.round((Number(item.endAt) - Number(item.startAt)) / 60000)),
  }))).sort((a, b) => Number(b.endAt) - Number(a.endAt));
}

function savedJobRow(job) {
  const created = job.createdAt ? `${esc(job.createdBy || "—")} · ${dateTime(job.createdAt)}` : "Kayıtlı iş";
  return `<div class="saved-job-row"><div class="saved-job-icon">▣</div><div><b>${esc(job.name)}</b><span>${durationText(job.duration)}</span><small>${created}</small></div><div class="row-actions"><button data-use-saved="${job.id}">Takvimde kullan</button><button data-edit-saved="${job.id}">Düzenle</button><button class="danger-link" data-delete-saved="${job.id}">Sil</button></div></div>`;
}

function printedJobRow(item) {
  return `<button class="printed-job-row" data-printed-info="${item.printerId}" data-print-id="${item.id}"><i style="background:${esc(item.color)}"></i><div><b>${esc(item.label || item.job)}</b><span>${esc(item.printer)} · ${esc(item.owner || "—")}</span><small>${dateTime(item.startAt)} → ${dateTime(item.endAt)}</small></div><strong>${durationText(item.duration)}</strong><em>Bilgi →</em></button>`;
}

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

function scheduleEvents(printer) {
  const events = [];
  printer.printHistory.forEach(item => events.push({ ...item, type: "print", label: item.label || item.job, archived: true }));
  if (["printing", "finished"].includes(printer.status) && printer.endsAt) {
    const recoveredStart = printStartedAt(printer);
    const fallbackStart = printer.status === "printing" ? Math.min(Date.now(), printer.endsAt) : printer.endsAt - 60000;
    events.push({ type: "print", label: printer.job, owner: printer.owner, startAt: recoveredStart || fallbackStart, endAt: printer.endsAt, active: printer.status === "printing" });
  }
  printer.reservations.forEach(item => events.push({ ...item, type: item.kind === "scheduled" ? "scheduled" : "reservation", label: item.purpose, reservationId: item.id }));
  queueSlots(printer).forEach(item => events.push({ ...item, type: "queue", label: item.name }));
  return events.sort((a, b) => a.startAt - b.startAt);
}

function mondayOf(value) {
  const date = startOfDay(value);
  const day = date.getDay() || 7;
  return addDays(date, 1 - day);
}

function syncCalendarFilter() {
  const ids = printers.map(printer => printer.id);
  if (!calendarFilterInitialized) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem("pl750-calendar-printers") || "[]"); } catch (_) {}
    const validSaved = saved.filter(id => ids.includes(id));
    calendarSelectedPrinters = new Set(validSaved.length ? validSaved : ids);
    calendarKnownPrinters = new Set(ids);
    calendarFilterInitialized = true;
    return;
  }
  ids.forEach(id => {
    if (!calendarKnownPrinters.has(id)) calendarSelectedPrinters.add(id);
  });
  calendarSelectedPrinters = new Set([...calendarSelectedPrinters].filter(id => ids.includes(id)));
  calendarKnownPrinters = new Set(ids);
  if (!calendarSelectedPrinters.size && ids.length) calendarSelectedPrinters.add(ids[0]);
}

function saveCalendarFilter() {
  try { localStorage.setItem("pl750-calendar-printers", JSON.stringify([...calendarSelectedPrinters])); } catch (_) {}
}

function renderCalendarFilters() {
  syncCalendarFilter();
  $("#calendarFilterLabel").textContent = `${calendarSelectedPrinters.size}/${printers.length}`;
  $("#calendarPrinterFilters").innerHTML = printers.map(printer => `<label><input type="checkbox" data-calendar-printer="${printer.id}" ${calendarSelectedPrinters.has(printer.id) ? "checked" : ""}><i style="background:${esc(printer.color)}"></i><span>${esc(printer.name)}</span></label>`).join("");
  document.querySelectorAll("[data-calendar-printer]").forEach(input => input.onchange = () => {
    if (input.checked) calendarSelectedPrinters.add(input.dataset.calendarPrinter);
    else if (calendarSelectedPrinters.size > 1) calendarSelectedPrinters.delete(input.dataset.calendarPrinter);
    else {
      input.checked = true;
      return toast("Takvimde en az bir yazıcı seçili olmalıdır");
    }
    saveCalendarFilter();
    renderCalendar();
  });
}

function renderCalendar() {
  renderCalendarFilters();
  const previousTimeline = $("#calendarTimeline");
  if (previousTimeline) calendarScroll = { top: previousTimeline.scrollTop, left: previousTimeline.scrollLeft };
  const dayCount = { day: 1, week: 7, twoWeeks: 14, threeWeeks: 21 }[calendarMode];
  const first = calendarMode === "day" ? startOfDay(calendarDate) : addDays(startOfDay(calendarDate), -2);
  const end = addDays(first, dayCount);
  const totalHours = dayCount * 24;
  const hourWidth = { day: 44, week: 12, twoWeeks: 8, threeWeeks: 7 }[calendarMode];
  const selected = printers.filter(printer => calendarSelectedPrinters.has(printer.id));
  $("#calendarDay").classList.toggle("active", calendarMode === "day");
  $("#calendarWeek").classList.toggle("active", calendarMode === "week");
  $("#calendarTwoWeeks").classList.toggle("active", calendarMode === "twoWeeks");
  $("#calendarThreeWeeks").classList.toggle("active", calendarMode === "threeWeeks");
  $("#calendarTitle").textContent = calendarMode === "day"
    ? calendarDate.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : `${first.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} – ${addDays(first, dayCount - 1).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" })}`;
  const timeWidth = totalHours * hourWidth;
  const minWidth = 150 + timeWidth;
  const rangeStart = first.getTime();
  const rangeEnd = end.getTime();
  const now = Date.now();
  const nowLeft = (now - rangeStart) / 3600000 * hourWidth;
  const nowVisible = now >= rangeStart && now < rangeEnd;
  const dayLines = Array.from({ length: dayCount - 1 }, (_, index) => `<i class="horizontal-day-divider" style="left:${(index + 1) * 24 * hourWidth}px"></i>`).join("");
  const progressMarkers = nowVisible ? selected.map((printer, index) => {
    if (printer.status !== "printing" || !printer.endsAt || printer.endsAt <= now) return "";
    const progress = printProgress(printer);
    return `<b class="horizontal-now-progress" style="top:${index * 86 + 43}px" title="${esc(printer.name)} · %${progress} tamamlandı">%${progress}</b>`;
  }).join("") : "";
  const nowLine = nowVisible ? `<i class="horizontal-now-line" style="left:${nowLeft}px"><span>Şimdi · ${timeValue(now)}</span>${progressMarkers}</i>` : "";

  $("#calendarGrid").innerHTML = selected.length ? `<div class="timeline-scroll horizontal ${calendarMode}" id="calendarTimeline"><div class="horizontal-board" style="--printer-count:${selected.length};--hour-width:${hourWidth}px;--time-width:${timeWidth}px;--timeline-min-width:${minWidth}px"><div class="horizontal-corner">Yazıcı</div><div class="horizontal-time-head">${horizontalTimeScale(first, totalHours, hourWidth)}</div><div class="horizontal-printer-labels">${selected.map(horizontalPrinterLabel).join("")}</div><div class="horizontal-lanes">${selected.map(printer => horizontalLane(printer, rangeStart, rangeEnd, hourWidth)).join("")}${dayLines}${nowLine}</div></div></div>` : empty("En az bir yazıcı seçin");

  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = event => { event.stopPropagation(); cancelReservation(button.dataset.cancelReservation, button.dataset.reservation); });
  document.querySelectorAll("[data-active-calendar-print]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); activePrintInfo(eventElement.dataset.activeCalendarPrint); });
  document.querySelectorAll("[data-calendar-print-history]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); printHistoryInfo(eventElement.dataset.historyPrinter, eventElement.dataset.calendarPrintHistory); });
  document.querySelectorAll("[data-calendar-scheduled]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); scheduledPrintInfo(eventElement.dataset.scheduledPrinter, eventElement.dataset.calendarScheduled); });
  document.querySelectorAll("[data-calendar-lane]").forEach(lane => lane.onclick = event => {
    if (event.target.closest(".horizontal-event")) return;
    const rect = lane.getBoundingClientRect();
    const clickedHours = (event.clientX - rect.left) / hourWidth;
    const rawStart = rangeStart + clickedHours * 3600000;
    const startAt = Math.round(rawStart / 900000) * 900000;
    if (startAt < Date.now() - 60000) return toast("Geçmiş bir saate baskı planlanamaz");
    scheduledPrintForm(lane.dataset.calendarLane, startAt);
  });
  requestAnimationFrame(() => {
    const timeline = $("#calendarTimeline");
    if (!timeline) return;
    if (calendarShouldFocusNow) {
      const selectedOffset = (startOfDay(calendarDate).getTime() - rangeStart) / 3600000 * hourWidth;
      const focusLeft = nowVisible ? nowLeft : selectedOffset + 8 * hourWidth;
      timeline.scrollLeft = Math.max(0, focusLeft - timeline.clientWidth * .32);
      timeline.scrollTop = calendarScroll.top;
    } else {
      timeline.scrollTop = calendarScroll.top;
      timeline.scrollLeft = calendarScroll.left;
    }
    calendarShouldFocusNow = false;
    timeline.onscroll = () => { calendarScroll = { top: timeline.scrollTop, left: timeline.scrollLeft }; };
  });
}

function horizontalTimeScale(first, totalHours, hourWidth) {
  const dayCount = totalHours / 24;
  const labelEvery = calendarMode === "day" ? 1 : calendarMode === "week" ? 3 : 6;
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = addDays(first, index);
    return `<div style="width:${24 * hourWidth}px">${date.toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" })}</div>`;
  }).join("");
  const hours = Array.from({ length: totalHours }, (_, index) => {
    const date = new Date(first.getTime() + index * 3600000);
    return `<div style="width:${hourWidth}px">${index % labelEvery === 0 ? `${String(date.getHours()).padStart(2, "0")}:00` : ""}</div>`;
  }).join("");
  return `<div class="horizontal-days">${days}</div><div class="horizontal-hours">${hours}</div>`;
}

function horizontalPrinterLabel(printer) {
  return `<div><i style="background:${esc(printer.color)}"></i><span><b>${esc(printer.name)}</b><small>${esc(availabilitySummary(printer))}</small></span></div>`;
}

function horizontalLane(printer, rangeStart, rangeEnd, hourWidth) {
  if (["maintenance", "broken"].includes(printer.status)) {
    const width = (rangeEnd - rangeStart) / 3600000 * hourWidth;
    const broken = printer.status === "broken";
    return `<div class="horizontal-lane" data-calendar-lane="${printer.id}"><div class="horizontal-event ${broken ? "broken" : "maintenance"}" style="left:3px;width:${Math.max(30, width - 6)}px"><b>${broken ? "✕ Arızalı" : "Bakımda"}</b><span>${esc(printer.maintenanceNote || (broken ? "Servis dışı" : "Bakım modu"))}</span></div></div>`;
  }
  const events = scheduleEvents(printer)
    .filter(item => item.startAt < rangeEnd && item.endAt > rangeStart)
    .map(item => horizontalEvent(item, printer, rangeStart, rangeEnd, hourWidth))
    .join("");
  return `<div class="horizontal-lane" data-calendar-lane="${printer.id}" title="Boş alana tıklayarak baskı planlayın">${events}</div>`;
}

function horizontalEvent(item, printer, rangeStart, rangeEnd, hourWidth) {
  const clippedStart = Math.max(item.startAt, rangeStart);
  const clippedEnd = Math.min(item.endAt, rangeEnd);
  const left = (clippedStart - rangeStart) / 3600000 * hourWidth;
  const width = Math.max(28, (clippedEnd - clippedStart) / 3600000 * hourWidth);
  const typeText = { print: "Baskı", reservation: "Rezervasyon", scheduled: "Planlı baskı", queue: "Sıra" }[item.type];
  const fullRange = `${new Date(item.startAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} → ${new Date(item.endAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  const completed = item.endAt <= Date.now() && ["print", "scheduled"].includes(item.type);
  const upcoming = item.startAt > Date.now() && item.startAt - Date.now() <= 60 * 60000 && ["reservation", "scheduled"].includes(item.type);
  const cancel = item.type === "reservation" ? `<button data-cancel-reservation="${printer.id}" data-reservation="${item.reservationId}" aria-label="Rezervasyonu iptal et">×</button>` : "";
  const scheduledCancel = item.type === "scheduled" ? `<button data-cancel-reservation="${printer.id}" data-reservation="${item.reservationId}" aria-label="Planlı baskıyı iptal et">×</button>` : "";
  const interaction = item.active
    ? `data-active-calendar-print="${printer.id}"`
    : item.archived
    ? `data-calendar-print-history="${item.id}" data-history-printer="${printer.id}"`
    : item.type === "scheduled"
    ? `data-calendar-scheduled="${item.reservationId}" data-scheduled-printer="${printer.id}"`
    : "";
  return `<div class="horizontal-event ${item.type} ${completed ? "completed" : ""} ${upcoming ? "upcoming" : ""} ${interaction ? "interactive" : ""} ${width < 105 ? "compact" : ""}" ${interaction} style="left:${left + 2}px;width:${Math.max(24, width - 4)}px" title="${esc(item.label)} · ${esc(item.owner)} · ${esc(fullRange)}${completed ? " · Tamamlandı" : upcoming ? " · Bir saatten az kaldı" : ""}"><div><small>${completed ? "✓ Tamamlandı" : upcoming ? `⚠ ${remaining(item.startAt)} kaldı` : typeText} · ${esc(fullRange)}</small><b>${esc(item.label)}</b><span>${esc(item.owner)}</span></div>${completed ? "" : cancel || scheduledCancel}</div>`;
}

function bindDynamicControls() {
  document.querySelectorAll("[data-open]").forEach(button => button.onclick = () => openPrinter(button.dataset.open));
  document.querySelectorAll("[data-delete]").forEach(button => button.onclick = event => { event.stopPropagation(); removePrinter(button.dataset.delete); });
  document.querySelectorAll("[data-reserve]").forEach(button => button.onclick = () => reserveForm(button.dataset.reserve));
  document.querySelectorAll("[data-edit-printer]").forEach(button => button.onclick = () => editPrinterForm(button.dataset.editPrinter));
  document.querySelectorAll("[data-maintenance]").forEach(button => button.onclick = () => maintenanceForm(button.dataset.maintenance));
  document.querySelectorAll("[data-cancel-print]").forEach(button => button.onclick = () => cancelCurrentPrint(button.dataset.cancelPrint));
  document.querySelectorAll("[data-edit-queue]").forEach(button => button.onclick = () => editQueueForm(button.dataset.editQueue, button.dataset.job));
  document.querySelectorAll("[data-delete-queue]").forEach(button => button.onclick = () => deleteQueueJob(button.dataset.deleteQueue, button.dataset.job));
  document.querySelectorAll("[data-use-saved]").forEach(button => button.onclick = () => useSavedJob(button.dataset.useSaved));
  document.querySelectorAll("[data-edit-saved]").forEach(button => button.onclick = () => savedJobForm(button.dataset.editSaved));
  document.querySelectorAll("[data-delete-saved]").forEach(button => button.onclick = () => deleteSavedJob(button.dataset.deleteSaved));
  document.querySelectorAll("[data-printed-info]").forEach(button => button.onclick = () => printHistoryInfo(button.dataset.printedInfo, button.dataset.printId));
  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = () => cancelReservation(button.dataset.cancelReservation, button.dataset.reservation));
  document.querySelectorAll("[data-move]").forEach(button => button.onclick = () => movePrinter(button.dataset.id, Number(button.dataset.move)));
  const add = $("[data-add]");
  if (add) add.onclick = addForm;

  if (reorderMode) {
    document.querySelectorAll("[data-printer]").forEach(cardElement => {
      cardElement.onpointerdown = startReorderDrag;
    });
  }
}

function showModal(html, onSubmit) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.remove("hidden");
  const form = $("#modalContent form");
  const actorInput = form?.querySelector('[name="actor"]');
  if (actorInput && rememberedActor) actorInput.value = rememberedActor;
  if (form && onSubmit) form.onsubmit = event => {
    const submittedActor = form.querySelector('[name="actor"]')?.value;
    if (submittedActor) rememberActor(submittedActor);
    return onSubmit(event);
  };
  setTimeout(() => $("#modalContent input")?.focus(), 20);
}

function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modalContent").innerHTML = "";
}

function durationFields(prefix, total = 60) {
  const value = Math.max(1, Number(total) || 60);
  return `<div class="duration-grid"><label>Saat<input name="${prefix}Hours" required type="number" min="0" step="1" value="${Math.floor(value / 60)}"></label><label>Dakika<input name="${prefix}Minutes" required type="number" min="0" max="59" step="1" value="${value % 60}"></label></div>`;
}

function readDuration(formData, prefix) {
  const hours = Math.max(0, Math.floor(Number(formData.get(`${prefix}Hours`)) || 0));
  const mins = Math.max(0, Math.min(59, Math.floor(Number(formData.get(`${prefix}Minutes`)) || 0)));
  const total = hours * 60 + mins;
  if (!total) throw new Error("Süre en az 1 dakika olmalıdır");
  return total;
}

function openPrinter(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer || reorderMode) return;
  if (printer.status === "maintenance") return toast("Bu yazıcı bakımda");
  if (printer.status === "broken") return toast("Bu yazıcı arızalı");
  if (printer.status === "finished") return clearFinished(printer);
  if (printer.status === "free" && printer.queue.length) return startQueuedForm(printer);
  jobForm(printer);
}

function jobForm(printer) {
  const queued = printer.status !== "free" || printer.queue.length > 0;
  const warningText = approachingPlanText(printer);
  const warning = warningText ? `<div class="form-warning"><b>⚠ Yaklaşan plan</b><span>${esc(warningText)}. Girdiğiniz süre bununla çakışırsa baskı başlatılmaz.</span></div>` : "";
  showModal(`<form class="form"><h2>${esc(printer.name)}</h2><p class="form-intro">${queued ? "Yazıcı uygun olduğunda ve rezervasyonlara göre işiniz sıraya yerleştirilecektir." : "Baskıyı başlatmadan önce işi kaydedin."}</p>${warning}<label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Ne basıyorsunuz?<input name="job" required placeholder="Örn. İHA sensör braketi"></label><fieldset><legend>Tahmini baskı süresi</legend>${durationFields("duration", 60)}</fieldset><button class="submit">${queued ? "SIRAYA EKLE" : "BASKIYI BAŞLAT"}</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const name = String(form.get("job")).trim();
      const duration = readDuration(form, "duration");
      closeModal();
      await mutate("startJob", { printerId: printer.id, job: { name, owner: actor, duration } }, makeEntry("İş eklendi", `${name} · ${printer.name}`, actor));
    } catch (error) {
      toast(error.message);
    }
  });
}

function startQueuedForm(printer) {
  const job = printer.queue[0];
  showModal(`<form class="form"><h2>Sıradaki işi başlat</h2><p class="form-intro"><b>${esc(job.name)}</b><br>${esc(job.owner)} · ${durationText(job.duration)}<br><br>Yaklaşan bir rezervasyonla çakışırsa sistem başlangıcı engeller.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit">BASKIYI BAŞLAT</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    closeModal();
    try {
      await mutate("startQueuedJob", { printerId: printer.id }, makeEntry("Sıradaki baskı başlatıldı", `${job.name} · ${printer.name}`, actor));
    } catch (_) {}
  });
}

function clearFinished(printer) {
  showModal(`<form class="form"><h2>Yazıcıyı boşalt</h2><p class="form-intro"><b>${esc(printer.name)}</b> uygun olarak işaretlenecek.<br><br>Tamamlanan iş: ${esc(printer.job || "—")}</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, YAZICIYI BOŞALT</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    closeModal();
    try {
      await mutate("clearFinished", { printerId: printer.id }, makeEntry("Yazıcı boşaltıldı", `${printer.job} · ${printer.name}`, actor));
    } catch (_) {}
  });
}

function cancelCurrentPrint(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer || printer.status !== "printing") return toast("Devam eden baskı bulunamadı");
  showModal(`<form class="form"><h2>Baskıyı iptal et</h2><p class="form-intro"><b>“${esc(printer.job)}”</b> baskısını durdurmak istediğinize emin misiniz?<br><br>${esc(printer.name)} uygun olarak işaretlenecek. Sıradaki işler ve rezervasyonlar silinmeyecektir.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, BASKIYI İPTAL ET</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    const ownPrint = samePerson(actor, printer.owner);
    const action = ownPrint ? "Baskı sahibi tarafından iptal edildi" : "Baskı başka biri tarafından iptal edildi";
    const detail = `${printer.job} · ${printer.name} · Baskı sahibi: ${printer.owner}`;
    closeModal();
    try {
      await mutate("cancelCurrentPrint", { printerId: id }, makeEntry(action, detail, actor), "Baskı iptal edildi");
    } catch (_) {}
  });
}

function activePrintInfo(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer || printer.status !== "printing") return toast("Devam eden baskı bulunamadı");
  const progress = printProgress(printer);
  const startedAt = printStartedAt(printer);
  showModal(`<div class="info-sheet"><small>DEVAM EDEN BASKI</small><h2>${esc(printer.job)}</h2><p>${esc(printer.name)} · ${esc(printer.owner)}</p><div class="info-grid"><div><span>Başlangıç</span><b>${startedAt ? dateTime(startedAt) : "—"}</b></div><div><span>Tahmini bitiş</span><b>${dateTime(printer.endsAt)}</b></div><div><span>İlerleme</span><b>%${progress}</b></div><div><span>Kalan süre</span><b>${remaining(printer.endsAt)}</b></div></div><div class="modal-progress"><i style="width:${progress}%"></i></div><button class="submit danger" id="calendarCancelCurrent">BASKIYI İPTAL ET</button></div>`);
  $("#calendarCancelCurrent").onclick = () => {
    closeModal();
    cancelCurrentPrint(id);
  };
}

function addForm() {
  showModal(`<form class="form"><h2>Yazıcı ekle</h2><p class="form-intro">Bir ad ve renk seçin.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Yazıcı adı<input name="name" required placeholder="Örn. Yazıcı 06"></label><label>Renk<input class="color-input" name="color" type="color" value="#2563eb"></label><button class="submit">YAZICI EKLE</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actor = String(form.get("actor")).trim();
    const printer = { id: makeId(), name: String(form.get("name")).trim(), color: String(form.get("color")), status: "free", queue: [], reservations: [] };
    closeModal();
    try {
      await mutate("addPrinter", { printer }, makeEntry("Yazıcı eklendi", printer.name, actor));
    } catch (_) {}
  });
}

function editPrinterForm(id) {
  const printer = printers.find(item => item.id === id);
  const jobField = printer.job ? `<label>Mevcut baskı adı<input name="jobName" required value="${esc(printer.job)}"></label>` : "";
  showModal(`<form class="form"><h2>Yazıcıyı düzenle</h2><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Yazıcı adı<input name="name" required value="${esc(printer.name)}"></label>${jobField}<label>Renk<input class="color-input" name="color" type="color" value="${esc(printer.color)}"></label><button class="submit">DEĞİŞİKLİKLERİ KAYDET</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actor = String(form.get("actor")).trim();
    const name = String(form.get("name")).trim();
    const jobName = printer.job ? String(form.get("jobName")).trim() : undefined;
    closeModal();
    try {
      await mutate("editPrinter", { printerId: id, name, color: String(form.get("color")), jobName }, makeEntry("Yazıcı düzenlendi", `${printer.name} → ${name}${jobName && jobName !== printer.job ? ` · İş: ${jobName}` : ""}`, actor));
    } catch (_) {}
  });
}

function editQueueForm(printerId, jobId) {
  const printer = printers.find(item => item.id === printerId);
  const job = printer.queue.find(item => item.id === jobId);
  showModal(`<form class="form"><h2>Sıra işini düzenle</h2><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>İş adı<input name="name" required value="${esc(job.name)}"></label><fieldset><legend>Tahmini baskı süresi</legend>${durationFields("duration", job.duration)}</fieldset><button class="submit">KAYDET</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const name = String(form.get("name")).trim();
      const duration = readDuration(form, "duration");
      closeModal();
      await mutate("editQueueJob", { printerId, jobId, name, duration }, makeEntry("Sıra işi düzenlendi", `${job.name} → ${name} · ${printer.name}`, actor));
    } catch (error) {
      toast(error.message);
    }
  });
}

function deleteQueueJob(printerId, jobId) {
  const printer = printers.find(item => item.id === printerId);
  const job = printer.queue.find(item => item.id === jobId);
  if (!printer || !job) return toast("Sıra işi bulunamadı");
  showModal(`<form class="form"><h2>Sıra işini sil</h2><p class="form-intro"><b>“${esc(job.name)}”</b> sıradan silinsin mi?<br><br>${esc(printer.name)} · İş sahibi: ${esc(job.owner)}</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, SIRADAN SİL</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    const ownJob = samePerson(actor, job.owner);
    const action = ownJob ? "Sıra işi sahibi tarafından silindi" : "Sıra işi başka biri tarafından silindi";
    const detail = `${job.name} · ${printer.name} · İş sahibi: ${job.owner}`;
    closeModal();
    try {
      await mutate("deleteQueueJob", { printerId, jobId }, makeEntry(action, detail, actor));
    } catch (_) {}
  });
}

function savedJobForm(savedJobId = null) {
  const job = savedJobId ? savedJobs.find(item => item.id === savedJobId) : null;
  if (savedJobId && !job) return toast("Kayıtlı iş bulunamadı");
  showModal(`<form class="form"><h2>${job ? "Kayıtlı işi düzenle" : "Yeni iş kaydet"}</h2><p class="form-intro">İş adını ve tahmini süresini şimdi kaydedin; daha sonra takvimde boş bir saate tıklayarak kullanın.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Parça / iş adı<input name="name" required value="${esc(job?.name || "")}" placeholder="Örn. Bağlantı braketi"></label><fieldset><legend>Tahmini baskı süresi</legend>${durationFields("duration", job?.duration || 60)}</fieldset><button class="submit">${job ? "DEĞİŞİKLİKLERİ KAYDET" : "İŞİ KAYDET"}</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const name = String(form.get("name")).trim();
      const duration = readDuration(form, "duration");
      closeModal();
      if (job) await mutate("editSavedJob", { savedJobId: job.id, name, duration }, makeEntry("Kayıtlı iş düzenlendi", `${job.name} → ${name} · ${durationText(duration)}`, actor));
      else await mutate("addSavedJob", { savedJob: { name, duration } }, makeEntry("Yeni iş kaydedildi", `${name} · ${durationText(duration)}`, actor));
    } catch (error) {
      toast(error.message);
    }
  });
}

function deleteSavedJob(savedJobId) {
  const job = savedJobs.find(item => item.id === savedJobId);
  if (!job) return toast("Kayıtlı iş bulunamadı");
  showModal(`<form class="form"><h2>Kayıtlı işi sil</h2><p class="form-intro"><b>“${esc(job.name)}”</b> kayıtlı işler listesinden silinsin mi? Daha önce takvime eklenmiş işler etkilenmez.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, KAYITLI İŞİ SİL</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    closeModal();
    try {
      await mutate("deleteSavedJob", { savedJobId }, makeEntry("Kayıtlı iş silindi", `${job.name} · ${durationText(job.duration)}`, actor));
    } catch (_) {}
  });
}

function useSavedJob(savedJobId) {
  const job = savedJobs.find(item => item.id === savedJobId);
  if (!job) return toast("Kayıtlı iş bulunamadı");
  pendingSavedJobId = savedJobId;
  setTab("calendar");
  toast(`“${job.name}” seçildi · Takvimde boş bir saate tıklayın`);
}

function printHistoryInfo(printerId, printId) {
  const printer = printers.find(item => item.id === printerId);
  const item = printer?.printHistory?.find(entry => entry.id === printId);
  if (!printer || !item) return toast("Baskı geçmişi kaydı bulunamadı");
  const duration = Math.max(1, Math.round((Number(item.endAt) - Number(item.startAt)) / 60000));
  showModal(`<div class="info-sheet"><small>TAMAMLANAN BASKI</small><h2>${esc(item.label || item.job)}</h2><p>${esc(printer.name)} · ${esc(item.owner || "—")}</p><div class="info-grid"><div><span>Başlangıç</span><b>${dateTime(item.startAt)}</b></div><div><span>Bitiş</span><b>${dateTime(item.endAt)}</b></div><div><span>Baskı süresi</span><b>${durationText(duration)}</b></div><div><span>Durum</span><b>✓ Tamamlandı</b></div></div><button class="submit danger" id="deletePrintedHistory">BU KAYDI SİL</button></div>`);
  $("#deletePrintedHistory").onclick = () => deletePrintHistoryForm(printer, item);
}

function deletePrintHistoryForm(printer, item) {
  showModal(`<form class="form"><h2>Baskı geçmişini sil</h2><p class="form-intro"><b>“${esc(item.label || item.job)}”</b> geçmişten kalıcı olarak silinsin mi? Genel işlem geçmişine silme kaydı eklenecektir.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, GEÇMİŞTEN SİL</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    closeModal();
    try {
      await mutate("deletePrintHistory", { printerId: printer.id, printId: item.id }, makeEntry("Baskı geçmişi silindi", `${item.label || item.job} · ${printer.name}`, actor));
    } catch (_) {}
  });
}

function scheduledPrintForm(printerId, suggestedStart, preferredSavedJob = null) {
  const printer = printers.find(item => item.id === printerId);
  if (!printer) return;
  const start = new Date(suggestedStart);
  const initialJob = preferredSavedJob || savedJobs.find(item => item.id === pendingSavedJobId) || null;
  pendingSavedJobId = null;
  const savedSelector = savedJobs.length ? `<label>Kayıtlı iş kullan<select name="savedJob" id="scheduledSavedJob"><option value="">Elle gir</option>${savedJobs.map(job => `<option value="${job.id}" ${initialJob?.id === job.id ? "selected" : ""}>${esc(job.name)} · ${durationText(job.duration)}</option>`).join("")}</select></label>` : "";
  showModal(`<form class="form"><h2>Planlı baskı ekle</h2><p class="form-intro"><b>${esc(printer.name)}</b> için takvimden bir başlangıç zamanı seçtiniz. Çakışan bir zaman kaydedilemez.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label>${savedSelector}<label>Baskı / iş adı<input name="purpose" required value="${esc(initialJob?.name || "")}" placeholder="Örn. Bağlantı braketi"></label><div class="form-grid"><label>Başlangıç tarihi<input name="date" required type="date" value="${dateValue(start)}"></label><label>Başlangıç saati<input name="time" required type="time" value="${timeValue(start)}"></label></div><fieldset id="scheduledDuration" class="${initialJob ? "duration-locked" : ""}"><legend>Tahmini süre <span>${initialJob ? "· Kayıtlı iş süresi" : ""}</span></legend>${durationFields("duration", initialJob?.duration || 60)}</fieldset><button class="submit">BASKIYI PLANLA</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const selectedJob = savedJobs.find(item => item.id === String(form.get("savedJob") || ""));
      const duration = selectedJob ? Math.max(1, Number(selectedJob.duration) || 1) : readDuration(form, "duration");
      const startAt = new Date(`${form.get("date")}T${form.get("time")}`).getTime();
      const endAt = startAt + duration * 60000;
      closeModal();
      await mutate("addScheduledPrint", { printerId, savedJobId: selectedJob?.id || null, reservation: { purpose, owner: actor, startAt, endAt } }, makeEntry("Planlı baskı eklendi", `${purpose} · ${printer.name} · ${dateTime(startAt)}–${timeValue(endAt)}`, actor), "Baskı takvime eklendi");
      calendarDate = startOfDay(startAt);
      calendarShouldFocusNow = false;
      renderCalendar();
    } catch (error) {
      toast(error.message);
    }
  });
  const savedJobSelect = $("#scheduledSavedJob");
  const durationFieldset = $("#scheduledDuration");
  const setDurationLock = selected => {
    if (!durationFieldset) return;
    durationFieldset.classList.toggle("duration-locked", Boolean(selected));
    durationFieldset.querySelectorAll("input").forEach(input => { input.readOnly = Boolean(selected); });
    const legendNote = durationFieldset.querySelector("legend span");
    if (legendNote) legendNote.textContent = selected ? "· Kayıtlı iş süresi" : "";
  };
  setDurationLock(initialJob);
  if (savedJobSelect) savedJobSelect.onchange = () => {
    const selected = savedJobs.find(item => item.id === savedJobSelect.value);
    const form = savedJobSelect.closest("form");
    setDurationLock(selected);
    if (!selected) return;
    form.elements.purpose.value = selected.name;
    form.elements.durationHours.value = Math.floor(Number(selected.duration) / 60);
    form.elements.durationMinutes.value = Number(selected.duration) % 60;
  };
}

function reserveForm(id) {
  const printer = printers.find(item => item.id === id);
  const defaultStart = new Date(Date.now() + 60 * 60000);
  defaultStart.setMinutes(0, 0, 0);
  showModal(`<form class="form"><h2>${esc(printer.name)} rezervasyonu</h2><p class="form-intro">Devam eden baskılar, diğer rezervasyonlar ve planlanmış sıra işleriyle çakışan saatler kabul edilmez.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Amaç / iş adı<input name="purpose" required placeholder="Prototip baskısı"></label><div class="form-grid"><label>Tarih<input name="date" required type="date" value="${dateValue(defaultStart)}"></label><label>Başlangıç saati<input name="time" required type="time" value="${timeValue(defaultStart)}"></label></div><fieldset><legend>Tahmini süre</legend>${durationFields("duration", 60)}</fieldset><button class="submit">REZERVASYONU ONAYLA</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const duration = readDuration(form, "duration");
      const startAt = new Date(`${form.get("date")}T${form.get("time")}`).getTime();
      const endAt = startAt + duration * 60000;
      closeModal();
      await mutate("addReservation", { printerId: id, reservation: { purpose, owner: actor, startAt, endAt } }, makeEntry("Yazıcı rezerve edildi", `${purpose} · ${printer.name} · ${dateTime(startAt)}–${timeValue(endAt)}`, actor), "Rezervasyon kaydedildi");
      calendarDate = startOfDay(startAt);
      setTab("calendar");
    } catch (error) {
      toast(error.message);
    }
  });
}

function cancelReservation(printerId, reservationId) {
  const printer = printers.find(item => item.id === printerId);
  const reservation = printer?.reservations?.find(item => item.id === reservationId);
  if (!printer || !reservation) return toast("Planlanan iş bulunamadı");
  const scheduled = reservation.kind === "scheduled";
  const noun = scheduled ? "planlı baskıyı" : "rezervasyonu";
  const ownerLabel = scheduled ? "Baskı sahibi" : "Rezervasyon sahibi";
  showModal(`<form class="form"><h2>${scheduled ? "Planlı baskıyı" : "Rezervasyonu"} iptal et</h2><p class="form-intro"><b>“${esc(reservation.purpose)}”</b> ${noun} iptal etmek istediğinize emin misiniz?<br><br>${esc(printer.name)} · ${dateTime(reservation.startAt)}<br>${ownerLabel}: ${esc(reservation.owner)}</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, İPTAL ET</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    const ownReservation = samePerson(actor, reservation.owner);
    const action = scheduled
      ? ownReservation ? "Planlı baskı sahibi tarafından iptal edildi" : "Planlı baskı başka biri tarafından iptal edildi"
      : ownReservation ? "Rezervasyon sahibi tarafından iptal edildi" : "Rezervasyon başka biri tarafından iptal edildi";
    const detail = `${reservation.purpose} · ${printer.name} · ${dateTime(reservation.startAt)} · ${ownerLabel}: ${reservation.owner}`;
    closeModal();
    try {
      await mutate("deleteReservation", { printerId, reservationId }, makeEntry(action, detail, actor));
    } catch (_) {}
  });
}

function scheduledPrintInfo(printerId, reservationId) {
  const printer = printers.find(item => item.id === printerId);
  const reservation = printer?.reservations?.find(item => item.id === reservationId && item.kind === "scheduled");
  if (!printer || !reservation) return toast("Planlı baskı bulunamadı");
  const duration = Math.max(1, Math.round((Number(reservation.endAt) - Number(reservation.startAt)) / 60000));
  const untilStart = Number(reservation.startAt) > Date.now() ? remaining(reservation.startAt) : "Başlangıç zamanı geldi";
  showModal(`<div class="info-sheet"><small>PLANLI BASKI</small><h2>${esc(reservation.purpose)}</h2><p>${esc(printer.name)} · ${esc(reservation.owner)}</p><div class="info-grid"><div><span>Başlangıç</span><b>${dateTime(reservation.startAt)}</b></div><div><span>Tahmini bitiş</span><b>${dateTime(reservation.endAt)}</b></div><div><span>Baskı süresi</span><b>${durationText(duration)}</b></div><div><span>Başlangıca kalan</span><b>${esc(untilStart)}</b></div></div><button class="submit danger" id="calendarCancelScheduled">PLANLI BASKIYI İPTAL ET</button></div>`);
  $("#calendarCancelScheduled").onclick = () => {
    closeModal();
    cancelReservation(printerId, reservationId);
  };
}

function maintenanceForm(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer) return toast("Yazıcı bulunamadı");
  const current = ["maintenance", "broken"].includes(printer.status) ? printer.status : "maintenance";
  showModal(`<form class="form"><h2>Yazıcı durumu</h2><p class="form-intro"><b>${esc(printer.name)}</b> için servis durumunu seçin. Arızalı, tamamen servis dışı olan cihazlar içindir.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Durum<select name="status" required><option value="maintenance" ${current === "maintenance" ? "selected" : ""}>Bakımda</option><option value="broken" ${current === "broken" ? "selected" : ""}>Arızalı</option><option value="free">Uygun / servise döndü</option></select></label><label>Açıklama<input name="note" value="${esc(printer.maintenanceNote || "")}" placeholder="Örn. Nozul değişimi veya arıza açıklaması"></label><button class="submit">DURUMU KAYDET</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actor = String(form.get("actor")).trim();
    const status = String(form.get("status"));
    const note = String(form.get("note")).trim();
    if (status !== "free" && !note) return toast("Bakım veya arıza açıklaması girin");
    const action = status === "broken" ? "Yazıcı arızalı olarak işaretlendi" : status === "maintenance" ? "Bakım modu açıldı" : "Yazıcı servise döndürüldü";
    closeModal();
    try {
      await mutate("setMaintenance", { printerId: id, status, note }, makeEntry(action, `${note || "Uygun"} · ${printer.name}`, actor));
    } catch (_) {}
  });
}

function removePrinter(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer) return toast("Yazıcı bulunamadı");
  showModal(`<form class="form"><h2>Yazıcıyı sil</h2><p class="form-intro"><b>${esc(printer.name)}</b> sistemden silinecek. İşlem geçmişi korunacaktır.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit danger">EVET, YAZICIYI SİL</button></form>`, async event => {
    event.preventDefault();
    const actor = String(new FormData(event.currentTarget).get("actor")).trim();
    closeModal();
    try {
      await mutate("deletePrinter", { printerId: id }, makeEntry("Yazıcı silindi", printer.name, actor));
    } catch (_) {}
  });
}

function beginOrSaveReorder() {
  if (!reorderMode) {
    showModal(`<form class="form"><h2>Yazıcıları sırala</h2><p class="form-intro">Kartları sürükleyerek veya ok düğmelerini kullanarak yazıcıların sırasını değiştirebilirsiniz.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><button class="submit">SIRALAMAYI BAŞLAT</button></form>`, event => {
      event.preventDefault();
      reorderActor = String(new FormData(event.currentTarget).get("actor")).trim();
      reorderOriginal = printers.map(printer => printer.id);
      reorderMode = true;
      closeModal();
      render();
    });
    return;
  }
  const order = printers.map(printer => printer.id);
  reorderMode = false;
  mutate("reorderPrinters", { order }, makeEntry("Yazıcı sıralaması değiştirildi", "Yazıcı kartlarının sırası güncellendi", reorderActor)).catch(() => {
    printers.sort((a, b) => reorderOriginal.indexOf(a.id) - reorderOriginal.indexOf(b.id));
    render();
  });
}

function cancelReorder() {
  finishReorderDrag(true);
  printers.sort((a, b) => reorderOriginal.indexOf(a.id) - reorderOriginal.indexOf(b.id));
  reorderMode = false;
  render();
}

function capturePrinterPositions() {
  return new Map([...document.querySelectorAll("#printerRail [data-printer]")].map(element => [element.dataset.printer, element.getBoundingClientRect()]));
}

function animatePrinterPositions(previous) {
  requestAnimationFrame(() => {
    document.querySelectorAll("#printerRail [data-printer]").forEach(element => {
      const before = previous.get(element.dataset.printer);
      const after = element.getBoundingClientRect();
      if (!before) return;
      const offset = before.left - after.left;
      if (Math.abs(offset) < 1) return;
      element.style.transition = "none";
      element.style.transform = `translateX(${offset}px)`;
      requestAnimationFrame(() => {
        element.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease";
        element.style.transform = "translateX(0)";
        element.addEventListener("transitionend", () => {
          element.style.transition = "";
          element.style.transform = "";
        }, { once: true });
      });
    });
  });
}

function movePrinterTo(sourceId, targetId, afterTarget) {
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const sourceIndex = printers.findIndex(item => item.id === sourceId);
  if (sourceIndex < 0) return false;
  const [source] = printers.splice(sourceIndex, 1);
  const targetIndex = printers.findIndex(item => item.id === targetId);
  if (targetIndex < 0) {
    printers.splice(sourceIndex, 0, source);
    return false;
  }
  printers.splice(targetIndex + (afterTarget ? 1 : 0), 0, source);
  return true;
}

function positionReorderGhost() {
  if (!reorderDrag) return;
  reorderDrag.ghost.style.left = `${reorderDrag.clientX - reorderDrag.offsetX}px`;
  reorderDrag.ghost.style.top = `${reorderDrag.clientY - reorderDrag.offsetY}px`;
}

function updateReorderDropTarget() {
  if (!reorderDrag) return;
  const cards = [...document.querySelectorAll("#printerRail [data-printer]")]
    .filter(element => element.dataset.printer !== reorderDrag.sourceId);
  cards.forEach(element => element.classList.remove("drop-before", "drop-after"));
  if (!cards.length) return;
  const target = cards.find(element => reorderDrag.clientX <= element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2) || cards[cards.length - 1];
  const targetRect = target.getBoundingClientRect();
  const afterTarget = target === cards[cards.length - 1] && reorderDrag.clientX > targetRect.left + targetRect.width / 2;
  target.classList.add(afterTarget ? "drop-after" : "drop-before");
  reorderDrag.targetId = target.dataset.printer;
  reorderDrag.afterTarget = afterTarget;
}

function runReorderAutoScroll() {
  if (!reorderDrag) return;
  const rail = $("#printerRail");
  const rect = rail.getBoundingClientRect();
  const edge = Math.min(92, rect.width * .22);
  let speed = 0;
  if (reorderDrag.clientX < rect.left + edge) speed = -Math.ceil((rect.left + edge - reorderDrag.clientX) / edge * 18);
  else if (reorderDrag.clientX > rect.right - edge) speed = Math.ceil((reorderDrag.clientX - (rect.right - edge)) / edge * 18);
  if (speed) {
    rail.scrollLeft += speed;
    updateReorderDropTarget();
  }
  reorderScrollFrame = requestAnimationFrame(runReorderAutoScroll);
}

function onReorderPointerMove(event) {
  if (!reorderDrag || event.pointerId !== reorderDrag.pointerId) return;
  event.preventDefault();
  reorderDrag.clientX = event.clientX;
  reorderDrag.clientY = event.clientY;
  positionReorderGhost();
  updateReorderDropTarget();
}

function startReorderDrag(event) {
  if (!reorderMode || reorderDrag || event.target.closest("button") || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  const cardElement = event.currentTarget;
  const rect = cardElement.getBoundingClientRect();
  const ghost = cardElement.cloneNode(true);
  ghost.removeAttribute("data-printer");
  ghost.classList.add("reorder-ghost");
  ghost.querySelectorAll("button").forEach(button => { button.disabled = true; });
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  document.body.appendChild(ghost);
  cardElement.classList.add("dragging");
  document.body.classList.add("reorder-dragging");
  reorderDrag = {
    pointerId: event.pointerId,
    sourceId: cardElement.dataset.printer,
    sourceElement: cardElement,
    ghost,
    clientX: event.clientX,
    clientY: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    targetId: null,
    afterTarget: false,
  };
  positionReorderGhost();
  updateReorderDropTarget();
  document.addEventListener("pointermove", onReorderPointerMove, { passive: false });
  document.addEventListener("pointerup", onReorderPointerUp);
  document.addEventListener("pointercancel", onReorderPointerCancel);
  reorderScrollFrame = requestAnimationFrame(runReorderAutoScroll);
}

function onReorderPointerUp(event) {
  if (reorderDrag && event.pointerId === reorderDrag.pointerId) finishReorderDrag(false);
}

function onReorderPointerCancel(event) {
  if (reorderDrag && event.pointerId === reorderDrag.pointerId) finishReorderDrag(true);
}

function finishReorderDrag(cancelled = false) {
  if (!reorderDrag) return;
  const drag = reorderDrag;
  document.querySelectorAll("#printerRail [data-printer]").forEach(element => element.classList.remove("dragging", "drop-before", "drop-after"));
  const previous = capturePrinterPositions();
  reorderDrag = null;
  cancelAnimationFrame(reorderScrollFrame);
  reorderScrollFrame = null;
  document.removeEventListener("pointermove", onReorderPointerMove);
  document.removeEventListener("pointerup", onReorderPointerUp);
  document.removeEventListener("pointercancel", onReorderPointerCancel);
  document.body.classList.remove("reorder-dragging");
  drag.ghost.remove();
  if (!cancelled && movePrinterTo(drag.sourceId, drag.targetId, drag.afterTarget)) {
    render();
    animatePrinterPositions(previous);
  }
}

function movePrinter(id, direction) {
  const index = printers.findIndex(item => item.id === id);
  const target = index + direction;
  if (target < 0 || target >= printers.length) return;
  const previous = capturePrinterPositions();
  [printers[index], printers[target]] = [printers[target], printers[index]];
  render();
  animatePrinterPositions(previous);
}

function setTab(next) {
  const changed = tab !== next;
  tab = next;
  document.querySelectorAll(".tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === next));
  ["fleet", "calendar", "queue", "saved", "printed", "history"].forEach(name => $("#" + name + "View").classList.toggle("hidden", name !== next));
  if (next === "calendar") {
    if (changed) calendarShouldFocusNow = true;
    renderCalendar();
  }
}

document.querySelectorAll(".tabs button").forEach(button => button.onclick = () => setTab(button.dataset.tab));
document.querySelector("[data-open-tab]").onclick = () => setTab("history");
$("#addSavedJob").onclick = () => savedJobForm();
$("#reorderButton").onclick = beginOrSaveReorder;
$("#cancelReorder").onclick = cancelReorder;
$("#calendarDay").onclick = () => { calendarMode = "day"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarWeek").onclick = () => { calendarMode = "week"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarTwoWeeks").onclick = () => { calendarMode = "twoWeeks"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarThreeWeeks").onclick = () => { calendarMode = "threeWeeks"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarPrev").onclick = () => { calendarDate = addDays(calendarDate, -({ day: 1, week: 7, twoWeeks: 14, threeWeeks: 21 }[calendarMode])); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarNext").onclick = () => { calendarDate = addDays(calendarDate, { day: 1, week: 7, twoWeeks: 14, threeWeeks: 21 }[calendarMode]); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarToday").onclick = () => { calendarDate = startOfDay(new Date()); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarShowAll").onclick = event => {
  event.preventDefault();
  calendarSelectedPrinters = new Set(printers.map(printer => printer.id));
  saveCalendarFilter();
  renderCalendar();
};
$("#closeModal").onclick = closeModal;
$("#modal").onclick = event => { if (event.target === $("#modal")) closeModal(); };
updateHeaderClock();
setInterval(updateHeaderClock, 1000);
setInterval(() => load(true), 30000);
load();

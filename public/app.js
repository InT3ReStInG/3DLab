const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

let printers = [];
let activity = [];
let tab = "fleet";
let reorderMode = false;
let reorderActor = "";
let reorderOriginal = [];
let draggedPrinterId = null;
let calendarMode = "day";
let calendarDate = startOfDay(new Date());
let calendarSelectedPrinters = new Set();
let calendarKnownPrinters = new Set();
let calendarFilterInitialized = false;
let calendarScroll = { top: 0, left: 0 };
let calendarShouldFocusNow = true;

const statusText = {
  free: "UYGUN",
  printing: "BASKI YAPIYOR",
  finished: "TAMAMLANDI",
  maintenance: "BAKIMDA",
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
  return { id: crypto.randomUUID(), action, detail, user: user.trim(), at: Date.now() };
}

function samePerson(first, second) {
  const clean = value => String(value || "").trim().replace(/\s+/g, " ");
  return clean(first).localeCompare(clean(second), "tr", { sensitivity: "base" }) === 0;
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

async function load() {
  try {
    const data = await api();
    printers = (data.printers || []).map(normalizePrinter);
    activity = data.activity || [];
    render();
  } catch (error) {
    toast(error.message);
  }
}

function normalizePrinter(printer) {
  return {
    ...printer,
    queue: Array.isArray(printer.queue) ? printer.queue : [],
    reservations: Array.isArray(printer.reservations) ? printer.reservations : [],
  };
}

async function mutate(action, payload, entry, successMessage = "Kaydedildi") {
  try {
    const data = await api({ action, ...payload, entry });
    printers = (data.state?.printers || printers).map(normalizePrinter);
    activity = data.state?.activity || activity;
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
    if (printer.status === "maintenance") return [];
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
  const now = Date.now();
  const twoDays = 48 * 60 * 60000;
  const intervals = mergedBusyIntervals(printer);
  let availableAt = now;
  let index = 0;

  while (index < intervals.length && intervals[index].startAt <= availableAt) {
    availableAt = Math.max(availableAt, intervals[index].endAt);
    index += 1;
  }
  while (index < intervals.length && intervals[index].endAt <= availableAt) index += 1;
  const nextBusyAt = intervals[index]?.startAt;
  const availableFor = nextBusyAt ? nextBusyAt - availableAt : Infinity;

  if (availableAt <= now + 60000 && availableFor >= twoDays) return "Önümüzdeki 2 gün planlanmış baskı yok";
  const startText = availableAt <= now + 60000 ? "Şimdi uygun" : `Sonraki uygun: ${friendlyAvailabilityTime(availableAt)}`;
  if (availableFor >= twoDays) return `${startText} · en az 2 gün uygun`;
  return `${startText} · ${durationText(Math.max(1, Math.floor(availableFor / 60000)))} uygun`;
}

function render() {
  printers = printers.map(printer => printer.status === "printing" && printer.endsAt <= Date.now()
    ? { ...printer, status: "finished" }
    : printer);

  const counts = {
    free: printers.filter(printer => printer.status === "free").length,
    printing: printers.filter(printer => printer.status === "printing").length,
    attention: printers.filter(printer => ["finished", "maintenance"].includes(printer.status)).length,
  };
  $("#stats").innerHTML = `
    <div class="stat"><b>${counts.free}</b><span>Uygun</span></div>
    <div class="stat"><b>${counts.printing}</b><span>Baskıda</span></div>
    <div class="stat"><b>${counts.attention}</b><span>İlgilenilmeli</span></div>`;

  const rows = plannedRows();
  $("#queueCount").textContent = rows.length;
  $("#printerRail").classList.toggle("is-reordering", reorderMode);
  $("#printerRail").innerHTML = printers.map((printer, index) => card(printer, index)).join("")
    + (reorderMode ? "" : `<button class="add-card" data-add><i>＋</i><b>YAZICI EKLE</b><small>Yeni cihaz kaydet</small></button>`);
  $("#recentActivity").innerHTML = activity.slice(0, 5).map(item => activityRow(item, false)).join("") || empty("Henüz işlem yok");
  $("#allActivity").innerHTML = activity.map(item => activityRow(item, true)).join("") || empty("Henüz işlem yok");
  $("#shortQueue").innerHTML = printers.filter(printer => printer.status !== "maintenance").map(nextPrinterRow).join("") || empty("Gösterilecek yazıcı yok");
  $("#allQueue").innerHTML = rows.map((item, index) => plannedRow(item, index)).join("") || empty("Planlanmış iş yok");
  $("#reorderButton").textContent = reorderMode ? "Sıralamayı kaydet" : "↕ Sıralamayı düzenle";
  $("#cancelReorder").classList.toggle("hidden", !reorderMode);
  $("#reorderHint").textContent = reorderMode ? "Kartları sürükleyin veya okları kullanın." : "Kartlara basarak baskı ekleyebilirsiniz.";
  renderCalendar();
  bindDynamicControls();
}

function card(printer, index) {
  const icon = printer.status === "maintenance" ? "⚙" : "▣";
  const queueNote = printer.queue.length ? `<span class="queue-note">${printer.queue.length} iş sırada</span>` : "";
  const availability = `<span class="availability-line">${esc(availabilitySummary(printer))}</span>`;
  let body;
  if (printer.status === "free") {
    body = printer.queue.length
      ? `<p>${esc(printer.queue[0].name)}</p><span class="primary-action">▶ SIRADAKİ İŞİ BAŞLAT</span>${queueNote}${availability}`
      : `<p>Yeni bir iş için hazır</p><span class="primary-action">＋ BASKI EKLE</span>${availability}`;
  } else if (printer.status === "maintenance") {
    body = `<p>${esc(printer.maintenanceNote)}</p><span class="maintenance-action">SERVİS DIŞI</span>${availability}`;
  } else {
    const progress = printProgress(printer);
    body = `<p class="job">${esc(printer.job)}</p><span class="owner">◯ ${esc(printer.owner)}</span><div class="progress"><i style="width:${progress}%"></i></div><div class="time-row"><span>İlerleme</span><b>%${progress}</b></div><div class="time-row"><span>${printer.status === "finished" ? "Temizlenmeyi bekliyor" : "Tahmini kalan süre"}</span><b>${remaining(printer.endsAt)}</b></div>${queueNote}${availability}`;
  }

  const reorderControls = reorderMode ? `
    <div class="reorder-controls">
      <button data-move="-1" data-id="${printer.id}" ${index === 0 ? "disabled" : ""}>←</button>
      <span>⠿ Sürükle</span>
      <button data-move="1" data-id="${printer.id}" ${index === printers.length - 1 ? "disabled" : ""}>→</button>
    </div>` : "";

  return `<article class="printer-card status-${printer.status} ${reorderMode ? "reorder-mode" : ""}" data-printer="${printer.id}" draggable="${reorderMode}" style="--accent:${esc(printer.color)}">
    <div class="card-top"><span class="status"><i></i>${statusText[printer.status]}</span><button class="trash" data-delete="${printer.id}" aria-label="${esc(printer.name)} yazıcısını sil">⌫</button></div>
    <button class="printer-main" data-open="${printer.id}" ${reorderMode ? "disabled" : ""}><div class="printer-icon"><span>${icon}${printer.status === "printing" ? `<b>${remaining(printer.endsAt)}</b>` : ""}</span></div><h3>${esc(printer.name)}</h3>${body}</button>
    ${reorderControls || `<div class="card-tools"><button data-reserve="${printer.id}">▦ Rezerve et</button><button data-edit-printer="${printer.id}">✎ Düzenle</button>${printer.status === "printing" ? `<button class="cancel-print" data-cancel-print="${printer.id}" aria-label="Mevcut baskıyı iptal et" title="Mevcut baskıyı iptal et">■</button>` : `<button data-maintenance="${printer.id}" aria-label="Bakım">⚙</button>`}</div>`}
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

function empty(text) {
  return `<div class="empty">${text}</div>`;
}

function scheduleEvents(printer) {
  const events = [];
  if (["printing", "finished"].includes(printer.status) && printer.endsAt) {
    const recoveredStart = printStartedAt(printer);
    const fallbackStart = printer.status === "printing" ? Math.min(Date.now(), printer.endsAt) : printer.endsAt - 60000;
    events.push({ type: "print", label: printer.job, owner: printer.owner, startAt: recoveredStart || fallbackStart, endAt: printer.endsAt });
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
  $("#calendarDate").value = dateValue(calendarDate);
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
  const nowLine = nowVisible ? `<i class="horizontal-now-line" style="left:${nowLeft}px"><span>Şimdi · ${timeValue(now)}</span></i>` : "";

  $("#calendarGrid").innerHTML = selected.length ? `<div class="timeline-scroll horizontal ${calendarMode}" id="calendarTimeline"><div class="horizontal-board" style="--printer-count:${selected.length};--hour-width:${hourWidth}px;--time-width:${timeWidth}px;--timeline-min-width:${minWidth}px"><div class="horizontal-corner">Yazıcı</div><div class="horizontal-time-head">${horizontalTimeScale(first, totalHours, hourWidth)}</div><div class="horizontal-printer-labels">${selected.map(horizontalPrinterLabel).join("")}</div><div class="horizontal-lanes">${selected.map(printer => horizontalLane(printer, rangeStart, rangeEnd, hourWidth)).join("")}${dayLines}${nowLine}</div></div></div>` : empty("En az bir yazıcı seçin");

  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = event => { event.stopPropagation(); cancelReservation(button.dataset.cancelReservation, button.dataset.reservation); });
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
  if (printer.status === "maintenance") {
    const width = (rangeEnd - rangeStart) / 3600000 * hourWidth;
    return `<div class="horizontal-lane" data-calendar-lane="${printer.id}"><div class="horizontal-event maintenance" style="left:3px;width:${Math.max(30, width - 6)}px"><b>Servis dışı</b><span>${esc(printer.maintenanceNote || "Bakım modu")}</span></div></div>`;
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
  const cancel = item.type === "reservation" ? `<button data-cancel-reservation="${printer.id}" data-reservation="${item.reservationId}" aria-label="Rezervasyonu iptal et">×</button>` : "";
  const scheduledCancel = item.type === "scheduled" ? `<button data-cancel-reservation="${printer.id}" data-reservation="${item.reservationId}" aria-label="Planlı baskıyı iptal et">×</button>` : "";
  return `<div class="horizontal-event ${item.type} ${width < 105 ? "compact" : ""}" style="left:${left + 2}px;width:${Math.max(24, width - 4)}px" title="${esc(item.label)} · ${esc(item.owner)} · ${esc(fullRange)}"><div><small>${typeText} · ${esc(fullRange)}</small><b>${esc(item.label)}</b><span>${esc(item.owner)}</span></div>${cancel || scheduledCancel}</div>`;
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
  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = () => cancelReservation(button.dataset.cancelReservation, button.dataset.reservation));
  document.querySelectorAll("[data-move]").forEach(button => button.onclick = () => movePrinter(button.dataset.id, Number(button.dataset.move)));
  const add = $("[data-add]");
  if (add) add.onclick = addForm;

  if (reorderMode) {
    document.querySelectorAll("[data-printer]").forEach(cardElement => {
      cardElement.ondragstart = () => { draggedPrinterId = cardElement.dataset.printer; cardElement.classList.add("dragging"); };
      cardElement.ondragend = () => { draggedPrinterId = null; cardElement.classList.remove("dragging"); };
      cardElement.ondragover = event => event.preventDefault();
      cardElement.ondrop = event => {
        event.preventDefault();
        reorderBefore(draggedPrinterId, cardElement.dataset.printer);
      };
    });
  }
}

function showModal(html, onSubmit) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.remove("hidden");
  const form = $("#modalContent form");
  if (form && onSubmit) form.onsubmit = onSubmit;
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
  if (printer.status === "finished") return clearFinished(printer);
  if (printer.status === "free" && printer.queue.length) return startQueuedForm(printer);
  jobForm(printer);
}

function jobForm(printer) {
  const queued = printer.status !== "free" || printer.queue.length > 0;
  showModal(`<form class="form"><h2>${esc(printer.name)}</h2><p class="form-intro">${queued ? "Yazıcı uygun olduğunda ve rezervasyonlara göre işiniz sıraya yerleştirilecektir." : "Baskıyı başlatmadan önce işi kaydedin."}</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Ne basıyorsunuz?<input name="job" required placeholder="Örn. İHA sensör braketi"></label><fieldset><legend>Tahmini baskı süresi</legend>${durationFields("duration", 60)}</fieldset><button class="submit">${queued ? "SIRAYA EKLE" : "BASKIYI BAŞLAT"}</button></form>`, async event => {
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
  const actor = prompt("Yazıcıyı boşaltmak için adınızı girin:")?.trim();
  if (!actor || !confirm(`${printer.name} boşaltılıp uygun olarak işaretlensin mi?`)) return;
  mutate("clearFinished", { printerId: printer.id }, makeEntry("Yazıcı boşaltıldı", `${printer.job} · ${printer.name}`, actor)).catch(() => {});
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

function addForm() {
  showModal(`<form class="form"><h2>Yazıcı ekle</h2><p class="form-intro">Bir ad ve renk seçin.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Yazıcı adı<input name="name" required placeholder="Örn. Yazıcı 06"></label><label>Renk<input class="color-input" name="color" type="color" value="#2563eb"></label><button class="submit">YAZICI EKLE</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actor = String(form.get("actor")).trim();
    const printer = { id: crypto.randomUUID(), name: String(form.get("name")).trim(), color: String(form.get("color")), status: "free", queue: [], reservations: [] };
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
  const actor = prompt("Sıra işini silmek için adınızı girin:")?.trim();
  if (!actor || !confirm(`“${job.name}” sıradan silinsin mi?`)) return;
  const ownJob = samePerson(actor, job.owner);
  const action = ownJob ? "Sıra işi sahibi tarafından silindi" : "Sıra işi başka biri tarafından silindi";
  const detail = `${job.name} · ${printer.name} · İş sahibi: ${job.owner}`;
  mutate("deleteQueueJob", { printerId, jobId }, makeEntry(action, detail, actor)).catch(() => {});
}

function scheduledPrintForm(printerId, suggestedStart) {
  const printer = printers.find(item => item.id === printerId);
  if (!printer) return;
  const start = new Date(suggestedStart);
  showModal(`<form class="form"><h2>Planlı baskı ekle</h2><p class="form-intro"><b>${esc(printer.name)}</b> için takvimden bir başlangıç zamanı seçtiniz. Çakışan bir zaman kaydedilemez.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Baskı / iş adı<input name="purpose" required placeholder="Örn. Bağlantı braketi"></label><div class="form-grid"><label>Başlangıç tarihi<input name="date" required type="date" value="${dateValue(start)}"></label><label>Başlangıç saati<input name="time" required type="time" value="${timeValue(start)}"></label></div><fieldset><legend>Tahmini süre</legend>${durationFields("duration", 60)}</fieldset><button class="submit">BASKIYI PLANLA</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const duration = readDuration(form, "duration");
      const startAt = new Date(`${form.get("date")}T${form.get("time")}`).getTime();
      const endAt = startAt + duration * 60000;
      closeModal();
      await mutate("addScheduledPrint", { printerId, reservation: { purpose, owner: actor, startAt, endAt } }, makeEntry("Planlı baskı eklendi", `${purpose} · ${printer.name} · ${dateTime(startAt)}–${timeValue(endAt)}`, actor), "Baskı takvime eklendi");
      calendarDate = startOfDay(startAt);
      calendarShouldFocusNow = false;
      renderCalendar();
    } catch (error) {
      toast(error.message);
    }
  });
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
  const reservation = printer.reservations.find(item => item.id === reservationId);
  const scheduled = reservation.kind === "scheduled";
  const noun = scheduled ? "planlı baskıyı" : "rezervasyonu";
  const actor = prompt(`${noun[0].toUpperCase() + noun.slice(1)} iptal etmek için adınızı girin:`)?.trim();
  if (!actor || !confirm(`“${reservation.purpose}” ${noun} iptal edilsin mi?`)) return;
  const ownReservation = samePerson(actor, reservation.owner);
  const action = scheduled
    ? ownReservation ? "Planlı baskı sahibi tarafından iptal edildi" : "Planlı baskı başka biri tarafından iptal edildi"
    : ownReservation ? "Rezervasyon sahibi tarafından iptal edildi" : "Rezervasyon başka biri tarafından iptal edildi";
  const ownerLabel = scheduled ? "Baskı sahibi" : "Rezervasyon sahibi";
  const detail = `${reservation.purpose} · ${printer.name} · ${dateTime(reservation.startAt)} · ${ownerLabel}: ${reservation.owner}`;
  mutate("deleteReservation", { printerId, reservationId }, makeEntry(action, detail, actor)).catch(() => {});
}

function maintenanceForm(id) {
  const printer = printers.find(item => item.id === id);
  const active = printer.status === "maintenance";
  showModal(`<form class="form"><h2>${active ? "Servise döndür" : "Bakım modu"}</h2><p class="form-intro">${active ? `${esc(printer.name)} şu anda servis dışı.` : `${esc(printer.name)} üzerinde yeni iş ve rezervasyon başlatılmasını engelleyin.`}</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label>${active ? "" : `<label>Neden<input name="note" required placeholder="Örn. Nozul değişimi"></label>`}<button class="submit ${active ? "" : "danger"}">${active ? "UYGUN OLARAK İŞARETLE" : "BAKIM MODUNU AÇ"}</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actor = String(form.get("actor")).trim();
    const note = active ? "" : String(form.get("note")).trim();
    closeModal();
    try {
      await mutate("setMaintenance", { printerId: id, active: !active, note }, makeEntry(active ? "Bakım modu kapatıldı" : "Bakım modu açıldı", `${note || "Uygun"} · ${printer.name}`, actor));
    } catch (_) {}
  });
}

function removePrinter(id) {
  const printer = printers.find(item => item.id === id);
  const actor = prompt(`${printer.name} yazıcısını silmek için adınızı girin:`)?.trim();
  if (!actor || !confirm(`${printer.name} silinsin mi? Geçmiş kayıtları korunacaktır.`)) return;
  mutate("deletePrinter", { printerId: id }, makeEntry("Yazıcı silindi", printer.name, actor)).catch(() => {});
}

function beginOrSaveReorder() {
  if (!reorderMode) {
    const actor = prompt("Sıralamayı değiştiren kişinin adı:")?.trim();
    if (!actor) return;
    reorderActor = actor;
    reorderOriginal = printers.map(printer => printer.id);
    reorderMode = true;
    render();
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
  printers.sort((a, b) => reorderOriginal.indexOf(a.id) - reorderOriginal.indexOf(b.id));
  reorderMode = false;
  render();
}

function reorderBefore(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  const sourceIndex = printers.findIndex(item => item.id === sourceId);
  const targetIndex = printers.findIndex(item => item.id === targetId);
  const [source] = printers.splice(sourceIndex, 1);
  printers.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, source);
  render();
}

function movePrinter(id, direction) {
  const index = printers.findIndex(item => item.id === id);
  const target = index + direction;
  if (target < 0 || target >= printers.length) return;
  [printers[index], printers[target]] = [printers[target], printers[index]];
  render();
}

function setTab(next) {
  const changed = tab !== next;
  tab = next;
  document.querySelectorAll(".tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === next));
  ["fleet", "calendar", "queue", "history"].forEach(name => $("#" + name + "View").classList.toggle("hidden", name !== next));
  if (next === "calendar") {
    if (changed) calendarShouldFocusNow = true;
    renderCalendar();
  }
}

document.querySelectorAll(".tabs button").forEach(button => button.onclick = () => setTab(button.dataset.tab));
document.querySelector("[data-open-tab]").onclick = () => setTab("history");
$("#reorderButton").onclick = beginOrSaveReorder;
$("#cancelReorder").onclick = cancelReorder;
$("#calendarDay").onclick = () => { calendarMode = "day"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarWeek").onclick = () => { calendarMode = "week"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarTwoWeeks").onclick = () => { calendarMode = "twoWeeks"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarThreeWeeks").onclick = () => { calendarMode = "threeWeeks"; calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarPrev").onclick = () => { calendarDate = addDays(calendarDate, -({ day: 1, week: 7, twoWeeks: 14, threeWeeks: 21 }[calendarMode])); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarNext").onclick = () => { calendarDate = addDays(calendarDate, { day: 1, week: 7, twoWeeks: 14, threeWeeks: 21 }[calendarMode]); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarToday").onclick = () => { calendarDate = startOfDay(new Date()); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarDate").onchange = event => { if (event.target.value) calendarDate = startOfDay(`${event.target.value}T00:00:00`); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarShowAll").onclick = event => {
  event.preventDefault();
  calendarSelectedPrinters = new Set(printers.map(printer => printer.id));
  saveCalendarFilter();
  renderCalendar();
};
$("#closeModal").onclick = closeModal;
$("#modal").onclick = event => { if (event.target === $("#modal")) closeModal(); };
setInterval(render, 30000);
load();

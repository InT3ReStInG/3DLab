const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

let printers = [];
let activity = [];
let savedJobs = [];
let tab = "fleet";
let jobsTab = "queue";
let reorderMode = false;
let reorderActor = "";
let reorderOriginal = [];
let reorderDrag = null;
let reorderScrollFrame = null;
let calendarDate = startOfDay(new Date());
const calendarZoomLevels = [5, 7, 9, 12, 16];
let calendarZoomIndex = 2;
let calendarSelectedPrinters = new Set();
let calendarKnownPrinters = new Set();
let calendarFilterInitialized = false;
let calendarScroll = { top: 0, left: 0 };
let calendarShouldFocusNow = true;
let rememberedActor = "";
let pendingSavedJobId = null;
let calendarScheduledDrag = null;
let currentUser = null;
const SESSION_TOKEN_KEY = "pl750-session-token";
let sessionToken = readSessionToken();

function readSessionToken() {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY) || sessionStorage.getItem(SESSION_TOKEN_KEY) || "";
  } catch (_) {
    return "";
  }
}

function saveSessionToken(token, remember) {
  sessionToken = String(token || "");
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    if (sessionToken) (remember ? localStorage : sessionStorage).setItem(SESSION_TOKEN_KEY, sessionToken);
  } catch (_) {}
}

function clearSessionToken() {
  sessionToken = "";
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch (_) {}
}

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
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dateTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" })} · ${timeValue(date)}`;
}

function shortDateTime(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} · ${timeValue(date)}`;
}

function timeField(name, value) {
  return `<input name="${name}" required type="text" inputmode="numeric" autocomplete="off" data-time-24 maxlength="5" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" title="Saati 24 saat biçiminde SS:DD olarak girin (ör. 14:30)" placeholder="SS:DD" value="${timeValue(value)}">`;
}

function parseDateTime24(dateText, timeText) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  const timeMatch = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(timeText || ""));
  if (!dateMatch || !timeMatch) throw new Error("Saati 24 saat biçiminde SS:DD olarak girin (ör. 14:30)");
  return new Date(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  ).getTime();
}

function bind24HourInputs() {
  document.querySelectorAll("[data-time-24]").forEach(input => {
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 4);
      input.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    });
  });
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
  $("#headerTime").textContent = `${timeValue(now)}:${String(now.getSeconds()).padStart(2, "0")}`;
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

function preciseDurationText(total) {
  const value = Math.max(0, Math.round(Number(total) || 0));
  if (!value) return "0 dk";
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return hours ? `${hours} sa${mins ? ` ${mins} dk` : ""}` : `${mins} dk`;
}

function relative(at) {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "az önce";
  if (mins < 60) return `${mins} dk önce`;
  if (mins < 1440) return `${Math.round(mins / 60)} sa önce`;
  return new Date(at).toLocaleDateString("tr-TR");
}

function makeEntry(action, detail, user) {
  return { id: makeId(), action, detail, user: String(user || currentUser?.name || "").trim(), at: Date.now() };
}

function samePerson(first, second) {
  const clean = value => String(value || "").trim().replace(/\s+/g, " ");
  return clean(first).localeCompare(clean(second), "tr", { sensitivity: "base" }) === 0;
}

function rememberActor(value) {
  rememberedActor = currentUser?.name || String(value || "").trim();
}

async function api(body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const options = {
    method: body ? "POST" : "GET",
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  };
  const response = await fetch("/api/state", options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Değişiklik kaydedilemedi");
    error.code = data.code;
    throw error;
  }
  return data;
}

async function authApi(body) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const response = await fetch("/api/auth", {
    method: body ? "POST" : "GET",
    headers,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Kimlik doğrulama işlemi başarısız");
  return data;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 3000);
}

function renderAuth() {
  const area = $("#authArea");
  if (!currentUser) {
    area.innerHTML = '<button class="header-button" id="loginButton">Giriş yap</button><button class="header-button primary" id="registerButton">Kayıt ol</button>';
    $("#loginButton").onclick = () => authForm("login");
    $("#registerButton").onclick = () => authForm("register");
    return;
  }
  area.innerHTML = `<div class="account-chip"><div class="account-copy"><b>${esc(currentUser.name)}</b><small>${currentUser.canEdit ? "Değişiklik yetkisi var" : "Onay bekliyor"}</small></div><button class="header-button" id="logoutButton">Çıkış</button></div>`;
  $("#logoutButton").onclick = logout;
}

function bindPasswordToggles() {
  document.querySelectorAll("[data-password-toggle]").forEach(button => {
    const input = button.parentElement.querySelector("input");
    const touchDevice = window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches;
    const supportsTextMask = Boolean(touchDevice && window.CSS?.supports?.("-webkit-text-security", "disc"));
    if (supportsTextMask) {
      input.type = "text";
      input.classList.add("masked-password");
    }
    button.onclick = () => {
      const visible = button.classList.toggle("is-visible");
      if (supportsTextMask) input.classList.toggle("password-visible", visible);
      else input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", visible ? "Şifreyi gizle" : "Şifreyi göster");
    };
  });
}

function passwordToggleButton() {
  return `<button class="password-toggle" type="button" data-password-toggle aria-label="Şifreyi göster" aria-pressed="false"><svg class="eye-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.7"></circle></svg><svg class="eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"></path><path d="M10.6 6.1A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.3 3.1M6.2 6.2C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-.9"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg></button>`;
}

function authForm(mode = "login") {
  const registering = mode === "register";
  const toggle = passwordToggleButton();
  const repeatField = registering ? `<label class="password-field">Şifreyi tekrarlayın<input name="passwordRepeat" required minlength="6" maxlength="128" type="password" autocomplete="new-password">${toggle}</label>` : "";
  showModal(`<form class="form auth-form"><h2>${registering ? "Kayıt ol" : "Giriş yap"}</h2><p class="form-intro">${registering ? "Hesabınız oluşturulduktan sonra değişiklik yetkisi laboratuvar sorumlusu tarafından açılır." : "Yazıcılar üzerinde değişiklik yapmak için hesabınıza giriş yapın."}</p><label>Adınız<input name="name" required minlength="2" maxlength="80" autocomplete="username" placeholder="Ad soyad"></label><label class="password-field">Şifre<input name="password" required minlength="6" maxlength="128" type="password" autocomplete="${registering ? "new-password" : "current-password"}" placeholder="En az 6 karakter">${toggle}</label>${repeatField}<label class="remember-row"><input name="remember" type="checkbox"> Beni hatırla</label><button class="submit">${registering ? "HESAP OLUŞTUR" : "GİRİŞ YAP"}</button><p class="auth-switch">${registering ? "Zaten hesabınız var mı?" : "Hesabınız yok mu?"} <button type="button" id="authSwitch">${registering ? "Giriş yapın" : "Kayıt olun"}</button></p></form>`, async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const submit = form.querySelector(".submit");
    submit.disabled = true;
    try {
      const remember = data.get("remember") === "on";
      const result = await authApi({
        mode,
        name: String(data.get("name") || "").trim(),
        password: String(data.get("password") || ""),
        passwordRepeat: String(data.get("passwordRepeat") || ""),
        remember,
      });
      saveSessionToken(result.sessionToken, remember);
      currentUser = result.user;
      rememberedActor = currentUser?.name || "";
      closeModal();
      renderAuth();
      render();
      await load(true);
      if (!currentUser) throw new Error("Oturum kaydedilemedi. Lütfen tekrar deneyin.");
      if (currentUser?.canEdit) toast("Giriş yapıldı");
      else showApprovalMessage();
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  });
  $("#authSwitch").onclick = () => authForm(registering ? "login" : "register");
  bindPasswordToggles();
}

function showApprovalMessage() {
  showModal(`<div class="approval-card"><div class="approval-icon">⌛</div><h2>Onay bekleniyor</h2><p><b>${esc(currentUser?.name || "Hesabınız")}</b> ile giriş yaptınız. Yazıcıları görüntüleyebilir ve kendi kart sıralamanızı değiştirebilirsiniz; diğer değişiklikler için laboratuvar sorumlusunun onayı gerekir.</p><button class="submit" id="approvalClose">TAMAM</button></div>`);
  $("#approvalClose").onclick = closeModal;
}

function requireAccount() {
  if (currentUser) return true;
  authForm("login");
  return false;
}

function requireEditAccess() {
  if (!requireAccount()) return false;
  if (!currentUser.canEdit) {
    showApprovalMessage();
    return false;
  }
  return true;
}

const guarded = callback => (...args) => {
  if (requireEditAccess()) return callback(...args);
};

const guardedAccount = callback => (...args) => {
  if (requireAccount()) return callback(...args);
};

async function logout() {
  try {
    await authApi({ mode: "logout" });
  } catch (error) {
    toast(error.message);
  }
  clearSessionToken();
  currentUser = null;
  rememberedActor = "";
  reorderMode = false;
  closeModal();
  await load(true);
  toast("Çıkış yapıldı");
}

async function load(silent = false) {
  if (silent && reorderMode) return;
  try {
    const data = await api();
    printers = (data.printers || []).map(normalizePrinter);
    activity = data.activity || [];
    savedJobs = Array.isArray(data.savedJobs) ? data.savedJobs : [];
    currentUser = data.user || null;
    if (!currentUser && sessionToken) clearSessionToken();
    rememberedActor = currentUser?.name || "";
    renderAuth();
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
  if (action === "reorderPrinters" ? !requireAccount() : !requireEditAccess()) return null;
  try {
    const data = await api({ action, ...payload, entry });
    printers = (data.state?.printers || printers).map(normalizePrinter);
    activity = data.state?.activity || activity;
    savedJobs = Array.isArray(data.state?.savedJobs) ? data.state.savedJobs : savedJobs;
    currentUser = data.state?.user || currentUser;
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
  $("#jobsCount").textContent = rows.length + savedJobs.length;
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
    ${reorderControls || `<div class="card-tools"><button data-reserve="${printer.id}" ${serviceLocked ? "disabled" : ""}>▦ Rezerve et</button><button data-printer-stats="${printer.id}" aria-label="Yazıcı istatistikleri" title="İstatistikler">ⓘ</button><button data-edit-printer="${printer.id}" aria-label="Yazıcıyı düzenle" title="Düzenle">✎</button>${printer.status === "printing" ? `<button class="cancel-print" data-cancel-print="${printer.id}" aria-label="Mevcut baskıyı iptal et" title="Mevcut baskıyı iptal et">■</button>` : `<button data-maintenance="${printer.id}" aria-label="Servis durumu" title="Bakım / arıza durumu">⚙</button>`}</div>`}
  </article>`;
}

function printerStats(printer) {
  const now = Date.now();
  const history = [...printer.printHistory];
  const currentStart = printStartedAt(printer);
  const finishedCurrent = printer.status === "finished" && currentStart && printer.endsAt
    ? [{ startAt: currentStart, endAt: Number(printer.endsAt) }]
    : [];
  const completed = [...history, ...finishedCurrent];
  const completedMinutes = completed.reduce((sum, item) => sum + Math.max(0, Number(item.endAt) - Number(item.startAt)), 0) / 60000;
  const activeMinutes = printer.status === "printing" && currentStart
    ? Math.max(0, now - currentStart) / 60000
    : 0;
  const durations = completed.map(item => Math.max(0, Number(item.endAt) - Number(item.startAt)) / 60000);
  const lastCompleted = completed.sort((a, b) => Number(b.endAt) - Number(a.endAt))[0];
  const thirtyDaysAgo = now - 30 * 86400000;
  const recentMinutes = completed.reduce((sum, item) => {
    const start = Math.max(Number(item.startAt), thirtyDaysAgo);
    const end = Math.min(Number(item.endAt), now);
    return sum + Math.max(0, end - start) / 60000;
  }, 0) + (printer.status === "printing" && currentStart ? Math.max(0, now - Math.max(currentStart, thirtyDaysAgo)) / 60000 : 0);
  return {
    completedCount: completed.length,
    completedMinutes,
    activeMinutes,
    averageMinutes: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
    longestMinutes: durations.length ? Math.max(...durations) : 0,
    utilization: Math.min(100, recentMinutes / (30 * 24 * 60) * 100),
    lastCompleted,
    queued: printer.queue.length,
    planned: printer.reservations.filter(item => item.kind === "scheduled" && item.endAt > now).length,
    reservations: printer.reservations.filter(item => item.kind !== "scheduled" && item.endAt > now).length,
  };
}

function printerStatsInfo(id) {
  const printer = printers.find(item => item.id === id);
  if (!printer) return toast("Yazıcı bulunamadı");
  const stats = printerStats(printer);
  const totalWithActive = stats.completedMinutes + stats.activeMinutes;
  showModal(`<div class="info-sheet printer-stats-sheet"><small>YAZICI İSTATİSTİKLERİ</small><h2>${esc(printer.name)}</h2><p>İstatistikler sistemde kayıtlı baskı geçmişine göre hesaplanır.</p><div class="stats-hero"><div><b>${stats.completedCount}</b><span>Tamamlanan baskı</span></div><div><b>${preciseDurationText(totalWithActive)}</b><span>Toplam çalışma</span></div><div><b>%${stats.utilization.toFixed(1).replace(".0", "")}</b><span>Son 30 gün kullanım</span></div></div><div class="info-grid"><div><span>Ortalama baskı</span><b>${stats.averageMinutes ? preciseDurationText(stats.averageMinutes) : "—"}</b></div><div><span>En uzun baskı</span><b>${stats.longestMinutes ? preciseDurationText(stats.longestMinutes) : "—"}</b></div><div><span>Sıradaki işler</span><b>${stats.queued}</b></div><div><span>Planlı baskılar</span><b>${stats.planned}</b></div><div><span>Rezervasyonlar</span><b>${stats.reservations}</b></div><div><span>Son tamamlanan</span><b>${stats.lastCompleted ? dateTime(stats.lastCompleted.endAt) : "—"}</b></div></div>${printer.status === "printing" ? `<div class="stat-active-note">Şu anki baskıda ${preciseDurationText(stats.activeMinutes)} çalışma kaydedildi · %${printProgress(printer)}</div>` : ""}</div>`);
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
    ? `<div class="row-actions"><button data-edit-planned="${item.printerId}" data-reservation="${item.reservationId}">✎ Düzenle</button><button class="danger-link" data-cancel-reservation="${item.printerId}" data-reservation="${item.reservationId}">İptal et</button></div>`
    : `<div class="row-actions"><button data-edit-queue="${item.printerId}" data-job="${item.id}">✎ Düzenle</button><button class="danger-link" data-delete-queue="${item.printerId}" data-job="${item.id}">Sil</button></div>`;
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
  const activePrinter = printers.find(printer => printer.status === "printing" && printer.savedJobId === job.id);
  const planned = printers.flatMap(printer => printer.reservations
    .filter(item => item.kind === "scheduled" && item.savedJobId === job.id && Number(item.endAt) > Date.now())
    .map(item => ({ ...item, printerName: printer.name })))
    .sort((first, second) => Number(first.startAt) - Number(second.startAt))[0];
  const jobStatus = activePrinter
    ? `<span class="saved-job-status">● ŞU ANDA BASILIYOR · ${esc(activePrinter.name)}</span>`
    : planned
    ? `<span class="saved-job-status planned">● TAKVİMDE PLANLANDI · ${esc(planned.printerName)} · ${dateTime(planned.startAt)}</span>`
    : "";
  return `<div class="saved-job-row ${activePrinter ? "is-printing" : planned ? "is-planned" : ""}"><div class="saved-job-icon">▣</div><div><b>${esc(job.name)}</b>${jobStatus}<span class="saved-job-duration">${durationText(job.duration)}</span><small>${created}</small></div><div class="row-actions"><button data-use-saved="${job.id}">Takvimde kullan</button><button data-edit-saved="${job.id}">Düzenle</button><button class="danger-link" data-delete-saved="${job.id}">Sil</button></div></div>`;
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
  const dayCount = 31;
  const first = addDays(startOfDay(calendarDate), -3);
  const end = addDays(first, dayCount);
  const totalHours = dayCount * 24;
  const hourWidth = calendarZoomLevels[calendarZoomIndex];
  const selected = printers.filter(printer => calendarSelectedPrinters.has(printer.id));
  $("#calendarTitle").textContent = `${first.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} – ${addDays(first, dayCount - 1).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" })}`;
  $("#calendarZoomLabel").textContent = `%${[60, 80, 100, 130, 170][calendarZoomIndex]}`;
  $("#calendarZoomOut").disabled = calendarZoomIndex === 0;
  $("#calendarZoomIn").disabled = calendarZoomIndex === calendarZoomLevels.length - 1;
  const timeWidth = totalHours * hourWidth;
  const minWidth = 150 + timeWidth;
  const rangeStart = first.getTime();
  const rangeEnd = end.getTime();
  const now = Date.now();
  const nowLeft = (now - rangeStart) / 3600000 * hourWidth;
  const nowVisible = now >= rangeStart && now < rangeEnd;
  const dayLines = Array.from({ length: dayCount - 1 }, (_, index) => `<i class="horizontal-day-divider" style="left:${(index + 1) * 24 * hourWidth}px"></i>`).join("");
  const weekendBands = Array.from({ length: dayCount }, (_, index) => {
    const date = addDays(first, index);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    return weekend ? `<i class="horizontal-weekend-band" style="left:${index * 24 * hourWidth}px;width:${24 * hourWidth}px" title="${date.getDay() === 6 ? "Cumartesi" : "Pazar"}"></i>` : "";
  }).join("");
  const progressMarkers = nowVisible ? selected.map((printer, index) => {
    if (printer.status !== "printing" || !printer.endsAt || printer.endsAt <= now) return "";
    const progress = printProgress(printer);
    return `<b class="horizontal-now-progress" style="top:${index * 86 + 43}px" title="${esc(printer.name)} · %${progress} tamamlandı">%${progress}</b>`;
  }).join("") : "";
  const nowLine = nowVisible ? `<i class="horizontal-now-line" style="left:${nowLeft}px"><span>Şimdi · ${timeValue(now)}</span>${progressMarkers}</i>` : "";

  $("#calendarGrid").innerHTML = selected.length ? `<div class="timeline-scroll horizontal month" id="calendarTimeline"><div class="horizontal-board" style="--printer-count:${selected.length};--hour-width:${hourWidth}px;--time-width:${timeWidth}px;--timeline-min-width:${minWidth}px"><div class="horizontal-corner">Yazıcı</div><div class="horizontal-time-head">${horizontalTimeScale(first, totalHours, hourWidth)}</div><div class="horizontal-printer-labels">${selected.map(horizontalPrinterLabel).join("")}</div><div class="horizontal-lanes">${selected.map(printer => horizontalLane(printer, rangeStart, rangeEnd, hourWidth)).join("")}${weekendBands}${dayLines}${nowLine}</div></div></div>` : empty("En az bir yazıcı seçin");

  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(cancelReservation)(button.dataset.cancelReservation, button.dataset.reservation); });
  document.querySelectorAll("[data-active-calendar-print]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); activePrintInfo(eventElement.dataset.activeCalendarPrint); });
  document.querySelectorAll("[data-calendar-print-history]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); printHistoryInfo(eventElement.dataset.historyPrinter, eventElement.dataset.calendarPrintHistory); });
  document.querySelectorAll("[data-calendar-scheduled]").forEach(eventElement => eventElement.onclick = event => { event.stopPropagation(); scheduledPrintInfo(eventElement.dataset.scheduledPrinter, eventElement.dataset.calendarScheduled); });
  document.querySelectorAll("[data-delay-current]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(delayPrintForm)(button.dataset.delayCurrent); });
  document.querySelectorAll("[data-delay-scheduled]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(delayPrintForm)(button.dataset.delayPrinter, button.dataset.delayScheduled); });
  bindScheduledPrintDrag();
  document.querySelectorAll("[data-calendar-lane]").forEach(lane => lane.onclick = event => {
    if (event.target.closest(".horizontal-event")) return;
    const rect = lane.getBoundingClientRect();
    const clickedHours = (event.clientX - rect.left) / hourWidth;
    const rawStart = rangeStart + clickedHours * 3600000;
    const startAt = Math.round(rawStart / 900000) * 900000;
    if (startAt < Date.now() - 60000) return toast("Geçmiş bir saate baskı planlanamaz");
    if (requireEditAccess()) scheduledPrintForm(lane.dataset.calendarLane, startAt);
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
  const labelEvery = hourWidth >= 12 ? 2 : hourWidth >= 8 ? 3 : 6;
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = addDays(first, index);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    return `<div class="${weekend ? "weekend" : ""}" style="width:${24 * hourWidth}px">${date.toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" })}</div>`;
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
    return `<div class="horizontal-lane" data-calendar-lane="${printer.id}" data-range-start="${rangeStart}" data-range-end="${rangeEnd}" data-hour-width="${hourWidth}"><div class="horizontal-event ${broken ? "broken" : "maintenance"}" style="left:3px;width:${Math.max(30, width - 6)}px"><b>${broken ? "✕ Arızalı" : "Bakımda"}</b><span>${esc(printer.maintenanceNote || (broken ? "Servis dışı" : "Bakım modu"))}</span></div></div>`;
  }
  const events = scheduleEvents(printer)
    .filter(item => item.startAt < rangeEnd && item.endAt > rangeStart)
    .map(item => horizontalEvent(item, printer, rangeStart, rangeEnd, hourWidth))
    .join("");
  return `<div class="horizontal-lane" data-calendar-lane="${printer.id}" data-range-start="${rangeStart}" data-range-end="${rangeEnd}" data-hour-width="${hourWidth}" title="Boş alana tıklayarak baskı planlayın">${events}</div>`;
}

function horizontalEvent(item, printer, rangeStart, rangeEnd, hourWidth) {
  const clippedStart = Math.max(item.startAt, rangeStart);
  const clippedEnd = Math.min(item.endAt, rangeEnd);
  const left = (clippedStart - rangeStart) / 3600000 * hourWidth;
  const width = Math.max(28, (clippedEnd - clippedStart) / 3600000 * hourWidth);
  const typeText = { print: "Baskı", reservation: "Rezervasyon", scheduled: "Planlı baskı", queue: "Sıra" }[item.type];
  const fullRange = `${shortDateTime(item.startAt)} → ${shortDateTime(item.endAt)}`;
  const completed = item.endAt <= Date.now() && ["print", "scheduled"].includes(item.type);
  const upcoming = item.startAt > Date.now() && item.startAt - Date.now() <= 60 * 60000 && ["reservation", "scheduled"].includes(item.type);
  const cancel = item.type === "reservation" ? `<button data-cancel-reservation="${printer.id}" data-reservation="${item.reservationId}" aria-label="Rezervasyonu iptal et">×</button>` : "";
  const interaction = item.active
    ? `data-active-calendar-print="${printer.id}"`
    : item.archived
    ? `data-calendar-print-history="${item.id}" data-history-printer="${printer.id}"`
    : item.type === "scheduled"
    ? `data-calendar-scheduled="${item.reservationId}" data-scheduled-printer="${printer.id}"`
    : "";
  const dragHandle = item.type === "scheduled" && !completed
    ? `<button type="button" class="scheduled-drag-handle" draggable="true" data-drag-scheduled="${item.reservationId}" data-drag-printer="${printer.id}" aria-label="Planlı baskıyı başka yazıcıya taşı" title="Bu köşeden tutup başka yazıcıya sürükleyin">⠿</button>`
    : "";
  const timeControl = item.active
    ? `<button type="button" class="event-time-control" data-delay-current="${printer.id}" aria-label="Baskı süresini güncelle" title="Baskı süresini güncelle">◷</button>`
    : item.type === "scheduled" && !completed
    ? `<button type="button" class="event-time-control" data-delay-scheduled="${item.reservationId}" data-delay-printer="${printer.id}" aria-label="Planlı baskıyı geciktir" title="Planlı baskıyı geciktir">◷</button>`
    : "";
  return `<div class="horizontal-event ${item.type} ${completed ? "completed" : ""} ${upcoming ? "upcoming" : ""} ${interaction ? "interactive" : ""} ${width < 105 ? "compact" : ""}" ${interaction} style="left:${left + 2}px;width:${Math.max(24, width - 4)}px" title="${esc(item.label)} · ${esc(item.owner)} · ${esc(fullRange)}${completed ? " · Tamamlandı" : upcoming ? " · Bir saatten az kaldı" : ""}"><div><small>${completed ? "✓ Tamamlandı" : upcoming ? `⚠ ${remaining(item.startAt)} kaldı` : typeText} · ${esc(fullRange)}</small><b>${esc(item.label)}</b><span>${esc(item.owner)}</span></div>${dragHandle}${timeControl}${completed ? "" : cancel}</div>`;
}

function clearScheduledDropPreview() {
  document.querySelectorAll(".scheduled-drop-target").forEach(element => element.classList.remove("scheduled-drop-target"));
  document.querySelectorAll(".scheduled-drop-preview").forEach(element => element.remove());
}

function clearScheduledDragUi() {
  document.querySelectorAll(".scheduled-dragging").forEach(element => element.classList.remove("scheduled-dragging"));
  clearScheduledDropPreview();
}

function scheduledDragDetails(handle, clientX) {
  const source = printers.find(item => item.id === handle.dataset.dragPrinter);
  const reservation = source?.reservations?.find(item => item.id === handle.dataset.dragScheduled && item.kind === "scheduled");
  const eventElement = handle.closest(".horizontal-event");
  const lane = handle.closest("[data-calendar-lane]");
  if (!source || !reservation || !eventElement || !lane) return null;
  const hourWidth = Number(lane.dataset.hourWidth);
  const offsetPixels = Math.max(0, clientX - eventElement.getBoundingClientRect().left);
  return {
    sourcePrinterId: source.id,
    reservationId: reservation.id,
    duration: Number(reservation.endAt) - Number(reservation.startAt),
    grabOffset: offsetPixels / hourWidth * 3600000,
    targetPrinterId: null,
    startAt: null,
    endAt: null,
  };
}

function updateScheduledDropPreview(lane, clientX, drag) {
  clearScheduledDropPreview();
  if (!lane || !drag) return;
  const rangeStart = Number(lane.dataset.rangeStart);
  const rangeEnd = Number(lane.dataset.rangeEnd);
  const hourWidth = Number(lane.dataset.hourWidth);
  const laneRect = lane.getBoundingClientRect();
  const pointerTime = rangeStart + (clientX - laneRect.left) / hourWidth * 3600000;
  const latestStart = Math.max(rangeStart, rangeEnd - drag.duration);
  const rawStart = pointerTime - drag.grabOffset;
  const startAt = Math.min(latestStart, Math.max(rangeStart, Math.round(rawStart / 900000) * 900000));
  const endAt = startAt + drag.duration;
  const preview = document.createElement("div");
  const targetPrinter = printers.find(item => item.id === lane.dataset.calendarLane);
  const unavailable = ["maintenance", "broken"].includes(targetPrinter?.status);
  const invalid = startAt < Date.now() - 60000 || unavailable;
  preview.className = `scheduled-drop-preview ${invalid ? "invalid" : ""}`;
  preview.style.left = `${(startAt - rangeStart) / 3600000 * hourWidth + 2}px`;
  preview.style.width = `${Math.max(24, drag.duration / 3600000 * hourWidth - 4)}px`;
  const message = unavailable ? (targetPrinter.status === "broken" ? "Arızalı yazıcıya taşınamaz" : "Bakımdaki yazıcıya taşınamaz") : invalid ? "Geçmiş saate taşınamaz" : "Buraya taşınacak";
  preview.innerHTML = `<b>${message}</b><span>${dateTime(startAt)} → ${timeValue(endAt)}</span>`;
  lane.append(preview);
  lane.classList.add("scheduled-drop-target");
  drag.targetPrinterId = lane.dataset.calendarLane;
  drag.startAt = startAt;
  drag.endAt = endAt;
  drag.invalid = invalid;
}

async function moveScheduledPrint(sourcePrinterId, targetPrinterId, reservationId, startAt, endAt) {
  if (!sourcePrinterId || !targetPrinterId || !Number.isFinite(startAt) || !Number.isFinite(endAt)) return;
  const source = printers.find(item => item.id === sourcePrinterId);
  const target = printers.find(item => item.id === targetPrinterId);
  const reservation = source?.reservations?.find(item => item.id === reservationId && item.kind === "scheduled");
  if (!source || !target || !reservation) return toast("Planlı baskı bulunamadı");
  try {
    await mutate("moveScheduledPrint", { printerId: source.id, targetPrinterId: target.id, reservationId, startAt }, makeEntry("Planlı baskı takvimde taşındı", `${reservation.purpose} · ${source.name} ${dateTime(reservation.startAt)} → ${target.name} ${dateTime(startAt)}`, currentUser?.name || ""), "Planlı baskının yazıcısı ve zamanı güncellendi");
  } catch (_) {}
}

function bindScheduledPrintDrag() {
  const handles = document.querySelectorAll("[data-drag-scheduled]");
  const lanes = document.querySelectorAll("[data-calendar-lane]");
  handles.forEach(handle => {
    handle.draggable = Boolean(currentUser?.canEdit);
    handle.onclick = event => event.stopPropagation();
    handle.ondragstart = event => {
      event.stopPropagation();
      if (!requireEditAccess()) return event.preventDefault();
      calendarScheduledDrag = scheduledDragDetails(handle, event.clientX);
      if (!calendarScheduledDrag) return event.preventDefault();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", JSON.stringify(calendarScheduledDrag));
      handle.closest(".horizontal-event")?.classList.add("scheduled-dragging");
    };
    handle.ondragend = () => {
      calendarScheduledDrag = null;
      clearScheduledDragUi();
    };
    handle.onpointerdown = event => {
      event.stopPropagation();
      if (event.pointerType !== "touch" || !currentUser?.canEdit) return;
      const drag = { ...scheduledDragDetails(handle, event.clientX), pointerId: event.pointerId, active: false };
      if (!drag.sourcePrinterId) return;
      drag.timer = setTimeout(() => {
        drag.active = true;
        calendarScheduledDrag = drag;
        handle.closest(".horizontal-event")?.classList.add("scheduled-dragging");
        if (navigator.vibrate) navigator.vibrate(35);
      }, 250);
      calendarScheduledDrag = drag;
      handle.setPointerCapture?.(event.pointerId);
    };
    handle.onpointermove = event => {
      const drag = calendarScheduledDrag;
      if (!drag || drag.pointerId !== event.pointerId || !drag.active) return;
      event.preventDefault();
      const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-calendar-lane]");
      updateScheduledDropPreview(lane, event.clientX, drag);
    };
    handle.onpointerup = event => {
      const drag = calendarScheduledDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      clearTimeout(drag.timer);
      if (drag.active && drag.targetPrinterId && !drag.invalid) moveScheduledPrint(drag.sourcePrinterId, drag.targetPrinterId, drag.reservationId, drag.startAt, drag.endAt);
      calendarScheduledDrag = null;
      clearScheduledDragUi();
    };
    handle.onpointercancel = handle.onpointerup;
  });
  lanes.forEach(lane => {
    lane.ondragover = event => {
      if (!calendarScheduledDrag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      updateScheduledDropPreview(lane, event.clientX, calendarScheduledDrag);
    };
    lane.ondragleave = event => {
      if (!lane.contains(event.relatedTarget)) clearScheduledDropPreview();
    };
    lane.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      const drag = calendarScheduledDrag;
      clearScheduledDragUi();
      if (drag && !drag.invalid) moveScheduledPrint(drag.sourcePrinterId, lane.dataset.calendarLane, drag.reservationId, drag.startAt, drag.endAt);
      calendarScheduledDrag = null;
    };
  });
}

function bindDynamicControls() {
  document.querySelectorAll("[data-open]").forEach(button => button.onclick = () => openPrinter(button.dataset.open));
  document.querySelectorAll("[data-printer-stats]").forEach(button => button.onclick = event => { event.stopPropagation(); printerStatsInfo(button.dataset.printerStats); });
  document.querySelectorAll("[data-delete]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(removePrinter)(button.dataset.delete); });
  document.querySelectorAll("[data-reserve]").forEach(button => button.onclick = guarded(() => reserveForm(button.dataset.reserve)));
  document.querySelectorAll("[data-edit-printer]").forEach(button => button.onclick = guarded(() => editPrinterForm(button.dataset.editPrinter)));
  document.querySelectorAll("[data-maintenance]").forEach(button => button.onclick = guarded(() => maintenanceForm(button.dataset.maintenance)));
  document.querySelectorAll("[data-cancel-print]").forEach(button => button.onclick = guarded(() => cancelCurrentPrint(button.dataset.cancelPrint)));
  document.querySelectorAll("[data-edit-planned]").forEach(button => button.onclick = guarded(() => editPlannedForm(button.dataset.editPlanned, button.dataset.reservation)));
  document.querySelectorAll("[data-edit-queue]").forEach(button => button.onclick = guarded(() => editQueueForm(button.dataset.editQueue, button.dataset.job)));
  document.querySelectorAll("[data-delete-queue]").forEach(button => button.onclick = guarded(() => deleteQueueJob(button.dataset.deleteQueue, button.dataset.job)));
  document.querySelectorAll("[data-use-saved]").forEach(button => button.onclick = guarded(() => useSavedJob(button.dataset.useSaved)));
  document.querySelectorAll("[data-edit-saved]").forEach(button => button.onclick = guarded(() => savedJobForm(button.dataset.editSaved)));
  document.querySelectorAll("[data-delete-saved]").forEach(button => button.onclick = guarded(() => deleteSavedJob(button.dataset.deleteSaved)));
  document.querySelectorAll("[data-printed-info]").forEach(button => button.onclick = () => printHistoryInfo(button.dataset.printedInfo, button.dataset.printId));
  document.querySelectorAll("[data-cancel-reservation]").forEach(button => button.onclick = guarded(() => cancelReservation(button.dataset.cancelReservation, button.dataset.reservation)));
  document.querySelectorAll("[data-delay-current]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(delayPrintForm)(button.dataset.delayCurrent); });
  document.querySelectorAll("[data-delay-scheduled]").forEach(button => button.onclick = event => { event.stopPropagation(); guarded(delayPrintForm)(button.dataset.delayPrinter, button.dataset.delayScheduled); });
  document.querySelectorAll("[data-move]").forEach(button => button.onclick = guardedAccount(() => movePrinter(button.dataset.id, Number(button.dataset.move))));
  const add = $("[data-add]");
  if (add) add.onclick = guarded(addForm);

  if (reorderMode) {
    document.querySelectorAll("[data-printer]").forEach(cardElement => {
      cardElement.onpointerdown = startReorderDrag;
    });
  }
}

function showModal(html, onSubmit) {
  $("#modalContent").innerHTML = html;
  $("#modal").classList.remove("hidden");
  bind24HourInputs();
  const form = $("#modalContent form");
  const actorInput = form?.querySelector('[name="actor"]');
  if (actorInput) actorInput.value = currentUser?.name || rememberedActor;
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
  if (!requireEditAccess()) return;
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
  showModal(`<div class="info-sheet"><small>DEVAM EDEN BASKI</small><input class="inline-title-input" id="currentPrintName" value="${esc(printer.job)}" aria-label="Baskı adını düzenle"><small class="inline-edit-hint">Adı değiştirip Enter'a basın veya dışarı dokunun</small><p>${esc(printer.name)} · ${esc(printer.owner)}</p><div class="info-grid"><div><span>Başlangıç</span><b>${startedAt ? dateTime(startedAt) : "—"}</b></div><div><span>Tahmini bitiş</span><b>${dateTime(printer.endsAt)}</b></div><div><span>İlerleme</span><b>%${progress}</b></div><div><span>Kalan süre</span><b>${remaining(printer.endsAt)}</b></div></div><div class="modal-progress"><i style="width:${progress}%"></i></div><button class="submit danger" id="calendarCancelCurrent">BASKIYI İPTAL ET</button></div>`);
  $("#currentPrintName").readOnly = !currentUser?.canEdit;
  if (currentUser?.canEdit) bindInlinePrintName($("#currentPrintName"), printer.job, async name => {
    await mutate("editCurrentPrintName", { printerId: id, name }, makeEntry("Devam eden baskının adı değiştirildi", `${printer.job} → ${name} · ${printer.name}`, currentUser.name), "Baskı adı güncellendi");
  });
  $("#calendarCancelCurrent").onclick = guarded(() => {
    closeModal();
    cancelCurrentPrint(id);
  });
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
  $("#deletePrintedHistory").onclick = guarded(() => deletePrintHistoryForm(printer, item));
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
  const savedSelector = savedJobs.length ? `<label>Kayıtlı iş kullan<select name="savedJob" id="scheduledSavedJob"><option value="">Elle gir</option>${savedJobs.map(job => {
    const isPrinting = printers.some(item => item.status === "printing" && item.savedJobId === job.id);
    const isPlanned = printers.some(printer => printer.reservations.some(item => item.kind === "scheduled" && item.savedJobId === job.id && Number(item.endAt) > Date.now()));
    const status = isPrinting ? "🟢 BASKIDA · " : isPlanned ? "🔵 PLANLANDI · " : "";
    return `<option value="${job.id}" ${initialJob?.id === job.id ? "selected" : ""}>${status}${esc(job.name)} · ${durationText(job.duration)}</option>`;
  }).join("")}</select></label>` : "";
  showModal(`<form class="form"><h2>Planlı baskı ekle</h2><p class="form-intro"><b>${esc(printer.name)}</b> için takvimden bir başlangıç zamanı seçtiniz. Tüm saatler 24 saat biçimindedir; çakışan bir zaman kaydedilemez.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label>${savedSelector}<label>Baskı / iş adı<input name="purpose" required value="${esc(initialJob?.name || "")}" placeholder="Örn. Bağlantı braketi"></label><div class="form-grid"><label>Başlangıç tarihi<input name="date" required type="date" value="${dateValue(start)}"></label><label>Başlangıç saati (24 saat)${timeField("time", start)}</label></div><fieldset id="scheduledDuration" class="${initialJob ? "duration-locked" : ""}"><legend>Tahmini süre <span>${initialJob ? "· Kayıtlı iş süresi" : ""}</span></legend>${durationFields("duration", initialJob?.duration || 60)}</fieldset><button class="submit">BASKIYI PLANLA</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const selectedJob = savedJobs.find(item => item.id === String(form.get("savedJob") || ""));
      const duration = selectedJob ? Math.max(1, Number(selectedJob.duration) || 1) : readDuration(form, "duration");
      const startAt = parseDateTime24(form.get("date"), form.get("time"));
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
  showModal(`<form class="form"><h2>${esc(printer.name)} rezervasyonu</h2><p class="form-intro">Tüm saatler 24 saat biçimindedir. Devam eden baskılar, diğer rezervasyonlar ve planlanmış sıra işleriyle çakışan saatler kabul edilmez.</p><label>Adınız<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>Amaç / iş adı<input name="purpose" required placeholder="Prototip baskısı"></label><div class="form-grid"><label>Tarih<input name="date" required type="date" value="${dateValue(defaultStart)}"></label><label>Başlangıç saati (24 saat)${timeField("time", defaultStart)}</label></div><fieldset><legend>Tahmini süre</legend>${durationFields("duration", 60)}</fieldset><button class="submit">REZERVASYONU ONAYLA</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const duration = readDuration(form, "duration");
      const startAt = parseDateTime24(form.get("date"), form.get("time"));
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

function editPlannedForm(printerId, reservationId) {
  const printer = printers.find(item => item.id === printerId);
  const reservation = printer?.reservations?.find(item => item.id === reservationId);
  if (!printer || !reservation) return toast("Planlanan iş bulunamadı");
  const scheduled = reservation.kind === "scheduled";
  const start = new Date(reservation.startAt);
  const duration = Math.max(1, Math.round((Number(reservation.endAt) - Number(reservation.startAt)) / 60000));
  showModal(`<form class="form"><h2>${scheduled ? "Planlı baskıyı" : "Rezervasyonu"} düzenle</h2><p class="form-intro"><b>${esc(printer.name)}</b> · Süre ${durationText(duration)} olarak korunacaktır. Tüm saatler 24 saat biçimindedir.</p><label>İşlemi yapan kişi<input name="actor" required placeholder="Ad soyad" autocomplete="name"></label><label>${scheduled ? "Baskı / iş adı" : "Amaç / iş adı"}<input name="purpose" required value="${esc(reservation.purpose)}"></label><div class="form-grid"><label>Başlangıç tarihi<input name="date" required type="date" value="${dateValue(start)}"></label><label>Başlangıç saati (24 saat)${timeField("time", start)}</label></div><button class="submit">DEĞİŞİKLİKLERİ KAYDET</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const actor = String(form.get("actor")).trim();
      const purpose = String(form.get("purpose")).trim();
      const startAt = parseDateTime24(form.get("date"), form.get("time"));
      const endAt = startAt + duration * 60000;
      closeModal();
      await mutate("editReservation", { printerId, reservationId, purpose, startAt, endAt }, makeEntry(scheduled ? "Planlı baskı düzenlendi" : "Rezervasyon düzenlendi", `${reservation.purpose} → ${purpose} · ${printer.name} · ${dateTime(startAt)}`, actor), "Planlanan iş güncellendi");
    } catch (error) {
      toast(error.message);
    }
  });
}

function scheduledPrintInfo(printerId, reservationId) {
  const printer = printers.find(item => item.id === printerId);
  const reservation = printer?.reservations?.find(item => item.id === reservationId && item.kind === "scheduled");
  if (!printer || !reservation) return toast("Planlı baskı bulunamadı");
  const duration = Math.max(1, Math.round((Number(reservation.endAt) - Number(reservation.startAt)) / 60000));
  const untilStart = Number(reservation.startAt) > Date.now() ? remaining(reservation.startAt) : "Başlangıç zamanı geldi";
  showModal(`<div class="info-sheet"><small>PLANLI BASKI</small><input class="inline-title-input" id="scheduledPrintName" value="${esc(reservation.purpose)}" aria-label="Planlı baskı adını düzenle"><small class="inline-edit-hint">Adı değiştirip Enter'a basın veya dışarı dokunun</small><p>${esc(printer.name)} · ${esc(reservation.owner)}</p><div class="info-grid"><div><span>Başlangıç</span><b>${dateTime(reservation.startAt)}</b></div><div><span>Tahmini bitiş</span><b>${dateTime(reservation.endAt)}</b></div><div><span>Baskı süresi</span><b>${durationText(duration)}</b></div><div><span>Başlangıca kalan</span><b>${esc(untilStart)}</b></div></div><div class="info-actions"><button class="submit" id="calendarEditScheduled">✎ DÜZENLE</button><button class="submit danger" id="calendarCancelScheduled">İPTAL ET</button></div></div>`);
  $("#scheduledPrintName").readOnly = !currentUser?.canEdit;
  if (currentUser?.canEdit) bindInlinePrintName($("#scheduledPrintName"), reservation.purpose, async name => {
    await mutate("editScheduledPrintName", { printerId, reservationId, name }, makeEntry("Planlı baskının adı değiştirildi", `${reservation.purpose} → ${name} · ${printer.name}`, currentUser.name), "Planlı baskı adı güncellendi");
  });
  $("#calendarEditScheduled").onclick = guarded(() => {
    closeModal();
    editPlannedForm(printerId, reservationId);
  });
  $("#calendarCancelScheduled").onclick = guarded(() => {
    closeModal();
    cancelReservation(printerId, reservationId);
  });
}

function delayPrintForm(printerId, reservationId = null) {
  const printer = printers.find(item => item.id === printerId);
  const reservation = reservationId
    ? printer?.reservations?.find(item => item.id === reservationId && item.kind === "scheduled")
    : null;
  if (!printer || (reservationId && !reservation)) return toast("Baskı bulunamadı");
  if (!reservation && printer.status !== "printing") return toast("Devam eden baskı bulunamadı");
  const current = !reservation;
  const title = reservation?.purpose || printer.job;
  const currentProgress = current ? printProgress(printer) : null;
  showModal(`<form class="form delay-form"><h2>Baskı süresini güncelle</h2><p class="form-intro"><b>${esc(title)}</b> · ${esc(printer.name)}<br>Sonraki planlar gerekirse otomatik olarak ileri alınır.</p>${current ? `<label>Güncelleme yöntemi<select name="mode" id="delayMode"><option value="minutes">Bitişi geciktir</option><option value="percent">Gerçek ilerleme yüzdesini gir</option><option value="startedEarlier">Baskı daha erken başladı</option></select></label>` : `<input type="hidden" name="mode" value="minutes">`}<div id="delayValueField"><label>Gecikme (dakika)<input name="value" type="number" min="1" max="10080" value="30" required></label></div>${current ? `<div class="delay-current-note">Sistemde görünen ilerleme: <b>%${currentProgress}</b> · Tahmini bitiş: <b>${dateTime(printer.endsAt)}</b></div>` : `<div class="delay-current-note">Mevcut plan: <b>${dateTime(reservation.startAt)} → ${timeValue(reservation.endAt)}</b></div>`}<button class="submit">SÜRELERİ GÜNCELLE</button></form>`, async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const mode = String(form.get("mode"));
    const value = Number(form.get("value"));
    if (!Number.isFinite(value) || value <= 0) return toast("Geçerli bir değer girin");
    closeModal();
    try {
      await mutate("adjustPrintTiming", { printerId, reservationId, mode, value }, makeEntry("Baskı süresi güncellendi", `${title} · ${printer.name} · ${mode === "percent" ? `%${value} gerçek ilerleme` : mode === "startedEarlier" ? `${value} dk erken başladı` : `${value} dk geciktirildi`}`, currentUser?.name || ""), "Baskı ve takip eden planlar güncellendi");
    } catch (_) {}
  });
  const mode = $("#delayMode");
  if (mode) mode.onchange = () => {
    const field = $("#delayValueField");
    if (mode.value === "percent") field.innerHTML = `<label>Şu anki gerçek ilerleme (%)<input name="value" type="number" min="1" max="99" value="${Math.max(1, Math.min(99, currentProgress || 1))}" required></label><small class="field-help">Uygulama geçen süreye göre yeni tahmini bitişi hesaplar.</small>`;
    else if (mode.value === "startedEarlier") field.innerHTML = `<label>Kaç dakika daha erken başladı?<input name="value" type="number" min="1" max="1440" value="15" required></label><small class="field-help">Başlangıç ve tahmini bitiş aynı miktarda geriye alınır.</small>`;
    else field.innerHTML = `<label>Gecikme (dakika)<input name="value" type="number" min="1" max="10080" value="30" required></label>`;
  };
}

function savedJobPlanningLabel(job) {
  const active = printers.some(printer => printer.status === "printing" && printer.savedJobId === job.id);
  if (active) return " · Şu anda basılıyor";
  const planned = printers.some(printer => printer.reservations.some(item => item.kind === "scheduled" && item.savedJobId === job.id && item.endAt > Date.now()));
  return planned ? " · Takvimde planlandı" : "";
}

function autoScheduleForm() {
  if (!printers.some(printer => !["maintenance", "broken"].includes(printer.status))) return toast("Otomatik planlama için uygun yazıcı yok");
  const workDate = new Date(Math.max(startOfDay(calendarDate).getTime(), startOfDay(new Date()).getTime()));
  while ([0, 6].includes(workDate.getDay())) workDate.setDate(workDate.getDate() + 1);
  const availablePrinters = printers.filter(printer => !["maintenance", "broken"].includes(printer.status));
  let selectedJobs = [];
  showModal(`<form class="form auto-schedule-form"><div class="magic-heading"><span>✦</span><div><small>AKILLI PLANLAMA</small><h2>İşleri otomatik ekle</h2></div></div><p class="form-intro">İşler 08:00–17:00 arasında başlatılır. Saat 17:00'den sonraki başlangıçlar ve hafta sonları otomatik olarak sonraki iş gününe aktarılır.</p><div class="form-grid"><label>Yazıcı<select name="printerId" required>${availablePrinters.map(printer => `<option value="${printer.id}">${esc(printer.name)}</option>`).join("")}</select></label><label>İlk iş günü<input name="date" type="date" required value="${dateValue(workDate)}"></label></div><label>İşler arasındaki minimum süre (dakika)<input name="minGap" type="number" min="0" max="1440" value="30" required></label><fieldset class="auto-add-box"><legend>Kayıtlı iş ekle</legend><div class="auto-add-row"><select id="autoSavedSelect"><option value="">Bir kayıtlı iş seçin</option>${savedJobs.map(job => `<option value="${job.id}">${esc(job.name)} · ${durationText(job.duration)}${esc(savedJobPlanningLabel(job))}</option>`).join("")}</select><button type="button" id="autoAddSaved">Ekle</button></div></fieldset><fieldset class="auto-add-box"><legend>Manuel iş ekle</legend><div class="auto-manual-row"><input id="autoManualName" placeholder="İş adı" aria-label="İş adı"><label>Saat<input id="autoManualHours" type="number" min="0" max="720" value="0"></label><label>Dakika<input id="autoManualMinutes" type="number" min="0" max="59" value="30"></label><button type="button" id="autoAddManual">Ekle</button></div></fieldset><div class="auto-job-list" id="autoJobList"></div><button class="submit" id="autoScheduleSubmit" disabled>TAKVİME OTOMATİK YERLEŞTİR</button></form>`, async event => {
    event.preventDefault();
    if (!selectedJobs.length) return toast("En az bir iş ekleyin");
    const form = new FormData(event.currentTarget);
    const startAt = parseDateTime24(form.get("date"), "08:00");
    const printerId = String(form.get("printerId"));
    const printer = printers.find(item => item.id === printerId);
    closeModal();
    try {
      const result = await mutate("autoSchedulePrints", { printerId, jobs: selectedJobs, minGap: Number(form.get("minGap")), startAt }, makeEntry("İşler otomatik planlandı", `${selectedJobs.length} iş · ${printer?.name || "Yazıcı"}`, currentUser?.name || ""), `${selectedJobs.length} iş çalışma saatlerine göre takvime eklendi`);
      const firstStart = result?.createdReservations?.[0]?.startAt;
      if (firstStart) calendarDate = startOfDay(firstStart);
      setTab("calendar");
    } catch (_) {}
  });

  const renderSelectedJobs = () => {
    $("#autoJobList").innerHTML = selectedJobs.length ? selectedJobs.map((job, index) => `<div class="auto-job-row"><span>${index + 1}</span><div><b>${esc(job.name)}</b><small>${job.savedJobId ? "Kayıtlı iş" : "Manuel"} · ${durationText(job.duration)}</small></div><div><button type="button" data-auto-up="${index}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-auto-down="${index}" ${index === selectedJobs.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="danger-link" data-auto-remove="${index}">×</button></div></div>`).join("") : `<div class="auto-empty">Planlanacak işleri ekleyin. Sıra yukarıdan aşağıya uygulanır.</div>`;
    $("#autoScheduleSubmit").disabled = !selectedJobs.length;
    document.querySelectorAll("[data-auto-up]").forEach(button => button.onclick = () => {
      const index = Number(button.dataset.autoUp);
      [selectedJobs[index - 1], selectedJobs[index]] = [selectedJobs[index], selectedJobs[index - 1]];
      renderSelectedJobs();
    });
    document.querySelectorAll("[data-auto-down]").forEach(button => button.onclick = () => {
      const index = Number(button.dataset.autoDown);
      [selectedJobs[index + 1], selectedJobs[index]] = [selectedJobs[index], selectedJobs[index + 1]];
      renderSelectedJobs();
    });
    document.querySelectorAll("[data-auto-remove]").forEach(button => button.onclick = () => {
      selectedJobs.splice(Number(button.dataset.autoRemove), 1);
      renderSelectedJobs();
    });
  };
  $("#autoAddSaved").onclick = () => {
    const job = savedJobs.find(item => item.id === $("#autoSavedSelect").value);
    if (!job) return toast("Kayıtlı iş seçin");
    if (selectedJobs.some(item => item.savedJobId === job.id)) return toast("Bu kayıtlı iş listeye zaten eklendi");
    selectedJobs.push({ name: job.name, duration: Number(job.duration), savedJobId: job.id });
    renderSelectedJobs();
  };
  $("#autoAddManual").onclick = () => {
    const name = $("#autoManualName").value.trim();
    const hours = Number($("#autoManualHours").value);
    const mins = Number($("#autoManualMinutes").value);
    const duration = Math.round(hours * 60 + mins);
    if (!name || !Number.isFinite(hours) || !Number.isFinite(mins) || hours < 0 || mins < 0 || mins > 59 || duration < 1 || duration > 43200) return toast("Manuel iş adı, saat ve dakika süresini doğru girin");
    selectedJobs.push({ name, duration, savedJobId: null });
    $("#autoManualName").value = "";
    $("#autoManualHours").value = "0";
    $("#autoManualMinutes").value = "30";
    renderSelectedJobs();
  };
  renderSelectedJobs();
}

function bindInlinePrintName(input, originalName, save) {
  if (!input) return;
  input.onkeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      input.value = originalName;
      input.blur();
    }
  };
  input.onchange = async () => {
    const name = input.value.trim();
    if (!name) {
      input.value = originalName;
      return toast("Baskı adı boş bırakılamaz");
    }
    if (name === originalName) return;
    input.disabled = true;
    try {
      await save(name);
      input.value = name;
    } catch (_) {
      input.value = originalName;
    } finally {
      input.disabled = false;
    }
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
  ["fleet", "calendar", "jobs"].forEach(name => $("#" + name + "View").classList.toggle("hidden", name !== next));
  if (next === "calendar") {
    if (changed) calendarShouldFocusNow = true;
    renderCalendar();
  }
}

function setJobsTab(next) {
  jobsTab = next;
  document.querySelectorAll("[data-jobs-tab]").forEach(button => button.classList.toggle("active", button.dataset.jobsTab === next));
  ["queue", "saved", "printed", "history"].forEach(name => $("#" + name + "View").classList.toggle("hidden", name !== next));
}

document.querySelectorAll(".tabs button").forEach(button => button.onclick = () => setTab(button.dataset.tab));
document.querySelectorAll("[data-jobs-tab]").forEach(button => button.onclick = () => setJobsTab(button.dataset.jobsTab));
document.querySelector("[data-open-tab]").onclick = () => { setTab("jobs"); setJobsTab("history"); };
$("#addSavedJob").onclick = guarded(() => savedJobForm());
$("#reorderButton").onclick = guardedAccount(beginOrSaveReorder);
$("#cancelReorder").onclick = cancelReorder;
$("#calendarZoomOut").onclick = () => { calendarZoomIndex = Math.max(0, calendarZoomIndex - 1); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarZoomIn").onclick = () => { calendarZoomIndex = Math.min(calendarZoomLevels.length - 1, calendarZoomIndex + 1); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarPrev").onclick = () => { calendarDate = addDays(calendarDate, -1); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarNext").onclick = () => { calendarDate = addDays(calendarDate, 1); calendarShouldFocusNow = true; renderCalendar(); };
$("#calendarToday").onclick = () => { calendarDate = startOfDay(new Date()); calendarShouldFocusNow = true; renderCalendar(); };
$("#autoSchedule").onclick = guarded(autoScheduleForm);
$("#calendarShowAll").onclick = event => {
  event.preventDefault();
  calendarSelectedPrinters = new Set(printers.map(printer => printer.id));
  saveCalendarFilter();
  renderCalendar();
};
$("#closeModal").onclick = closeModal;
$("#modal").onclick = event => { if (event.target === $("#modal")) closeModal(); };
updateHeaderClock();
setJobsTab(jobsTab);
setInterval(updateHeaderClock, 1000);
setInterval(() => load(true), 30000);
load();

/* OMR Aden Foo Group portal — static site (GitHub Pages) + Supabase (login, database, files). */
"use strict";

const SITE = "OMR Aden Foo Group";
// Interface language for agents (中文 / English); admin pages stay in Chinese.
let lang = "zh";
try { lang = localStorage.getItem("omr_lang") === "en" ? "en" : "zh"; } catch {}
const T = (zh, en) => (lang === "en" ? en : zh);
const PROJECT_FIELDS = ["area", "developer", "tenure", "category", "status", "location_url",
  "info_md", "package_md", "info_md_en", "package_md_en", "blast_template"];
// English copies that go stale when their Chinese original changes.
const EN_OF = { info_md: "info_md_en", package_md: "package_md_en" };

// An update is plain Chinese text, or {"zh": ..., "en": ...} when Claude wrote both.
function splitUpdate(v) {
  try { const o = JSON.parse(v); if (o && typeof o === "object" && "zh" in o) return { zh: o.zh || "", en: o.en || "" }; } catch {}
  return { zh: v || "", en: "" };
}
const STATUS_LABEL = { selling: "Selling", upcoming: "Upcoming", on_hold: "On hold", sold_out: "Sold out" };
const DOC_TYPES = ["sales_kit", "price_list", "availability", "brochure", "floor_plan", "other"];
const ALLOWED = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".xlsx", ".xlsm", ".zip", ".txt", ".md", ".csv"];

const cfg = window.OMR_CONFIG || {};
const sb = cfg.supabaseUrl ? supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
let me = null; // { user, profile }

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const e = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = s => s ? DOMPurify.sanitize(marked.parse(String(s), { breaks: true })) : "";
const rm = v => v == null || v === "" ? "–" : (+v >= 1e6 ? `RM ${(+v / 1e6).toFixed(2)} mil` : `RM ${Math.round(+v).toLocaleString("en-MY")}`);
const num = v => v == null || v === "" ? "–" : Math.round(+v).toLocaleString("en-MY");
const psf = (price, area) => price && area ? +price / +area : null;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, "");
const ext = name => (name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
const isAdmin = () => me?.profile?.role === "admin" && me?.profile?.status === "approved";
const PHOTO = "photo";
const PLAN = "floor_plan";
// "Type B（Courtyard）" and "type b" both mean Type B; used to match layouts to price rows.
const baseType = name => String(name || "").replace(/[（(].*$/, "").trim().toLowerCase();
// Price comparison & sub-sale records are switched off for now; set true to bring them back.
const SHOW_COMPARE = false;

// Private files need signed URLs; reuse them for the session so the browser can cache the images.
async function signUrls(paths) {
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem("omr_signed") || "{}"); } catch {}
  const now = Date.now(), ttl = 6 * 3600;
  const need = [...new Set(paths)].filter(p => !(cache[p] && cache[p].exp > now + 600000));
  if (need.length) {
    const { data } = await sb.storage.from("docs").createSignedUrls(need, ttl);
    (data || []).forEach((s, i) => { if (s.signedUrl) cache[need[i]] = { url: s.signedUrl, exp: now + ttl * 1000 }; });
    try { sessionStorage.setItem("omr_signed", JSON.stringify(cache)); } catch {}
  }
  return Object.fromEntries(paths.map(p => [p, cache[p]?.url]));
}

// Coordinates from a Google Maps link, or typed as "3.0412, 101.4523".
function parseLatLng(s) {
  s = String(s || "");
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || s.match(/\/(?:search|place|dir\/[^/]*)\/(-?\d+\.\d+),\+?\s*(-?\d+\.\d+)/)
    || s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || s.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i)
    || s.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{2,3}\.\d+)\s*$/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

const hasGeo = p => p.lat != null && p.lng != null;

// Coordinates for a pasted Google Maps link; short links (maps.app.goo.gl) are opened by the resolve-map function.
async function locate(link) {
  const direct = parseLatLng(link);
  if (direct || !/^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)\//.test(link || "")) return direct;
  const { data } = await sb.functions.invoke("resolve-map", { body: { url: link } });
  return data?.url ? parseLatLng(data.url) : null;
}
// The admin's own Google Maps link wins; coordinates are only a fallback.
const mapsLink = p => p.location_url || (hasGeo(p) ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : "");

// Price and size ranges across a project's unit types, for cards and the spec grid.
function unitSummary(units) {
  const vals = k => units.map(u => +u[k]).filter(Boolean);
  const range = k => { const v = vals(k); if (!v.length) return ""; const lo = Math.min(...v), hi = Math.max(...v);
    return lo === hi ? num(lo) : `${num(lo)} – ${num(hi)}`; };
  const prices = units.map(u => +(u.nett_price || u.spa_price)).filter(Boolean);
  return { from_price: prices.length ? Math.min(...prices) : null, land_range: range("land_sf"), bu_range: range("bu_sf") };
}

// The one info_md line the power and floor loading filters read, e.g. "- **电 / 承重:** 电 200 – 400A；承重 3 吨/m²".
// "60 + 60A" counts as 120A; kN/m² and kPa are converted to tons so every project filters on the same scale.
function parseSpecs(info) {
  const line = String(info || "").match(/\*\*电 \/ 承重:\*\*\s*(.+)/)?.[1] || "";
  const part = word => line.match(new RegExp(`${word} ([^；]*)`))?.[1]?.trim() || "";
  const nums = t => (t.match(/\d[\d,]*(?:\.\d+)?(?:\s*\+\s*\d+)?/g) || []).map(n => n.split("+").reduce((a, b) => a + +b.replace(/,/g, ""), 0));
  const power = part("电"), load = part("承重");
  const k = /kn|kpa/i.test(load) ? 1 / 9.81 : 1;
  return { power, load, amps: nums(power), tons: nums(load).map(n => Math.round(n * k * 10) / 10) };
}
// "10 kN/m²" also shows its rough tons, because customers usually ask in tons.
function loadLabel(s) {
  if (!s.load) return "";
  const text = T(s.load, s.load.replace(/吨/g, s.tons.every(t => t === 1) ? "ton" : "tons"));
  if (!/kn|kpa/i.test(s.load)) return text;
  const lo = Math.min(...s.tons), hi = Math.max(...s.tons), t = lo === hi ? `${lo}` : `${lo} – ${hi}`;
  return `${text}${T(`（约 ${t} 吨）`, ` (approx. ${t} tons)`)}`;
}

// Projects picked for the Compare tab; kept per browser so agents can pick while browsing.
const MAX_COMPARE = 4;
function compareList() {
  try { return JSON.parse(localStorage.getItem("omr_compare") || "[]").slice(0, MAX_COMPARE); } catch { return []; }
}
function saveCompare(list) {
  try { localStorage.setItem("omr_compare", JSON.stringify(list.slice(0, MAX_COMPARE))); } catch {}
  renderNav();
}
// Adds or removes a project; false when the list is already full.
function toggleCompare(slug) {
  const list = compareList();
  if (list.includes(slug)) { saveCompare(list.filter(s => s !== slug)); return true; }
  if (list.length >= MAX_COMPARE) return false;
  saveCompare([...list, slug]);
  return true;
}
const compareLabel = on => on ? T("✓ 已加入对比", "✓ In compare") : T("+ 对比", "+ Compare");

// 011-391 93190 style, as agents write it in WhatsApp.
function fmtPhone(ph) {
  const d = String(ph || "").replace(/\D/g, "").replace(/^60/, "0");
  return d.length >= 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)} ${d.slice(6)}` : String(ph || "");
}

// The stored template ends at the ✅ lines; add the map link and the sending agent's own contact.
function composeBlast(p) {
  if (!p.blast_template) return "";
  const map = p.location_url && !parseLatLng(p.location_url) ? p.location_url
    : hasGeo(p) && !p.geo_approx ? mapsLink(p) : "";
  const sign = [me?.profile?.name, fmtPhone(me?.profile?.phone)].filter(Boolean).join("\n");
  return [p.blast_template.trim(), map && `Location Map :\n${map}`, sign].filter(Boolean).join("\n\n");
}

function tenureChip(tenure) {
  if (!tenure) return "";
  return `<span class="chip ${/free/i.test(tenure) ? "" : "lease"}">${e(tenure.length > 18 ? tenure.slice(0, 18) + "…" : tenure)}</span>`;
}

function lightbox(urls, i) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const show = () => { box.innerHTML = `<img src="${e(urls[i])}" alt=""><button class="x" aria-label="${T("关闭", "Close")}">×</button>
    ${urls.length > 1 ? `<button class="prev" aria-label="${T("上一张", "Previous")}">‹</button><button class="next" aria-label="${T("下一张", "Next")}">›</button>` : ""}
    <div class="n">${i + 1} / ${urls.length}</div>`; };
  const go = d => { i = (i + d + urls.length) % urls.length; show(); };
  const close = () => { box.remove(); document.removeEventListener("keydown", key); };
  const key = ev => { if (ev.key === "Escape") close(); else if (ev.key === "ArrowLeft") go(-1); else if (ev.key === "ArrowRight") go(1); };
  box.onclick = ev => { const c = ev.target.className; if (c === "prev") go(-1); else if (c === "next") go(1); else if (c === "x" || ev.target === box) close(); };
  document.addEventListener("keydown", key);
  show();
  document.body.appendChild(box);
}

// Shrink photos before upload (max 1600 px JPEG) so pages load fast and storage lasts.
async function shrinkImage(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
    return blob ? { blob, ext: ".jpg" } : { blob: file, ext: ext(file.name) };
  } catch { return { blob: file, ext: ext(file.name) }; }
}

function toFloat(v) {
  v = String(v ?? "").replace(/,/g, "").replace(/rm/i, "").trim().toLowerCase();
  if (!v) return null;
  let mult = 1;
  if (v.endsWith("mil")) { v = v.slice(0, -3); mult = 1e6; } else if (v.endsWith("k")) { v = v.slice(0, -1); mult = 1e3; }
  const n = parseFloat(v);
  return isNaN(n) ? null : n * mult;
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || uuid().slice(0, 8);
}

async function uniqueSlug(name) {
  const base = slugify(name);
  const { data } = await sb.from("projects").select("slug").like("slug", base + "%");
  const taken = new Set((data || []).map(r => r.slug));
  let slug = base, n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

function flash(msg, keep) {
  $("#flash").innerHTML = msg ? `<div class="flash">${e(msg)}</div>` : "";
  if (msg && !keep) window.scrollTo(0, 0);
}

function check({ error }, what) {
  if (error) throw new Error(`${what || "操作"}失败：${error.message}`);
}

function badge(status) {
  return `<span class="badge ${e(status)}">${e(STATUS_LABEL[status] || status)}</span>`;
}

function setHero(html) { $("#hero").innerHTML = html || ""; }

function render(html) { $("#view").innerHTML = html; }

// ---------- auth state ----------
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { me = null; return; }
  const { data: profile } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
  me = { user: session.user, profile: profile || { status: "pending", role: "agent", name: "" } };
}

function renderNav() {
  const r = location.hash;
  const link = (href, label) => `<a href="${href}" class="${r.startsWith(href) ? "active" : ""}">${label}</a>`;
  let html = "";
  if (me && me.profile.status === "approved") {
    const picked = compareList().length;
    html += link("#/projects", "Projects") + link("#/vs", `${T("项目对比", "Compare")}${picked ? ` (${picked})` : ""}`) + (SHOW_COMPARE ? link("#/compare", "价格对比") : "");
    if (isAdmin()) html += link("#/admin/upload", "上传资料") + link("#/admin/users", "Agents") + (SHOW_COMPARE ? link("#/admin/comparables", "成交记录") : "");
    html += `<a href="#/logout">${T("登出", "Log out")}</a>`;
  } else if (me) {
    html += `<a href="#/logout">${T("登出", "Log out")}</a>`;
  } else {
    html += `<a href="#/login">${T("登录", "Log in")}</a>`;
  }
  html += `<a href="#" id="lang" class="lang">${lang === "en" ? "中文" : "EN"}</a>`;
  $("#nav").innerHTML = html;
}

// ---------- router ----------
const routes = [
  [/^#?\/?$/, viewHome, "public"],
  [/^#\/login$/, viewLogin, "public"],
  [/^#\/register$/, viewRegister, "public"],
  [/^#\/logout$/, viewLogout, "public"],
  [/^#\/pending$/, viewPending, "user"],
  [/^#\/projects$/, viewProjects, "approved"],
  [/^#\/p\/([^/?]+)$/, viewProject, "approved"],
  [/^#\/vs$/, viewVersus, "approved"],
  ...(SHOW_COMPARE ? [[/^#\/compare(?:\/([^/?]+))?$/, viewCompare, "approved"]] : []),
  [/^#\/admin\/upload$/, viewUpload, "admin"],
  [/^#\/admin\/review\/(\d+)$/, viewReview, "admin"],
  [/^#\/admin\/users$/, viewUsers, "admin"],
  ...(SHOW_COMPARE ? [[/^#\/admin\/comparables$/, viewComparables, "admin"]] : []),
  [/^#\/admin\/edit\/([^/?]+)$/, viewEdit, "admin"],
  [/^#\/admin\/new$/, () => viewEdit(null), "admin"],
];

async function route() {
  if (!sb) {
    setHero("");
    render(`<div class="card"><h1>还没连接数据库</h1><p>请在 <code>config.js</code> 填入 Supabase 的 URL 和 anon key。</p></div>`);
    return;
  }
  const hash = location.hash || "#/";
  flash("");
  setHero("");
  document.body.classList.remove("wide", "proj");
  if (listMap) { listMap.remove(); listMap = null; }
  if (!me) await loadMe();
  if (me && /^#\/(login|register)$/.test(hash)) {
    location.hash = me.profile.status === "approved" ? "#/projects" : "#/pending";
    return;
  }
  for (const [re, view, access] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    if (access !== "public" && !me) { location.hash = "#/login"; return; }
    if ((access === "approved" || access === "admin") && me.profile.status !== "approved") { location.hash = "#/pending"; return; }
    if (access === "admin" && !isAdmin()) { render(`<div class="card"><h1>${T("没有权限", "No access")}</h1></div>`); return; }
    renderNav();
    render(`<div class="loading">${T("载入中…", "Loading…")}</div>`);
    try {
      await view(...m.slice(1).map(x => x && decodeURIComponent(x)));
    } catch (err) {
      console.error(err);
      render(`<div class="card"><h1>${T("出错了", "Something went wrong")}</h1><p>${e(err.message)}</p></div>`);
    }
    return;
  }
  render(`<div class="card"><h1>${T("找不到这个页面", "Page not found")}</h1><p><a href="#/">${T("回首页", "Back to home")}</a></p></div>`);
}

// ---------- public views ----------
function viewHome() {
  if (me && me.profile.status === "approved") { location.hash = "#/projects"; return; }
  setHero(`<section class="hero"><div class="wrap">
    <h1>${SITE}</h1>
    <p>${T("工厂、工业地与店铺 project 资料中心：项目资料、最新价格与 package、available unit、地图位置和 sales kit 下载，都在这里。", "Your hub for factory, industrial land and shoplot projects: project details, latest prices and packages, available units, locations and sales kit downloads, all in one place.")}</p>
    <p style="margin-top:24px">
      <a class="btn" style="background:var(--accent);border-color:var(--accent);color:#18202b" href="#/login">${T("Agent 登录", "Agent login")}</a>
      <a class="btn ghost" style="color:#fff;border-color:#fff;margin-left:8px" href="#/register">${T("申请账号", "Request access")}</a>
    </p></div></section>`);
  render(`<div class="grid">
    <div class="card"><h2>📍 ${T("项目资料", "Project details")}</h2><p class="muted">${T("地点、规格、地契、完工日期等完整资料。", "Location, specs, tenure, completion date and more.")}</p></div>
    <div class="card"><h2>💰 ${T("价格与 Package", "Prices & packages")}</h2><p class="muted">${T("最新 SPA / nett 价格、rebate，还有一键复制的 blasting template。", "Latest SPA / nett prices, rebates and a one-tap blasting template.")}</p></div>
    <div class="card"><h2>📄 ${T("Sales Kit 下载", "Sales kit downloads")}</h2><p class="muted">${T("Brochure、price list、availability chart。", "Brochures, price lists and availability charts.")}</p></div>
    <div class="card"><h2>🗺 ${T("地图找 Project", "Projects on the map")}</h2><p class="muted">${T("在地图上看所有 project 的位置，一键 Google Maps / Waze 导航。", "See every project on the map and navigate with Google Maps or Waze in one tap.")}</p></div>
  </div><p class="muted small">${T("账号需要经过管理员批准才能查看资料。", "Accounts need admin approval before project details can be viewed.")}</p>`);
}

function viewLogin() {
  render(`<div class="card auth"><h1>${T("Agent 登录", "Agent login")}</h1>
    <form id="f"><label>Email</label><input name="email" type="email" required autofocus>
    <label>${T("密码", "Password")}</label><input name="password" type="password" required>
    <p><button class="btn" type="submit">${T("登录", "Log in")}</button></p></form>
    <p class="small muted">${T("还没有账号？", "No account yet? ")}<a href="#/register">${T("申请账号", "Request access")}</a></p></div>`);
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) { flash(T("Email 或密码不正确。", "Wrong email or password.")); return; }
    await loadMe();
    location.hash = me.profile.status === "approved" ? "#/projects" : "#/pending";
  };
}

function viewRegister() {
  render(`<div class="card auth"><h1>${T("申请账号", "Request access")}</h1>
    <p class="muted small">${T("提交后需要等管理员批准，才能查看 project 资料。", "After you submit, an admin needs to approve your account before you can see project details.")}</p>
    <form id="f"><label>${T("名字", "Name")}</label><input name="name" required>
    <label>Email</label><input name="email" type="email" required>
    <label>${T("电话（WhatsApp）", "Phone (WhatsApp)")}</label><input name="phone">
    <label>${T("密码（最少 8 个字符）", "Password (at least 8 characters)")}</label><input name="password" type="password" minlength="8" required>
    <p><button class="btn" type="submit">${T("提交申请", "Submit")}</button></p></form>
    <p class="small muted">${T("已经有账号？", "Already have an account? ")}<a href="#/login">${T("登录", "Log in")}</a></p></div>`);
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const { data, error } = await sb.auth.signUp({
      email: f.get("email").trim(), password: f.get("password"),
      options: { data: { name: f.get("name").trim(), phone: f.get("phone").trim() } },
    });
    if (error) { flash(T("申请失败：", "Could not submit: ") + error.message); return; }
    if (!data.session) {
      render(`<div class="card auth"><h1>${T("请查看 email", "Check your email")}</h1><p>${T(`我们发了一封确认信到 ${e(f.get("email"))}，按里面的链接确认后再登录。`, `We sent a confirmation link to ${e(f.get("email"))}. Click it, then log in.`)}</p></div>`);
      return;
    }
    await loadMe();
    location.hash = "#/pending";
  };
}

async function viewLogout() {
  await sb.auth.signOut();
  me = null;
  location.hash = "#/";
}

function viewPending() {
  if (me.profile.status === "approved") { location.hash = "#/projects"; return; }
  render(me.profile.status === "rejected"
    ? `<div class="card auth"><h1>${T("申请未通过", "Request not approved")}</h1><p class="muted">${T("如有疑问，请联系 Aden Foo。", "Please contact Aden Foo if you have questions.")}</p></div>`
    : `<div class="card auth"><h1>${T("等待批准", "Waiting for approval")}</h1><p>${T(`你好 ${e(me.profile.name)}，你的账号已经提交，等管理员批准后就可以查看资料。`, `Hi ${e(me.profile.name)}, your request has been sent. You can see project details once an admin approves it.`)}</p>
       <p><button class="btn ghost sm" onclick="location.reload()">${T("重新检查", "Check again")}</button></p></div>`);
}

// ---------- agent views ----------
let listMap = null;

function fitListing() {
  const l = $(".listing");
  if (!l) return;
  l.style.height = innerWidth > 900 ? `${innerHeight - l.getBoundingClientRect().top - scrollY}px` : "";
  if (listMap) listMap.invalidateSize();
}
window.addEventListener("resize", fitListing);

const LOAD_STEPS = [1, 1.5, 2, 3, 5];

const pinIcon = (hl, approx) => L.divIcon({ className: "", html: `<div class="pin${hl ? " hl" : ""}${approx ? " approx" : ""}"></div>`,
  iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

async function viewProjects() {
  const [res, ph] = await Promise.all([
    sb.from("projects").select("id, slug, name, area, category, tenure, developer, status, lat, lng, geo_approx, info_md, unit_types(spa_price, nett_price, land_sf, bu_sf)").order("area").order("name"),
    sb.from("files").select("project_id, storage_path").eq("doc_type", PHOTO).not("storage_path", "is", null).order("sort_order").order("id"),
  ]);
  check(res, "读取 projects ");
  const photos = {};
  (ph.data || []).forEach(f => (photos[f.project_id] ||= []).push(f.storage_path));
  const urls = await signUrls(Object.values(photos).map(a => a[0]));
  const projects = res.data.map(p => ({ ...p, ...unitSummary(p.unit_types), specs: parseSpecs(p.info_md),
    cover: photos[p.id] ? urls[photos[p.id][0]] : null, nphotos: (photos[p.id] || []).length }));
  // Projects agents can still sell come first; on hold, then sold out, go to the bottom.
  const LAST = { on_hold: 1, sold_out: 2 };
  projects.sort((a, b) => (LAST[a.status] || 0) - (LAST[b.status] || 0));
  const areas = [...new Set(projects.map(p => p.area).filter(Boolean))].sort();
  const cats = [...new Set(projects.map(p => p.category).filter(Boolean))].sort();
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("omr_filters") || "{}"); } catch {}
  const opts = (list, cur) => list.map(a => `<option ${a === cur ? "selected" : ""}>${e(a)}</option>`).join("");
  document.body.classList.add("wide");
  render(`<div class="list-bar">
      <input id="q" placeholder="${T("搜索名字、地区、发展商、类型…", "Search name, area, developer, type…")}" value="${e(saved.q || "")}">
      <select id="area"><option value="">${T("全部地区", "All areas")}</option>${opts(areas, saved.area)}</select>
      ${cats.length ? `<select id="cat"><option value="">${T("全部类型", "All types")}</option>${opts(cats, saved.cat)}</select>` : ""}
      <select id="status"><option value="">${T("全部状态", "All statuses")}</option>${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === saved.status ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select id="amp" aria-label="${T("电力", "Power supply")}"><option value="">${T("电力不限", "Any power")}</option>${[100, 150, 200, 300, 400, 600, 800, 1000].map(a => `<option value="${a}" ${String(a) === saved.amp ? "selected" : ""}>≥ ${num(a)}A</option>`).join("")}</select>
      <select id="tmin" aria-label="${T("承重从", "Floor loading from")}"><option value="">${T("承重不限", "Any loading")}</option>${LOAD_STEPS.map(t => `<option value="${t}" ${String(t) === saved.tmin ? "selected" : ""}>${T(`≥ ${t} 吨/m²`, `≥ ${t} ton/m²`)}</option>`).join("")}</select>
      <select id="tmax" aria-label="${T("承重到", "Floor loading to")}"><option value="">${T("承重上限不限", "No upper limit")}</option>${LOAD_STEPS.map(t => `<option value="${t}" ${String(t) === saved.tmax ? "selected" : ""}>${T(`≤ ${t} 吨/m²`, `≤ ${t} ton/m²`)}</option>`).join("")}</select>
      ${isAdmin() ? `<a class="btn ghost" href="#/admin/new">+ 新增 project</a>` : ""}
    </div>
    <div class="listing">
      <div class="results"><h1>${T("工厂、工业地与店铺 Projects", "Factories, Industrial Land & Shoplots")}</h1><div class="muted small" id="count"></div><div class="cards" id="list"></div></div>
      <div class="mapbox"><div id="map"></div>
        <label class="map-opt"><input type="checkbox" id="inview" ${saved.inview ? "checked" : ""}> ${T("只显示地图范围内的 project", "Only show projects in map area")}</label></div>
    </div>
    <button class="btn view-toggle" id="toggle">🗺 ${T("地图", "Map")}</button>`);
  fitListing();

  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const markers = {};
  let cluster = null;
  if (window.L) {
    listMap = L.map("map", { scrollWheelZoom: true }).setView([3.05, 101.55], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(listMap);
    cluster = L.markerClusterGroup ? L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false }) : L.layerGroup();
    listMap.addLayer(cluster);
    projects.filter(hasGeo).forEach(p => {
      const m = L.marker([p.lat, p.lng], { icon: pinIcon(false, p.geo_approx), title: p.name });
      m.bindPopup(`<a class="mpop" href="#/p/${encodeURIComponent(p.slug)}" style="display:block;color:inherit;text-decoration:none">
        ${p.cover ? `<img src="${e(p.cover)}" alt="">` : ""}<b>${e(p.name)}</b>
        <span class="small muted">${e([p.category, p.area].filter(Boolean).join(" · "))}</span>
        ${p.from_price ? `<div style="font-weight:700;margin-top:2px">${T(`由 ${rm(p.from_price)} 起`, `From ${rm(p.from_price)}`)}</div>` : ""}</a>`);
      markers[p.id] = m;
    });
  }
  const pts = projects.filter(hasGeo).map(p => [p.lat, p.lng]);
  const fitAll = () => { if (listMap && pts.length) listMap.fitBounds(pts, { padding: [30, 30], maxZoom: 13 }); };
  fitAll();

  const draw = () => {
    const q = $("#q").value.trim().toLowerCase(), area = $("#area").value, cat = $("#cat")?.value || "", status = $("#status").value;
    const inview = $("#inview").checked;
    const amp = $("#amp").value, tmin = $("#tmin").value, tmax = $("#tmax").value;
    try { sessionStorage.setItem("omr_filters", JSON.stringify({ q, area, cat, status, inview, amp, tmin, tmax })); } catch {}
    // A project passes when any of its types reaches the power, or its loading range touches the range asked for.
    const specOk = p => (!amp || Math.max(0, ...p.specs.amps) >= +amp)
      && (!(tmin || tmax) || (p.specs.tons.length > 0 && Math.max(...p.specs.tons) >= +(tmin || 0) && Math.min(...p.specs.tons) <= +(tmax || Infinity)));
    const basic = projects.filter(p => (!q || [p.name, p.area, p.category, p.developer].join(" ").toLowerCase().includes(q))
      && (!area || p.area === area) && (!cat || p.category === cat) && (!status || p.status === status));
    const matches = basic.filter(specOk);
    const noData = basic.filter(p => (amp && !p.specs.amps.length) || ((tmin || tmax) && !p.specs.tons.length)).length;
    if (cluster) {
      cluster.clearLayers();
      matches.forEach(p => markers[p.id] && cluster.addLayer(markers[p.id]));
    }
    // On phones the map is hidden behind a toggle; only filter by it while it is on screen.
    const bounds = listMap && inview && $("#map").offsetWidth ? listMap.getBounds() : null;
    const rows = bounds ? matches.filter(p => hasGeo(p) && bounds.contains([p.lat, p.lng])) : matches;
    $("#count").textContent = T(`找到 ${rows.length} 个 project${bounds ? "（地图范围内）" : ""}`, `${rows.length} projects found${bounds ? " (in map area)" : ""}`) + (noData ? T(`；另有 ${noData} 个没有这项资料，没有列出`, `; ${noData} more have no data for this and are not listed`) : "");
    $("#list").innerHTML = rows.map(p => `<a class="lcard" data-id="${p.id}" href="#/p/${encodeURIComponent(p.slug)}">
        <div class="ph">${p.cover ? `<img src="${e(p.cover)}" alt="" loading="lazy">` : `<div class="noimg">${e(p.name)}</div>`}
          <span class="tag ${e(p.status)}">${e(STATUS_LABEL[p.status] || p.status)}</span>
          ${p.nphotos > 1 ? `<span class="cnt">📷 ${p.nphotos}</span>` : ""}</div>
        <div class="bd"><div class="kicker">${e(p.category || "Project")}</div>
          <h3>${e(p.name)}</h3>
          <div class="loc">📍 ${e(p.area || "—")}</div>
          <div class="price-row"><div class="price">${p.from_price ? T(`<small>由</small> ${rm(p.from_price)} <small>起</small>`, `<small>From</small> ${rm(p.from_price)}`) : `<small>${T("价格待更新", "Price to be updated")}</small>`}</div>${tenureChip(p.tenure)}</div>
          ${p.land_range || p.bu_range ? `<div class="sizes">${p.bu_range ? `<span>${T("建筑", "Built-up")} <b>${p.bu_range}</b> sf</span>` : ""}${p.land_range ? `<span>${T("土地", "Land")} <b>${p.land_range}</b> sf</span>` : ""}</div>` : ""}
          ${p.specs.power || p.specs.load ? `<div class="specline">${p.specs.power ? `<span>⚡ <b>${e(p.specs.power)}</b></span>` : ""}${p.specs.load ? `<span>🏋 <b>${e(loadLabel(p.specs))}</b></span>` : ""}</div>` : ""}
          <button type="button" class="cmp-btn ${compareList().includes(p.slug) ? "on" : ""}" data-cmp="${e(p.slug)}">${compareLabel(compareList().includes(p.slug))}</button>
        </div></a>`).join("") || `<p class="muted">${T("找不到符合的 project。", "No matching projects. ")}${bounds ? T("试试把地图拉远，或取消「只显示地图范围内」。", "Try zooming the map out, or untick “Only show projects in map area”.") : ""}</p>`;
    document.querySelectorAll("[data-cmp]").forEach(b => b.onclick = ev => {
      ev.preventDefault();
      if (!toggleCompare(b.dataset.cmp)) { alertFull(); return; }
      const on = compareList().includes(b.dataset.cmp);
      b.classList.toggle("on", on);
      b.textContent = compareLabel(on);
    });
    document.querySelectorAll(".lcard").forEach(c => {
      const p = byId[c.dataset.id], m = markers[p.id];
      if (!m) return;
      c.onmouseenter = () => { m.setIcon(pinIcon(true, p.geo_approx)); m.setZIndexOffset(1000); };
      c.onmouseleave = () => { m.setIcon(pinIcon(false, p.geo_approx)); m.setZIndexOffset(0); };
    });
  };
  ["q", "area", "cat", "status", "inview", "amp", "tmin", "tmax"].forEach(id => $("#" + id)?.addEventListener("input", draw));
  if (listMap) listMap.on("moveend", () => { if ($("#inview")?.checked) draw(); });
  let mapShown = innerWidth > 900;
  $("#toggle").onclick = () => {
    const on = $(".listing").classList.toggle("show-map");
    $("#toggle").textContent = on ? `☰ ${T("列表", "List")}` : `🗺 ${T("地图", "Map")}`;
    if (listMap) { listMap.invalidateSize(); if (on && !mapShown) { mapShown = true; fitAll(); } }
    draw();
  };
  draw();
}

const alertFull = () => flash(T(`最多对比 ${MAX_COMPARE} 个 project，请先到「项目对比」移除一个。`, `You can compare up to ${MAX_COMPARE} projects. Remove one under Compare first.`));

// Side-by-side sheet for sales meetings: pick project A, B, C… and read every key fact on one row.
async function viewVersus() {
  document.body.classList.add("wide");
  const allRes = await sb.from("projects").select("slug, name").order("name");
  check(allRes, "读取 projects ");
  const all = allRes.data;
  const known = new Set(all.map(p => p.slug));
  const picked = compareList().filter(s => known.has(s));
  const rowsRes = picked.length ? await sb.from("projects").select("*, unit_types(*)").in("slug", picked) : { data: [] };
  check(rowsRes, "读取 project ");
  const list = picked.map(s => rowsRes.data.find(p => p.slug === s)).filter(Boolean);
  const ph = list.length ? (await sb.from("files").select("project_id, storage_path").eq("doc_type", PHOTO).not("storage_path", "is", null)
    .in("project_id", list.map(p => p.id)).order("sort_order").order("id")).data || [] : [];
  const cover = {};
  ph.forEach(f => cover[f.project_id] ||= f.storage_path);
  const urls = await signUrls(Object.values(cover));
  const facts = list.map(p => {
    const units = p.unit_types.sort((a, b) => a.id - b.id);
    const psfs = units.map(u => psf(u.nett_price || u.spa_price, u.bu_sf)).filter(Boolean);
    return { ...unitSummary(units), units, specs: parseSpecs(p.info_md), psf: psfs.length ? Math.min(...psfs) : null };
  });
  const lowest = key => { const v = facts.map(f => f[key]).filter(Boolean); return v.length > 1 ? Math.min(...v) : null; };
  const lowPrice = lowest("from_price"), lowPsf = lowest("psf");
  const slots = Array.from({ length: Math.min(MAX_COMPARE, picked.length + 1) }, (_, i) => picked[i] || "");
  const letter = i => "ABCD"[i];
  const row = (label, cell) => `<tr><th scope="row">${label}</th>${list.map((p, i) => `<td>${cell(p, facts[i]) || "–"}</td>`).join("")}</tr>`;
  render(`<div class="vs">
    <h1>${T("项目对比", "Compare projects")}</h1>
    <p class="muted small">${T(`选 2 – ${MAX_COMPARE} 个 project，也可以在 Projects 页按「+ 对比」。价钱是每个户型最便宜的可售单位，优先用净价。`, `Pick 2 – ${MAX_COMPARE} projects, or tap “+ Compare” on the Projects page. Prices are the cheapest available unit per type, nett where known.`)}</p>
    <div class="vs-pick">
      ${slots.map((s, i) => `<label>${T("Project", "Project")} ${letter(i)}<select data-slot="${i}"><option value="">${T("选择 project…", "Choose a project…")}</option>
        ${all.map(p => `<option value="${e(p.slug)}" ${p.slug === s ? "selected" : ""} ${p.slug !== s && picked.includes(p.slug) ? "disabled" : ""}>${e(p.name)}</option>`).join("")}</select></label>`).join("")}
      ${picked.length ? `<button class="btn ghost" id="vs-clear">${T("全部清除", "Clear all")}</button>` : ""}
    </div>
    ${list.length ? `<div class="table-scroll"><table class="vs-table">
      <thead><tr><th></th>${list.map(p => `<th>
        ${cover[p.id] && urls[cover[p.id]] ? `<img src="${e(urls[cover[p.id]])}" alt="" loading="lazy">` : ""}
        <a href="#/p/${encodeURIComponent(p.slug)}">${e(p.name)}</a>
        <button type="button" class="link-x" data-rm="${e(p.slug)}">${T("移除", "Remove")}</button></th>`).join("")}</tr></thead>
      <tbody>
        ${row(T("地区", "Area"), p => e(p.area))}
        ${row(T("发展商", "Developer"), p => e(p.developer))}
        ${row(T("地契", "Tenure"), p => e(p.tenure))}
        ${row(T("类型", "Type"), p => e(p.category))}
        ${row(T("状态", "Status"), p => e(STATUS_LABEL[p.status] || p.status))}
        ${row(T("最低价", "Lowest price"), (p, f) => f.from_price ? `<b class="${f.from_price === lowPrice ? "vs-best" : ""}">${rm(f.from_price)}</b>` : "")}
        ${row(T("最低 RM psf（建筑）", "Lowest RM psf (built-up)"), (p, f) => f.psf ? `<b class="${f.psf === lowPsf ? "vs-best" : ""}">${num(f.psf)}</b>` : "")}
        ${row(T("建筑面积（sf）", "Built-up (sf)"), (p, f) => f.bu_range)}
        ${row(T("土地面积（sf）", "Land (sf)"), (p, f) => f.land_range)}
        ${row(T("电力", "Power supply"), (p, f) => e(f.specs.power))}
        ${row(T("楼面承重", "Floor loading"), (p, f) => e(loadLabel(f.specs)))}
        ${row(T("户型与价钱", "Types & prices"), (p, f) => f.units.map(u => `<div class="vs-unit"><b>${e(u.name)}</b>${u.bu_sf ? ` · ${num(u.bu_sf)} sf` : ""}<br>${rm(u.nett_price || u.spa_price)}${u.available ? ` · ${e(u.available)}` : ""}</div>`).join(""))}
        ${row("Package", p => `<div class="md">${md(T(p.package_md, p.package_md_en || p.package_md))}</div>`)}
        ${row(T("地图", "Map"), p => mapsLink(p) ? `<a href="${e(mapsLink(p))}" target="_blank" rel="noopener">📍 Google Maps</a>` : "")}
      </tbody></table></div>` : `<div class="card muted">${T("还没选 project。在上面选择，就会并排显示。", "No projects yet. Choose above to see them side by side.")}</div>`}
  </div>`);
  document.querySelectorAll("[data-slot]").forEach(sel => sel.onchange = () => {
    const next = [...picked];
    next[+sel.dataset.slot] = sel.value;
    saveCompare(next.filter(Boolean));
    viewVersus();
  });
  document.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { saveCompare(picked.filter(s => s !== b.dataset.rm)); viewVersus(); });
  if ($("#vs-clear")) $("#vs-clear").onclick = () => { saveCompare([]); viewVersus(); };
}

async function nearbyComparables(area) {
  const words = String(area || "").split(/[,/&]/).map(w => w.trim().toLowerCase()).filter(w => w.length > 2);
  if (!words.length) return [];
  const { data } = await sb.from("comparables").select("*").order("txn_date", { ascending: false });
  return (data || []).filter(c => words.some(w => c.area.toLowerCase().includes(w)));
}

async function viewProject(slug) {
  document.body.classList.add("proj");
  const res = await sb.from("projects").select("*, unit_types(*), files(*), updates(*)").eq("slug", slug).maybeSingle();
  check(res, "读取 project ");
  const p = res.data;
  if (!p) { render(`<div class="card"><h1>${T("找不到这个 project", "Project not found")}</h1></div>`); return; }
  const units = p.unit_types.sort((a, b) => a.id - b.id);
  const photos = p.files.filter(f => f.doc_type === PHOTO && f.storage_path).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const plans = p.files.filter(f => f.doc_type === PLAN && f.storage_path && f.unit_type).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const files = p.files.filter(f => !photos.includes(f) && !plans.includes(f))
    .sort((a, b) => (b.uploaded_at || "").localeCompare(a.uploaded_at || "") || a.filename.localeCompare(b.filename));
  const updates = p.updates.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const comps = SHOW_COMPARE ? await nearbyComparables(p.area) : [];
  const signed = await signUrls(p.files.filter(f => f.storage_path).map(f => f.storage_path));
  const photoUrls = photos.map(f => signed[f.storage_path]).filter(Boolean);
  const plansOf = name => plans.filter(f => baseType(f.unit_type) === baseType(name)).map(f => signed[f.storage_path]).filter(Boolean);
  const planGroups = [...new Set(plans.map(f => f.unit_type))].map(t => ({ type: t, urls: plansOf(t) })).filter(g => g.urls.length);
  const hasPlans = units.some(u => plansOf(u.name).length);
  const sum = unitSummary(units);
  const net = u => u.nett_price || u.spa_price;
  // Only show price-table columns that have data for this project.
  const cols = [
    ["Land sf", u => num(u.land_sf), units.some(u => u.land_sf)],
    ["BU sf", u => num(u.bu_sf), units.some(u => u.bu_sf)],
    ["SPA", u => rm(u.spa_price), units.some(u => u.spa_price)],
    ["Nett", u => rm(u.nett_price), units.some(u => u.nett_price)],
    ["RM psf (BU)", u => num(psf(net(u), u.bu_sf)), units.some(u => net(u) && u.bu_sf)],
    ["RM psf (land)", u => num(psf(net(u), u.land_sf)), units.some(u => net(u) && u.land_sf)],
  ].filter(c => c[2]);
  const hasAvail = units.some(u => u.available);
  const none = `<p class="muted">${T("暂无资料", "No details yet")}</p>`;
  const spec = (label, value) => value ? `<div><span>${label}</span><b>${e(value)}</b></div>` : "";
  const shown = photoUrls.slice(0, 5);
  const gallery = shown.length
    ? `<div class="gallery n${shown.length}">${shown.map((u, i) => `<div data-photo="${i}"><img src="${e(u)}" alt="" ${i ? `loading="lazy"` : ""}></div>`).join("")}
        <button class="btn sm all" data-photo="0">📷 ${T(`查看全部 ${photoUrls.length} 张照片`, `View all ${photoUrls.length} photos`)}</button></div>`
    : `<div class="gallery empty"><div><h2 style="margin:0 0 6px">${e(p.name)}</h2>
        <div class="small">${T("还没有照片", "No photos yet")}${isAdmin() ? `，按「编辑」上传` : ""}</div></div></div>`;
  const geo = hasGeo(p);
  const blast = composeBlast(p);

  render(`<div class="crumbs"><a href="#/projects">Projects</a>${p.area ? ` › ${e(p.area)}` : ""} › ${e(p.name)}</div>
  ${gallery}
  <div class="pgrid"><div>
    <div class="kicker">${e([p.category, p.developer].filter(Boolean).join(" · ") || "Project")}</div>
    <h1>${e(p.name)}</h1>
    <div class="loc">📍 ${e(p.area || "—")}</div>
    <div class="bigprice">${sum.from_price ? T(`<span class="small muted" style="font-weight:400">由</span> ${rm(sum.from_price)} <span class="small muted" style="font-weight:400">起</span>`, `<span class="small muted" style="font-weight:400">From</span> ${rm(sum.from_price)}`) : `<span class="muted" style="font-size:18px">${T("价格待更新", "Price to be updated")}</span>`}</div>
    <div>${badge(p.status)}</div>
    ${p.status === "on_hold" ? `<div class="flash" style="margin-top:12px">${T("发展商目前暂停推出这个 project，暂时不要向客户推。", "The developer has paused this launch. Please don’t promote it to customers for now.")}</div>` : ""}
    <div class="specs">
      ${spec(T("地契", "Tenure"), p.tenure)}${spec(T("类型", "Type"), p.category)}${spec(T("发展商", "Developer"), p.developer)}
      ${spec(T("建筑面积", "Built-up"), sum.bu_range && sum.bu_range + " sf")}${spec(T("土地面积", "Land area"), sum.land_range && sum.land_range + " sf")}
      ${spec(T("Unit 类型", "Unit types"), units.length ? units.length + T(" 种", "") : "")}${spec(T("最后更新", "Last updated"), (p.updated_at || "").slice(0, 10))}
    </div>

    <div class="section"><h2>${T("位置", "Location")}</h2>
      ${geo ? `<iframe class="gmap" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
          src="https://maps.google.com/maps?q=${p.lat},${p.lng}&z=${p.geo_approx ? 13 : 15}&output=embed"></iframe>
        <p style="margin-top:10px"><a class="btn ghost sm" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">${T("Google Maps 导航", "Google Maps directions")}</a>
          <a class="btn ghost sm" href="https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes" target="_blank" rel="noopener">Waze</a></p>
        ${p.geo_approx ? `<p class="small muted">${T("大约位置（按地区标出）。准确地址请看 sales kit", "Approximate location (by area). See the sales kit for the exact address")}${isAdmin() ? `；管理员可以在「编辑」贴上 Google Maps 链接来修正` : ""}${T("。", ".")}</p>` : ""}`
      : p.location_url ? `<p><a class="btn ghost sm" href="${e(p.location_url)}" target="_blank" rel="noopener">📍 ${T("打开 Google Maps", "Open Google Maps")}</a></p>` : `<p class="muted">${T("还没有位置资料。", "No location yet.")}</p>`}
    </div>

    <div class="section md"><h2>${T("项目资料", "Project details")}</h2>${md(T(p.info_md, p.info_md_en || p.info_md)) || none}</div>
    <div class="section md"><h2>🎁 Package</h2>${md(T(p.package_md, p.package_md_en || p.package_md)) || none}</div>

    <div class="section"><h2>${T("Unit 类型与价格", "Unit types & prices")}</h2>
    ${units.length ? `<div class="card table-scroll units"><table>
      <tr><th>Type</th>${cols.map(c => `<th class="num">${c[0]}</th>`).join("")}${hasAvail ? `<th>${T("可售", "Available")}</th>` : ""}${hasPlans ? `<th>Layout</th>` : ""}<th></th></tr>
      ${units.map(u => `<tr>
        <td class="nm"><b>${e(u.name)}</b>${u.notes ? `<div class="small muted">${e(u.notes)}</div>` : ""}</td>
        ${cols.map(c => `<td class="num">${c[1](u)}</td>`).join("")}
        ${hasAvail ? `<td class="nowrap">${e(u.available)}</td>` : ""}
        ${hasPlans ? `<td>${plansOf(u.name).length ? `<button class="btn ghost sm" data-plan="${e(u.name)}">📐 ${T("看", "View")}</button>` : ""}</td>` : ""}
        <td><button class="btn ghost sm" data-unit="${u.id}" title="${T("计算", "Calculate")}">🧮</button></td></tr>`).join("")}
    </table></div>` : `<p class="muted">${T("还没有价格资料。", "No prices yet.")}</p>`}
    </div>
    ${planGroups.length ? `<div class="section"><h2>📐 Layout</h2><div class="plans">
      ${planGroups.map(g => `<figure data-plan="${e(g.type)}"><img src="${e(g.urls[0])}" alt="" loading="lazy">
        <figcaption><b>${e(g.type)}</b>${g.urls.length > 1 ? ` <span class="small muted">（${g.urls.length} ${T("张", "pages")}）</span>` : ""}</figcaption></figure>`).join("")}
    </div></div>` : ""}

    <div class="section"><h2>🧮 ${T("计算器", "Calculator")}</h2><div class="card">
      <div class="calc">
        <div><label>${T("SPA 价格 (RM)", "SPA price (RM)")}</label><input id="c_spa" inputmode="decimal"></div>
        <div><label>Rebate %</label><input id="c_rebate" inputmode="decimal" value="0"></div>
        <div><label>Built-up sf</label><input id="c_bu" inputmode="decimal"></div>
        <div><label>Land sf</label><input id="c_land" inputmode="decimal"></div>
        <div><label>Loan margin %</label><input id="c_margin" inputmode="decimal" value="90"></div>
        <div><label>${T("利率 % p.a.", "Interest % p.a.")}</label><input id="c_rate" inputmode="decimal" value="4.5"></div>
        <div><label>${T("年限", "Years")}</label><input id="c_years" inputmode="decimal" value="25"></div>
      </div>
      <div class="calc-out" id="c_out"></div>
      <p class="small muted" style="margin-bottom:0">${T("Loan 按 SPA 价格计算；实际 margin 与利率以银行批准为准。", "Loan is based on the SPA price; actual margin and rate depend on bank approval.")}</p>
    </div></div>

    <div class="section"><h2>📢 Blasting Template</h2>
      ${blast ? `<div class="blast">${e(blast)}</div>
        <p><button class="btn ok sm" data-copy>${T("复制", "Copy")}</button>
        <a class="btn ghost sm" href="https://wa.me/?text=${encodeURIComponent(blast)}" target="_blank" rel="noopener">${T("用 WhatsApp 发送", "Send via WhatsApp")}</a></p>`
        : `<p class="muted">${T("暂无 blasting template。", "No blasting template yet.")}</p>`}
    </div>

    <div class="section"><h2>🕒 ${T("最新动态", "Latest updates")}</h2>
      ${updates.map(u => `<div class="upd"><div class="small muted">${e(u.created_at.slice(0, 10))}${u.source ? " · " + e(u.source) : ""}</div>
        <div class="md">${md(T(u.text, u.text_en || u.text))}</div></div>`).join("") || `<p class="muted">${T("暂无更新。", "No updates yet.")}</p>`}
    </div>
    ${comps.length ? `<div class="section"><h2>📊 附近成交 / Sub-sale（${comps.length}）</h2><div class="card">${compsTable(comps.slice(0, 15))}
      <p style="margin-bottom:0"><a href="#/compare/${encodeURIComponent(p.slug)}">查看完整对比 →</a></p></div></div>` : ""}
  </div>

  <aside class="side"><div class="card">
    <h2>${T("快速操作", "Quick actions")}</h2>
    ${blast ? `<button class="btn ok" data-copy>${T("复制 Blasting", "Copy blasting")}</button>
      <a class="btn ghost" href="https://wa.me/?text=${encodeURIComponent(blast)}" target="_blank" rel="noopener">${T("WhatsApp 发给客户", "WhatsApp to customer")}</a>` : ""}
    <button class="btn ghost" id="cmp-one">${compareLabel(compareList().includes(p.slug))}</button>
    ${SHOW_COMPARE ? `<a class="btn ghost" href="#/compare/${encodeURIComponent(p.slug)}">📊 周边价格对比</a>` : ""}
    ${geo || p.location_url ? `<a class="btn ghost" href="${e(mapsLink(p))}" target="_blank" rel="noopener">📍 Google Maps</a>` : ""}
    ${p.drive_url ? `<a class="btn ghost" href="${e(p.drive_url)}" target="_blank" rel="noopener">${T("Drive 文件夹", "Drive folder")}</a>` : ""}
    ${isAdmin() ? `<a class="btn" href="#/admin/edit/${encodeURIComponent(p.slug)}">编辑 / 上传照片</a>` : ""}
  </div>
  <div class="card"><h2>📄 ${T(`Sales Kit 与文件（${files.length}）`, `Sales kit & files (${files.length})`)}</h2>
    <div class="dl" style="max-height:420px;overflow-y:auto">
    ${files.map(f => { const url = f.storage_path ? signed[f.storage_path] : f.drive_url;
      return `<a ${url ? `href="${e(url)}" target="_blank" rel="noopener"` : ""}>${e(f.filename)}
        <div class="small muted">${e((f.doc_type || "").replace(/_/g, " "))}${!f.storage_path && f.drive_url ? " · Drive" : ""}</div></a>`; }).join("") || `<p class="muted">${T("暂无文件。", "No files yet.")}</p>`}
    </div></div>
  </aside></div>`);

  document.querySelectorAll("[data-photo]").forEach(el => el.onclick = () => lightbox(photoUrls, +el.dataset.photo));
  document.querySelectorAll("[data-plan]").forEach(el => el.onclick = () => lightbox(plansOf(el.dataset.plan), 0));

  const n = v => parseFloat(String(v).replace(/,/g, "")) || 0;
  const fmt = v => "RM " + Math.round(v).toLocaleString("en-MY");
  const calc = () => {
    const spa = n($("#c_spa").value), reb = n($("#c_rebate").value) / 100, bu = n($("#c_bu").value), land = n($("#c_land").value);
    const loan = spa * n($("#c_margin").value) / 100, r = n($("#c_rate").value) / 1200, months = n($("#c_years").value) * 12;
    const nett = spa * (1 - reb);
    const monthly = r && months ? loan * r / (1 - Math.pow(1 + r, -months)) : 0;
    const stats = [[T("Nett 价格", "Nett price"), fmt(nett)], ["Rebate", fmt(spa - nett)],
      ["RM psf (BU)", bu ? Math.round(nett / bu).toLocaleString() : "–"], ["RM psf (land)", land ? Math.round(nett / land).toLocaleString() : "–"],
      [T("Loan 额", "Loan amount"), fmt(loan)], ["Downpayment", fmt(Math.max(nett - loan, 0))], [T("每月供款", "Monthly instalment"), fmt(monthly)]];
    $("#c_out").innerHTML = spa ? stats.map(s => `<div class="stat"><span class="small muted">${s[0]}</span><b>${s[1]}</b></div>`).join("") : "";
  };
  document.querySelectorAll(".calc input").forEach(i => i.addEventListener("input", calc));
  document.querySelectorAll("[data-unit]").forEach(btn => btn.onclick = () => {
    const u = units.find(x => x.id === +btn.dataset.unit);
    $("#c_spa").value = u.spa_price || u.nett_price || "";
    $("#c_bu").value = u.bu_sf || ""; $("#c_land").value = u.land_sf || "";
    $("#c_rebate").value = u.spa_price && u.nett_price && +u.nett_price < +u.spa_price ? ((1 - u.nett_price / u.spa_price) * 100).toFixed(1) : 0;
    calc(); $("#c_spa").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#cmp-one").onclick = ev => {
    if (!toggleCompare(p.slug)) { alertFull(); return; }
    ev.target.textContent = compareLabel(compareList().includes(p.slug));
  };
  document.querySelectorAll("[data-copy]").forEach(btn => btn.onclick = () => navigator.clipboard.writeText(blast).then(() => {
    const was = btn.textContent;
    btn.textContent = T("已复制 ✓", "Copied ✓"); setTimeout(() => btn.textContent = was, 1500);
  }));
}

function compsTable(comps) {
  return `<div class="table-scroll"><table>
    <tr><th>名称</th><th>类型</th><th>Tenure</th><th class="num">Land sf</th><th class="num">BU sf</th><th class="num">价格</th><th class="num">psf BU</th><th class="num">psf land</th><th>日期</th><th>来源</th></tr>
    ${comps.map(c => `<tr><td>${e(c.name)}<div class="small muted">${e(c.area)}</div></td><td>${e(c.property_type)}</td><td>${e(c.tenure)}</td>
      <td class="num">${num(c.land_sf)}</td><td class="num">${num(c.bu_sf)}</td><td class="num">${rm(c.price)}</td>
      <td class="num">${num(psf(c.price, c.bu_sf))}</td><td class="num">${num(psf(c.price, c.land_sf))}</td>
      <td>${e(c.txn_date)}</td><td>${e(c.source)}</td></tr>`).join("")}
  </table></div>`;
}

async function viewCompare(slug) {
  const { data: all } = await sb.from("projects").select("slug, name, area").order("name");
  let p = null, comps = [], points = [];
  if (slug) {
    const res = await sb.from("projects").select("*, unit_types(*)").eq("slug", slug).maybeSingle();
    p = res.data;
  }
  if (p) {
    comps = await nearbyComparables(p.area);
    points = p.unit_types.map(u => { const price = u.nett_price || u.spa_price;
      return { label: `${p.name} – ${u.name}`, kind: "project", bu_psf: psf(price, u.bu_sf), land_psf: psf(price, u.land_sf) }; })
      .concat(comps.map(c => ({ label: `${c.name} (${c.source || "?"} ${c.txn_date || ""})`, kind: "comp",
        bu_psf: psf(c.price, c.bu_sf), land_psf: psf(c.price, c.land_sf) })));
  }
  render(`<h1>周边价格对比</h1>
    <p class="muted">选一个 project，系统会列出同地区的成交 / sub-sale 记录，按 RM psf 对比。</p>
    <div class="filters">
      <select id="pick" style="flex:3 1 300px"><option value="">— 选择 project —</option>
        ${(all || []).map(x => `<option value="${e(x.slug)}" ${p && x.slug === p.slug ? "selected" : ""}>${e(x.name)}${x.area ? ` (${e(x.area)})` : ""}</option>`).join("")}</select>
      <select id="basis" style="flex:1 1 160px"><option value="bu_psf">按 Built-up psf</option><option value="land_psf">按 Land psf</option></select>
    </div>
    ${p ? `<div class="card"><h2>${e(p.name)} vs 附近（${e(p.area)}）</h2>
      ${points.length ? `<div id="chart"></div><div class="stat" id="summary" style="margin-top:14px"></div>`
        : `<p class="muted">这个 project 还没有价格，附近也还没有成交记录。${isAdmin() ? `去 <a href="#/admin/comparables">成交记录</a> 导入 Brickz / LPPEH / CH 资料。` : ""}</p>`}
    </div>${comps.length ? `<div class="card"><h2>成交明细</h2>${compsTable(comps)}</div>` : ""}` : ""}`);
  $("#pick").onchange = ev => { location.hash = "#/compare/" + encodeURIComponent(ev.target.value); };
  const draw = () => {
    const el = $("#chart");
    if (!el) return;
    const key = $("#basis").value;
    const rows = points.filter(x => x[key]).sort((a, b) => b[key] - a[key]);
    const max = Math.max(...rows.map(r => r[key]), 1);
    el.innerHTML = rows.length ? rows.map(r => `<div class="bar-row"><span>${e(r.label)}</span>
      <div class="bar ${r.kind}" style="width:${(r[key] / max * 100).toFixed(1)}%"></div>
      <b style="text-align:right">${Math.round(r[key]).toLocaleString()}</b></div>`).join("") : `<p class="muted">没有足够的面积资料来计算这个 psf。</p>`;
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const proj = rows.filter(r => r.kind === "project").map(r => r[key]);
    const comp = rows.filter(r => r.kind === "comp").map(r => r[key]);
    const s = $("#summary");
    if (proj.length && comp.length) {
      const diff = (avg(proj) / avg(comp) - 1) * 100;
      s.style.display = "";
      s.innerHTML = `新 project 平均 <b style="display:inline">RM ${Math.round(avg(proj))} psf</b>，附近成交平均 <b style="display:inline">RM ${Math.round(avg(comp))} psf</b>（${comp.length} 条）：新 project ${diff >= 0 ? "贵" : "便宜"} ${Math.abs(diff).toFixed(1)}%。`;
    } else s.style.display = "none";
  };
  $("#basis").onchange = draw;
  draw();
}

// ---------- admin: upload & review ----------
const UPLOAD_STATUS = { inbox: "等 Claude 整理", review: "等你审批", done: "完成", error: "出错" };

async function viewUpload() {
  const [up, ch] = await Promise.all([
    sb.from("uploads").select("*").order("id", { ascending: false }).limit(100),
    sb.from("changes").select("upload_id").eq("status", "pending"),
  ]);
  check(up, "读取上传 ");
  const pendingCount = {};
  (ch.data || []).forEach(c => { pendingCount[c.upload_id] = (pendingCount[c.upload_id] || 0) + 1; });
  render(`<h1>上传资料，让 AI 整理</h1>
    <p class="muted">可以一次上传多个文件：PDF sales kit / price list / availability、截图、Excel，或者 WhatsApp「Export Chat」的 .zip（每个最多 50 MB）。也可以贴发展商给的 Google Drive / Google Sheet 链接。</p>
    <div class="flash">上传之后，在 Mac 的 Claude app 里说<b>「整理资料」</b>。Claude 整理好之后，文件会变成「等你审批」。</div>
    <div class="card"><form id="f">
      <label>文件（PDF、PNG/JPG、XLSX、ZIP、TXT）</label>
      <input type="file" name="files" multiple accept="${ALLOWED.join(",")}">
      <label>或者贴链接（Google Drive 文件夹 / 文件、Google Sheet、发展商网页；一行一个）</label>
      <textarea name="links" rows="3" style="min-height:0" placeholder="https://drive.google.com/drive/folders/..."></textarea>
      <label>给 AI 的备注（可选）</label>
      <input name="note" placeholder="例如：这是 Tenda Phase 2 最新 price list，8 Oct 2026">
      <p><button class="btn" type="submit">上传</button> <span id="prog" class="small muted"></span></p>
    </form></div>
    <h2>最近上传</h2>
    <div class="card table-scroll"><table>
      <tr><th>文件</th><th>上传时间</th><th>状态</th><th></th></tr>
      ${up.data.map(u => `<tr>
        <td>${u.link_url ? `🔗 <a href="${e(u.link_url)}" target="_blank" rel="noopener">${e(u.filename)}</a>` : e(u.filename)}${u.note ? `<div class="small muted">${e(u.note)}</div>` : ""}${u.error ? `<div class="small" style="color:var(--bad)">${e(u.error)}</div>` : ""}</td>
        <td class="small">${e(new Date(u.created_at).toLocaleString("en-MY"))}</td>
        <td><span class="badge ${e(u.status)}">${e(UPLOAD_STATUS[u.status] || u.status)}</span>
          ${pendingCount[u.id] ? `<span class="small muted">${pendingCount[u.id]} 项待批</span>` : ""}</td>
        <td>${["review", "done"].includes(u.status) ? `<a class="btn sm" href="#/admin/review/${u.id}">${u.status === "review" ? "审批" : "查看"}</a>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">还没有上传。</td></tr>`}
    </table></div>`);
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    const note = ev.target.note.value.trim();
    const files = [...ev.target.files.files];
    const links = ev.target.links.value.split(/\s+/).map(s => s.trim()).filter(Boolean);
    const bad = links.filter(l => !/^https?:\/\//i.test(l));
    if (bad.length) { flash(`这些不是网址：${bad.join("、")}`, true); return; }
    if (!files.length && !links.length) { flash("请选择文件或贴上链接。", true); return; }
    btn.disabled = true;
    let done = 0;
    for (const link of links) {
      const host = link.replace(/^https?:\/\//i, "").split("/")[0];
      const label = /docs\.google\.com\/spreadsheets/.test(link) ? "Google Sheet 链接"
        : /drive\.google\.com\/drive\/(u\/\d+\/)?folders/.test(link) ? "Google Drive 文件夹链接"
        : /drive\.google\.com|docs\.google\.com/.test(link) ? "Google Drive 文件链接" : `${host} 链接`;
      check(await sb.from("uploads").insert({ filename: label, link_url: link, storage_path: "", note, status: "inbox" }), "记录链接 ");
      done++;
    }
    for (const file of files) {
      if (!ALLOWED.includes(ext(file.name))) { flash(`${file.name}：不支持这个格式。`, true); continue; }
      $("#prog").textContent = `上传中 ${done + 1}/${files.length}：${file.name}`;
      const path = `uploads/${uuid()}${ext(file.name)}`;
      const s = await sb.storage.from("docs").upload(path, file);
      if (s.error) { flash(`${file.name} 上传失败：${s.error.message}`, true); continue; }
      check(await sb.from("uploads").insert({ filename: file.name, storage_path: path, note, status: "inbox" }), "记录上传 ");
      done++;
    }
    btn.disabled = false;
    if (done) { await viewUpload(); flash(`已加入 ${done} 项。在 Claude 里说「整理资料」，整理好之后会出现在下面等你审批。`); }
  };
}

const FIELD_LABEL = { new_project: "新增 project", area: "地区", developer: "发展商", tenure: "地契", category: "类型", status: "状态",
  location_url: "地图链接", info_md: "基本资料", package_md: "Package", info_md_en: "基本资料（英文）", package_md_en: "Package（英文）", blast_template: "Blasting template",
  unit_types: "Unit 类型与价格", update: "动态记录", file: "附上文件" };

function unitsTable(units) {
  if (!units || !units.length) return `<span class="muted">（没有）</span>`;
  return `<table><tr><th>Type</th><th class="num">Land</th><th class="num">BU</th><th class="num">SPA</th><th class="num">Nett</th><th>Available</th></tr>
    ${units.map(u => `<tr><td>${e(u.name)}${u.notes ? `<div class="small muted">${e(u.notes)}</div>` : ""}</td>
      <td class="num">${num(u.land_sf)}</td><td class="num">${num(u.bu_sf)}</td><td class="num">${rm(u.spa_price)}</td>
      <td class="num">${rm(u.nett_price)}</td><td>${e(u.available)}</td></tr>`).join("")}</table>`;
}

async function applyChange(ch, upload) {
  const now = new Date().toISOString();
  if (ch.field === "new_project") {
    const ins = await sb.from("projects").insert({ slug: await uniqueSlug(ch.new_value), name: ch.new_value }).select("id").single();
    check(ins, "新增 project ");
    check(await sb.from("changes").update({ project_id: ins.data.id })
      .eq("upload_id", ch.upload_id).eq("project_name", ch.project_name).is("project_id", null), "更新审批项目 ");
    return;
  }
  if (!ch.project_id) {
    // The new project may have been approved from another upload; link to it by name.
    const { data: found } = await sb.from("projects").select("id").eq("name", ch.project_name).maybeSingle();
    if (!found) throw new Error("请先批准「新增 project」。");
    ch.project_id = found.id;
    check(await sb.from("changes").update({ project_id: found.id }).eq("id", ch.id), "更新审批项目 ");
  }
  if (PROJECT_FIELDS.includes(ch.field)) {
    const geo = ch.field === "location_url" && parseLatLng(ch.new_value);
    const stale = EN_OF[ch.field] ? { [EN_OF[ch.field]]: "" } : {};
    check(await sb.from("projects").update({ ...stale, [ch.field]: ch.new_value, ...(geo ? { ...geo, geo_approx: false } : {}), updated_at: now })
      .eq("id", ch.project_id), "更新资料 ");
  } else if (ch.field === "unit_types") {
    const units = JSON.parse(ch.new_value).map(u => ({ project_id: ch.project_id, name: u.name, land_sf: u.land_sf ?? null,
      bu_sf: u.bu_sf ?? null, spa_price: u.spa_price ?? null, nett_price: u.nett_price ?? null, available: u.available || "", notes: u.notes || "" }));
    check(await sb.from("unit_types").delete().eq("project_id", ch.project_id), "删除旧价格 ");
    if (units.length) check(await sb.from("unit_types").insert(units), "写入新价格 ");
    check(await sb.from("projects").update({ updated_at: now }).eq("id", ch.project_id), "更新日期 ");
  } else if (ch.field === "update") {
    const u = splitUpdate(ch.new_value);
    check(await sb.from("updates").insert({ project_id: ch.project_id, text: u.zh, text_en: u.en, source: upload.filename }), "写入动态 ");
  } else if (ch.field === "file") {
    const meta = JSON.parse(ch.new_value);
    const dest = `files/${uuid()}${ext(upload.storage_path)}`;
    const cp = await sb.storage.from("docs").copy(upload.storage_path, dest);
    if (cp.error) throw new Error("复制文件失败：" + cp.error.message);
    check(await sb.from("files").insert({ project_id: ch.project_id, filename: meta.filename, doc_type: meta.doc_type || "other", storage_path: dest }), "附上文件 ");
  }
}

async function viewReview(id) {
  const [u, c] = await Promise.all([
    sb.from("uploads").select("*").eq("id", id).single(),
    sb.from("changes").select("*").eq("upload_id", id).order("id"),
  ]);
  check(u, "读取上传 ");
  const upload = u.data;
  const order = ch => (ch.field === "new_project" ? 0 : 1);
  const changes = (c.data || []).sort((a, b) => a.project_name.localeCompare(b.project_name) || order(a) - order(b) || a.id - b.id);
  const pending = changes.filter(x => x.status === "pending");
  const summary = upload.ai_result?.summary || "";
  render(`<p class="small"><a href="#/admin/upload">← 上传列表</a></p>
    <h1>${e(upload.filename)}</h1>${upload.link_url ? `<p>🔗 <a href="${e(upload.link_url)}" target="_blank" rel="noopener">${e(upload.link_url)}</a></p>` : ""}${summary ? `<p>${e(summary)}</p>` : ""}
    ${pending.length ? `<p><button class="btn ok" id="all-ok">全部批准（${pending.length}）</button> <button class="btn bad" id="all-no">全部拒绝</button></p>`
      : (!changes.length ? `<p class="muted">没有找到新的 project 资料。</p>` : "")}
    ${changes.map(ch => {
      let body;
      if (ch.field === "unit_types") body = `<div class="diff"><div class="old table-scroll"><div class="small muted">现在</div>${unitsTable(JSON.parse(ch.old_value || "[]"))}</div>
          <div class="new table-scroll"><div class="small muted">AI 建议</div>${unitsTable(JSON.parse(ch.new_value || "[]"))}</div></div>`;
      else if (ch.field === "new_project") body = `<p>AI 认为这是一个新的 project：<b>${e(ch.new_value)}</b>。批准后会建立新的 project 页面。如果其实是现有的 project，请拒绝，然后告诉 Claude 正确的名字。</p>`;
      else if (ch.field === "update") { const u = splitUpdate(ch.new_value);
        body = `<div class="diff"><div class="new md" style="grid-column:1/-1">${md(u.zh)}${u.en ? `<hr><div class="small muted">English</div>${md(u.en)}` : ""}</div></div>`; }
      else if (ch.field === "file") { const m = JSON.parse(ch.new_value); body = `<p>把 <b>${e(m.filename)}</b> 加到文件下载（${e(m.doc_type)}）。</p>`; }
      else body = `<div class="diff"><div class="old"><div class="small muted">现在</div>${md(ch.old_value) || `<span class="muted">（空）</span>`}</div>
          <div class="new"><div class="small muted">AI 建议${ch.status === "pending" ? "（可以直接修改）" : ""}</div>
          ${ch.status === "pending" ? `<textarea data-edit="${ch.id}" rows="${Math.min((ch.new_value.match(/\n/g) || []).length + 2, 14)}">${e(ch.new_value)}</textarea>` : md(ch.new_value)}</div></div>`;
      return `<div class="card" style="${ch.status !== "pending" ? "opacity:.6" : ""}">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <b>${e(ch.project_name)}</b><span class="badge">${e(FIELD_LABEL[ch.field] || ch.field)}</span>
          ${ch.status !== "pending" ? `<span class="badge ${ch.status}">${ch.status === "approved" ? "已批准" : "已拒绝"}</span>` : ""}
        </div>${body}
        ${ch.status === "pending" ? `<p style="margin-bottom:0"><button class="btn ok sm" data-ok="${ch.id}">批准</button> <button class="btn bad sm" data-no="${ch.id}">拒绝</button></p>` : ""}
      </div>`;
    }).join("")}`);

  const decide = async (ids, approve) => {
    document.querySelectorAll("button").forEach(b => b.disabled = true);
    const errors = [];
    for (const cid of ids) {
      const { data: ch } = await sb.from("changes").select("*").eq("id", cid).single();
      try {
        if (approve) {
          const edited = ids.length === 1 && $(`[data-edit="${cid}"]`);
          if (edited && edited.value !== ch.new_value) {
            ch.new_value = edited.value;
            check(await sb.from("changes").update({ new_value: edited.value }).eq("id", cid));
          }
          await applyChange(ch, upload);
        }
        check(await sb.from("changes").update({ status: approve ? "approved" : "rejected" }).eq("id", cid));
      } catch (err) { errors.push(`${ch.project_name} / ${FIELD_LABEL[ch.field] || ch.field}：${err.message}`); }
    }
    const { count } = await sb.from("changes").select("id", { count: "exact", head: true }).eq("upload_id", id).eq("status", "pending");
    if (!count) await sb.from("uploads").update({ status: "done" }).eq("id", id);
    await viewReview(id);
    if (errors.length) flash(errors.join("；"));
  };
  const ordered = pending.slice().sort((a, b) => order(a) - order(b)).map(x => x.id);
  if ($("#all-ok")) $("#all-ok").onclick = () => decide(ordered, true);
  if ($("#all-no")) $("#all-no").onclick = () => decide(ordered, false);
  document.querySelectorAll("[data-ok]").forEach(b => b.onclick = () => decide([+b.dataset.ok], true));
  document.querySelectorAll("[data-no]").forEach(b => b.onclick = () => decide([+b.dataset.no], false));
}

// ---------- admin: users ----------
async function viewUsers() {
  const res = await sb.from("profiles").select("*").order("created_at", { ascending: false });
  check(res, "读取 agents ");
  const users = res.data.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
  render(`<h1>Agents</h1><p class="muted">新申请的 agent 会排在最上面。批准之后他们才能看到 project 资料。</p>
    <div class="card table-scroll"><table>
      <tr><th>名字</th><th>Email / 电话</th><th>申请日期</th><th>状态</th><th>角色</th><th></th></tr>
      ${users.map(u => `<tr><td><b>${e(u.name)}</b></td><td>${e(u.email)}<div class="small muted">${e(u.phone)}</div></td>
        <td class="small">${e(u.created_at.slice(0, 10))}</td><td><span class="badge ${e(u.status)}">${e(u.status)}</span></td><td>${e(u.role)}</td>
        <td style="white-space:nowrap">${u.id === me.user.id ? `<span class="small muted">（你）</span>` : `
          ${u.status !== "approved" ? `<button class="btn ok sm" data-id="${u.id}" data-set="status:approved">批准</button>` : ""}
          ${u.status !== "rejected" ? `<button class="btn bad sm" data-id="${u.id}" data-set="status:rejected">${u.status === "approved" ? "停用" : "拒绝"}</button>` : ""}
          ${u.role === "agent" && u.status === "approved" ? `<button class="btn ghost sm" data-id="${u.id}" data-set="role:admin">设为管理员</button>` : ""}
          ${u.role === "admin" ? `<button class="btn ghost sm" data-id="${u.id}" data-set="role:agent">取消管理员</button>` : ""}`}
        </td></tr>`).join("")}
    </table></div>`);
  document.querySelectorAll("[data-set]").forEach(b => b.onclick = async () => {
    const [k, v] = b.dataset.set.split(":");
    if (k === "role" && v === "admin" && !confirm("设为管理员后，他可以修改所有资料和批准 agent。确定？")) return;
    check(await sb.from("profiles").update({ [k]: v }).eq("id", b.dataset.id), "更新 ");
    await viewUsers();
  });
}

// ---------- admin: comparables ----------
const COMP_COLS = ["area", "name", "property_type", "tenure", "land_sf", "bu_sf", "price", "txn_date", "source", "notes"];
const NUM_COLS = ["land_sf", "bu_sf", "price"];

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

function compRow(get) {
  const r = {};
  COMP_COLS.forEach(c => { const v = String(get(c) ?? "").trim(); r[c] = NUM_COLS.includes(c) ? toFloat(v) : v; });
  return r;
}

async function viewComparables() {
  const res = await sb.from("comparables").select("*").order("area").order("txn_date", { ascending: false });
  check(res, "读取成交记录 ");
  render(`<h1>周边成交 / Sub-sale 记录</h1>
    <p class="muted">这些记录会出现在每个 project 的「附近成交」和价格对比页。系统用「地区」来配对，所以地区名字请和 project 的写法一致（例如 Kapar、Setia Alam、Jenjarom）。</p>
    <div class="two">
      <div class="card"><h2>导入 CSV</h2>
        <p class="small muted">从 Brickz / LPPEH / CH 整理成 Excel，另存为 CSV。第一行要有这些栏位：<br><code>${COMP_COLS.join(", ")}</code></p>
        <input type="file" id="csv" accept=".csv"><p><button class="btn" id="import">导入</button></p></div>
      <div class="card"><h2>手动加一条</h2><form id="f"><div class="calc">
        <div><label>地区 *</label><input name="area" required></div><div><label>名称 *</label><input name="name" required></div>
        <div><label>类型</label><input name="property_type" placeholder="1.5s Semi-D Factory"></div><div><label>Tenure</label><input name="tenure"></div>
        <div><label>Land sf</label><input name="land_sf"></div><div><label>BU sf</label><input name="bu_sf"></div>
        <div><label>价格</label><input name="price" placeholder="3.2mil"></div><div><label>日期</label><input name="txn_date" placeholder="2026-08"></div>
        <div><label>来源</label><select name="source"><option>Brickz</option><option>LPPEH</option><option>CH</option><option>Subsale listing</option></select></div>
      </div><label>备注</label><input name="notes"><p><button class="btn" type="submit">加入</button></p></form></div>
    </div>
    <div class="card table-scroll"><table>
      <tr><th>地区</th><th>名称</th><th>类型</th><th class="num">Land</th><th class="num">BU</th><th class="num">价格</th><th class="num">psf BU</th><th>日期</th><th>来源</th><th></th></tr>
      ${res.data.map(c => `<tr><td>${e(c.area)}</td><td>${e(c.name)}</td><td>${e(c.property_type)}</td>
        <td class="num">${num(c.land_sf)}</td><td class="num">${num(c.bu_sf)}</td><td class="num">${rm(c.price)}</td>
        <td class="num">${num(psf(c.price, c.bu_sf))}</td><td>${e(c.txn_date)}</td><td>${e(c.source)}</td>
        <td><button class="btn bad sm" data-del="${c.id}">删除</button></td></tr>`).join("") || `<tr><td colspan="10" class="muted">还没有记录。</td></tr>`}
    </table></div>`);
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    check(await sb.from("comparables").insert(compRow(c => f.get(c))), "加入 ");
    await viewComparables();
  };
  $("#import").onclick = async () => {
    const file = $("#csv").files[0];
    if (!file) return;
    const rows = parseCSV((await file.text()).replace(/^﻿/, ""));
    const head = rows.shift().map(h => h.trim().toLowerCase());
    const records = rows.map(r => compRow(c => r[head.indexOf(c)])).filter(r => r.area && r.name);
    if (records.length) check(await sb.from("comparables").insert(records), "导入 ");
    await viewComparables();
    flash(`已导入 ${records.length} 条成交记录。`);
  };
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    check(await sb.from("comparables").delete().eq("id", b.dataset.del), "删除 ");
    await viewComparables();
  });
}

// ---------- admin: edit project ----------
async function viewEdit(slug) {
  let p = null, units = [], files = [];
  if (slug) {
    const res = await sb.from("projects").select("*, unit_types(*), files(*)").eq("slug", slug).maybeSingle();
    check(res, "读取 project ");
    p = res.data;
    if (!p) { render(`<div class="card"><h1>找不到这个 project</h1></div>`); return; }
    units = p.unit_types.sort((a, b) => a.id - b.id);
    files = p.files.sort((a, b) => a.filename.localeCompare(b.filename));
  }
  const photos = files.filter(f => f.doc_type === PHOTO && f.storage_path).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const plans = files.filter(f => f.doc_type === PLAN && f.storage_path && f.unit_type).sort((a, b) => a.unit_type.localeCompare(b.unit_type) || a.sort_order - b.sort_order);
  files = files.filter(f => !photos.includes(f) && !plans.includes(f));
  const photoUrls = await signUrls(photos.concat(plans).map(f => f.storage_path));
  const typeNames = [...new Set(units.map(u => u.name.replace(/[（(].*$/, "").trim()))];
  const v = k => e(p ? p[k] ?? "" : "");
  const n = x => x == null ? "" : Math.round(+x);
  render(`<p class="small"><a href="${p ? "#/p/" + encodeURIComponent(p.slug) : "#/projects"}">← 返回</a></p>
    <h1>${p ? "编辑：" + e(p.name) : "新增 project"}</h1>
    <form id="f"><div class="card"><div class="two">
      <div><label>名字</label><input name="name" value="${v("name")}" required></div>
      <div><label>地区</label><input name="area" value="${v("area")}"></div>
      <div><label>发展商</label><input name="developer" value="${v("developer")}"></div>
      <div><label>类型</label><input name="category" value="${v("category")}" placeholder="Semi-D Factory / Link Factory / Industrial Land"></div>
      <div><label>地契</label><input name="tenure" value="${v("tenure")}" placeholder="Freehold / 99-year Leasehold"></div>
      <div><label>状态</label><select name="status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${p && p.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label>Google Maps 链接（按「分享」→「复制链接」贴上来；地图标记会跟着这个链接）</label><input name="location_url" value="${v("location_url")}" placeholder="https://www.google.com/maps/place/… 或 3.0412, 101.4523">
        <div class="small muted" style="margin-top:4px">手机或电脑的 Google Maps 都可以：找到地点 → 分享 → 复制链接，例如 https://maps.app.goo.gl/…；也可以直接贴坐标。${p && hasGeo(p) ? `现在：${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${p.geo_approx ? "（大约位置）" : ""}` : ""}</div></div>
      <div><label>Google Drive 文件夹</label><input name="drive_url" value="${v("drive_url")}"></div>
    </div>
    <label>地点与基本资料（Markdown，每行 "- " 开头）</label><textarea name="info_md" rows="10">${v("info_md")}</textarea>
    <label>Package（rebate、booking、promotion）</label><textarea name="package_md" rows="6">${v("package_md")}</textarea>
    <label>基本资料 — 英文版（agent 切换到 EN 时显示；留空就显示中文。改了中文、没改英文的话，英文会自动清空，避免旧资料）</label><textarea name="info_md_en" rows="8">${v("info_md_en")}</textarea>
    <label>Package — 英文版</label><textarea name="package_md_en" rows="5">${v("package_md_en")}</textarea>
    <label>Blasting template（不用写 Location Map 和名字电话，复制时会自动加上发送者自己的名字电话）</label><textarea name="blast_template" rows="14">${v("blast_template")}</textarea></div>
    <div class="card table-scroll"><h2>Unit 类型与价格</h2>
      <p class="small muted">价格可以写 2.41mil、2410000 或 2,410,000。名字留空的行会被删除。</p>
      <table id="units"><tr><th>Type</th><th>Land sf</th><th>BU sf</th><th>SPA</th><th>Nett</th><th>Available</th><th>备注</th></tr>
      ${units.concat([null, null, null]).map(u => `<tr>
        <td><input data-u="name" value="${e(u?.name)}"></td><td><input data-u="land_sf" value="${u ? n(u.land_sf) : ""}"></td>
        <td><input data-u="bu_sf" value="${u ? n(u.bu_sf) : ""}"></td><td><input data-u="spa_price" value="${u ? n(u.spa_price) : ""}"></td>
        <td><input data-u="nett_price" value="${u ? n(u.nett_price) : ""}"></td><td><input data-u="available" value="${e(u?.available)}"></td>
        <td><input data-u="notes" value="${e(u?.notes)}"></td></tr>`).join("")}</table>
      <p><button type="button" class="btn ghost sm" id="addrow">+ 多一行</button></p></div>
    <div class="card"><h2>照片</h2>
      <p class="small muted">第一张是封面，会显示在 project 列表和地图上。照片会自动压缩。</p>
      ${photos.length ? `<div class="photos-edit">${photos.map((f, i) => `<figure><img src="${e(photoUrls[f.storage_path] || "")}" alt="">
        <figcaption><label style="display:inline;margin:0"><input type="radio" name="cover" value="${f.id}" style="width:auto" ${i ? "" : "checked"}> 封面</label>
        <label style="display:inline;margin:0;color:var(--bad)"><input type="checkbox" data-delfile="${f.id}" style="width:auto"> 删除</label></figcaption></figure>`).join("")}</div>` : ""}
      <label>上传照片（可以一次选多张）</label><input type="file" id="newphotos" multiple accept="image/*"></div>
    <div class="card"><h2>📐 Layout（每个 type 的平面图）</h2>
      <p class="small muted">选 type，再选平面图图片（JPG / PNG，一个 type 可以放几张）。网站会在价格表和 Layout 区显示。</p>
      ${plans.length ? `<div class="photos-edit">${plans.map(f => `<figure><img src="${e(photoUrls[f.storage_path] || "")}" alt="">
        <figcaption><b>${e(f.unit_type)}</b>
        <label style="display:inline;margin:0;color:var(--bad)"><input type="checkbox" data-delfile="${f.id}" style="width:auto"> 删除</label></figcaption></figure>`).join("")}</div>` : ""}
      <div class="two"><div><label>Type</label><input id="plantype" list="typelist" placeholder="例如 Type A"><datalist id="typelist">${typeNames.map(t => `<option value="${e(t)}">`).join("")}</datalist></div>
      <div><label>平面图图片</label><input type="file" id="newplans" multiple accept="image/*"></div></div></div>
    <div class="card"><h2>文件</h2>
      ${files.map(f => `<div><label style="display:inline;color:inherit"><input type="checkbox" data-delfile="${f.id}" style="width:auto"> 删除</label>
        ${e(f.filename)} <span class="small muted">${e(f.doc_type)}${f.storage_path ? "" : " · Drive"}</span></div>`).join("")}
      <label>上传新文件（直接附上，不经过 AI；每个最多 50 MB）</label><input type="file" id="newfiles" multiple>
      <label>文件类型</label><select id="doctype">${DOC_TYPES.map(t => `<option>${t}</option>`).join("")}</select></div>
    <p><button class="btn" type="submit">保存</button> <span id="prog" class="small muted"></span></p></form>
    ${p ? `<p><button class="btn bad sm" id="del">删除这个 project</button></p>` : ""}`);

  $("#addrow").onclick = () => {
    const tr = $("#units tr:last-child").cloneNode(true);
    tr.querySelectorAll("input").forEach(i => i.value = "");
    $("#units").appendChild(tr);
  };
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const f = new FormData(ev.target);
      const row = { name: f.get("name").trim(), drive_url: f.get("drive_url").trim(), updated_at: new Date().toISOString() };
      PROJECT_FIELDS.forEach(k => row[k] = String(f.get(k) || "").trim());
      // Chinese changed but its English copy was left as it was: drop the outdated English.
      if (p) Object.entries(EN_OF).forEach(([zh, en]) => {
        if (row[zh] !== (p[zh] || "").trim() && row[en] === (p[en] || "").trim()) row[en] = "";
      });
      const geo = await locate(row.location_url);
      if (geo) Object.assign(row, geo, { geo_approx: false });
      else if (row.location_url && row.location_url !== (p?.location_url || ""))
        throw new Error("这个 Google Maps 链接读不到位置。请在 Google Maps 按「分享」→「复制链接」再贴一次。");
      let pid, newSlug;
      if (p) {
        check(await sb.from("projects").update(row).eq("id", p.id), "保存 ");
        pid = p.id; newSlug = p.slug;
      } else {
        newSlug = await uniqueSlug(row.name);
        const ins = await sb.from("projects").insert({ ...row, slug: newSlug }).select("id").single();
        check(ins, "新增 ");
        pid = ins.data.id;
      }
      const unitRows = [...document.querySelectorAll("#units tr")].slice(1).map(tr => {
        const g = k => tr.querySelector(`[data-u="${k}"]`).value.trim();
        return { project_id: pid, name: g("name"), land_sf: toFloat(g("land_sf")), bu_sf: toFloat(g("bu_sf")),
          spa_price: toFloat(g("spa_price")), nett_price: toFloat(g("nett_price")), available: g("available"), notes: g("notes") };
      }).filter(u => u.name);
      check(await sb.from("unit_types").delete().eq("project_id", pid), "保存价格 ");
      if (unitRows.length) check(await sb.from("unit_types").insert(unitRows), "保存价格 ");
      for (const box of document.querySelectorAll("[data-delfile]:checked")) {
        const file = files.concat(photos, plans).find(x => x.id === +box.dataset.delfile);
        if (file.storage_path) await sb.storage.from("docs").remove([file.storage_path]);
        check(await sb.from("files").delete().eq("id", file.id), "删除文件 ");
      }
      const cover = photos.find(x => x.id === +f.get("cover"));
      if (cover && cover !== photos[0] && !document.querySelector(`[data-delfile="${cover.id}"]:checked`))
        check(await sb.from("files").update({ sort_order: Math.min(...photos.map(x => x.sort_order)) - 1 }).eq("id", cover.id), "设封面 ");
      let order = photos.length ? Math.max(...photos.map(x => x.sort_order)) : 0;
      const newPhotos = [...$("#newphotos").files];
      for (const [i, file] of newPhotos.entries()) {
        $("#prog").textContent = `上传照片 ${i + 1}/${newPhotos.length}…`;
        const img = await shrinkImage(file);
        const path = `files/${uuid()}${img.ext}`;
        const s = await sb.storage.from("docs").upload(path, img.blob, { contentType: img.blob.type || undefined });
        if (s.error) throw new Error(`${file.name} 上传失败：${s.error.message}`);
        check(await sb.from("files").insert({ project_id: pid, filename: file.name, doc_type: PHOTO, storage_path: path, sort_order: ++order }), "记录照片 ");
      }
      const newPlans = [...$("#newplans").files], planType = $("#plantype").value.trim();
      if (newPlans.length && !planType) throw new Error("请先填写平面图是哪一个 Type。");
      for (const [i, file] of newPlans.entries()) {
        $("#prog").textContent = `上传平面图 ${i + 1}/${newPlans.length}…`;
        const img = await shrinkImage(file, 2400);
        const path = `files/${uuid()}${img.ext}`;
        const s = await sb.storage.from("docs").upload(path, img.blob, { contentType: img.blob.type || undefined });
        if (s.error) throw new Error(`${file.name} 上传失败：${s.error.message}`);
        check(await sb.from("files").insert({ project_id: pid, filename: `${planType} layout`, doc_type: PLAN, unit_type: planType, storage_path: path, sort_order: i + 1 }), "记录平面图 ");
      }
      for (const file of $("#newfiles").files) {
        $("#prog").textContent = "上传中：" + file.name;
        const path = `files/${uuid()}${ext(file.name)}`;
        const s = await sb.storage.from("docs").upload(path, file);
        if (s.error) throw new Error(`${file.name} 上传失败：${s.error.message}`);
        check(await sb.from("files").insert({ project_id: pid, filename: file.name, doc_type: $("#doctype").value, storage_path: path }), "记录文件 ");
      }
      location.hash = "#/p/" + encodeURIComponent(newSlug);
      setTimeout(() => flash("已保存。"), 300);
    } catch (err) {
      btn.disabled = false;
      flash(err.message, true);
    }
  };
  if ($("#del")) $("#del").onclick = async () => {
    if (!confirm(`确定删除 ${p.name}？所有资料和文件都会删除。`)) return;
    const paths = files.concat(photos, plans).filter(f => f.storage_path).map(f => f.storage_path);
    if (paths.length) await sb.storage.from("docs").remove(paths);
    check(await sb.from("projects").delete().eq("id", p.id), "删除 ");
    location.hash = "#/projects";
  };
}

// ---------- start ----------
(async () => {
  if (sb) {
    await loadMe();
    sb.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") { me = null; renderNav(); }
    });
  }
  renderNav();
  document.addEventListener("click", ev => {
    if (ev.target.id !== "lang") return;
    ev.preventDefault();
    lang = lang === "en" ? "zh" : "en";
    try { localStorage.setItem("omr_lang", lang); } catch {}
    document.documentElement.lang = lang === "en" ? "en" : "zh";
    route();
  });
  document.documentElement.lang = lang === "en" ? "en" : "zh";
  window.addEventListener("hashchange", route);
  route();
})();

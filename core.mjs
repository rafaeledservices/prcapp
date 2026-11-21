// Parent Resource Centers - online API (runs as a Netlify Function).
// Same job as server.py, for the internet version:
//  - Staff sign in with a password (STAFF_PASSWORD) and then read/save all the data.
//  - Parents (from the QR) can only see the class name/date of an open check-in and send name + phone.
// Pure logic: `store` is a Netlify Blobs store (get / setJSON / list / delete), so it can be tested anywhere.

const enc = new TextEncoder();
const SESSION_HOURS = 12;
const COUNTED = ["enrolled", "completed"];

/* ---------- small helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function b64url(buf) {
  let s = "";
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- staff sessions (signed, expire after SESSION_HOURS) ---------- */
export async function makeToken(secret, now) {
  const exp = now + SESSION_HOURS * 3600e3;
  return `${exp}.${await hmac(secret, "prc-staff:" + exp)}`;
}
export async function checkToken(secret, token, now) {
  if (!secret || !token) return false;
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return safeEqual(await hmac(secret, "prc-staff:" + exp), sig);
}

/* ---------- dates in the center's time zone ---------- */
function parts(now, tz) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).forEach((x) => (p[x.type] = x.value));
  return p;
}
export const localDate = (now, tz) => { const p = parts(now, tz); return `${p.year}-${p.month}-${p.day}`; };
export const localDateTime = (now, tz) => { const p = parts(now, tz); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };

/* ---------- matching a parent to the roster (same rules as the app) ---------- */
export const normName = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).join(" ");
export const normPhone = (s) => String(s || "").replace(/\D/g, "").slice(-10);
export function nameMatch(st, nm) {
  const full = normName(`${st.first_name || ""} ${st.last_name || ""}`);
  const first = normName(st.first_name || "").split(" ")[0];
  return nm === full || nm.split(" ")[0] === first || (nm.length >= 3 && full.includes(nm));
}

/* ---------- data ---------- */
async function readData(store) {
  const d = await store.get("data", { type: "json" });
  return d && typeof d.rev === "number" ? d : { rev: 0, db: null };
}
function findSession(db, token, today) {
  if (!db || !token) return null;
  return (db.sessions || []).find((s) => s.token === token && s.open && s.date === today) || null;
}
function sessionPublic(db, s) {
  const sec = (db.sections || []).find((x) => x.id === s.section_id) || {};
  const meets = sec.meetings || [];
  const mi = s.meeting;
  return { section: sec.name || "", date: s.date, meeting: Number.isInteger(mi) && mi >= 0 && mi < meets.length ? meets[mi] : null };
}

/* ---------- request handler ---------- */
export async function handle(req, { store, env, now = Date.now() }) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const tz = env.TIMEZONE || "America/Los_Angeles";
  const password = env.STAFF_PASSWORD || "";
  const today = localDate(now, tz);
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const body = async () => { try { return await req.json(); } catch { return null; } };

  // Public: tells the app it is running online
  if (path === "/info" && method === "GET") return json(200, { mode: "cloud", configured: !!password, today });

  // Public: staff sign in
  if (path === "/login" && method === "POST") {
    if (!password) return json(500, { error: "not_configured" });
    const b = await body();
    if (!b || typeof b.password !== "string" || !safeEqual(b.password, password)) { await sleep(800); return json(401, { error: "wrong_password" }); }
    return json(200, { token: await makeToken(password, now), hours: SESSION_HOURS });
  }

  // Public: what the parent's phone shows (class name, date and time only)
  if (path.startsWith("/session/") && method === "GET") {
    const { db } = await readData(store);
    const s = findSession(db, decodeURIComponent(path.slice("/session/".length)), today);
    if (!s) return json(404, { ok: false, code: "closed" });
    return json(200, { ok: true, ...sessionPublic(db, s) });
  }

  // Public: a parent checks in with name + phone
  if (path === "/checkin" && method === "POST") {
    const b = await body();
    if (!b) return json(400, { ok: false, code: "network" });
    const token = String(b.token || "").slice(0, 64), nm = normName(String(b.name || "").slice(0, 120)), ph = normPhone(String(b.phone || "").slice(0, 40));
    const { db } = await readData(store);
    const s = findSession(db, token, today);
    if (!s) return json(400, { ok: false, code: "closed" });
    if (!nm) return json(400, { ok: false, code: "name" });
    if (ph.length < 7) return json(400, { ok: false, code: "phone" });
    const ids = new Set((db.enrollments || []).filter((e) => e.section_id === s.section_id && COUNTED.includes(e.status)).map((e) => e.student_id));
    const st = (db.students || []).find((p) => ids.has(p.id) && normPhone(p.phone) === ph && nameMatch(p, nm));
    if (!st) { await sleep(400); return json(400, { ok: false, code: "nomatch" }); }
    const key = `ck/${token}/${st.id}`;
    const inData = (db.attendance || []).some((a) => a.section_id === s.section_id && a.student_id === st.id && a.date === s.date && a.meeting === s.meeting && a.method === "qr");
    const pending = await store.get(key, { type: "json" });
    if (!inData && !pending) {
      await store.setJSON(key, { key, token, section_id: s.section_id, student_id: st.id, date: s.date, meeting: s.meeting, time: localDateTime(now, tz) });
    }
    return json(200, { ok: true, already: !!(inData || pending), first_name: st.first_name || "", ...sessionPublic(db, s) });
  }

  // Everything below is for signed-in staff only
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!(await checkToken(password, auth, now))) return json(401, { error: "login_required" });

  if (path === "/data" && method === "GET") return json(200, await readData(store));

  if (path === "/data" && method === "PUT") {
    const b = await body();
    if (!b || typeof b.db !== "object" || b.db === null || typeof b.rev !== "number") return json(400, { error: "bad_request" });
    const cur = await readData(store);
    if (b.rev !== cur.rev) return json(409, { error: "conflict", rev: cur.rev });   // someone else saved first
    const rev = cur.rev + 1;
    await store.setJSON("data", { rev, db: b.db });
    return json(200, { ok: true, rev });
  }

  if (path === "/checkins" && method === "GET") {
    const { blobs } = await store.list({ prefix: "ck/" });
    const out = [];
    for (const x of blobs) { const v = await store.get(x.key, { type: "json" }); if (v) out.push({ ...v, key: x.key }); }
    return json(200, out);
  }

  // The app confirms it saved these check-ins into the data, so they can be removed
  if (path === "/checkins/ack" && method === "POST") {
    const b = await body();
    for (const k of (b && Array.isArray(b.keys) ? b.keys : [])) if (typeof k === "string" && k.startsWith("ck/")) await store.delete(k);
    return json(200, { ok: true });
  }

  return json(404, { error: "not_found" });
}

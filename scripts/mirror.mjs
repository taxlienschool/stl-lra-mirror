// Nightly mirror of the City of St. Louis LRA inventory CSV plus, for its
// parcels, values and outlines from the City's parcel layer. Reads the
// previous mirror from ./data, writes the new one to ./out. Exits non-zero
// (publishing nothing) if the CSV fails validation. Requests are made one at
// a time, the same requests tls-ai-platform's sync makes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CSV_URL = "https://static.stlouis-mo.gov/open-data/SLDC/REAL-ESTATE/LRA_INVENTORY_AVAILABLE.csv";
const PARCELS = "https://maps6.stlouis-mo.gov/arcgis/rest/services/St_Louis_Parcels/MapServer/0";
const HEADER = ["ParcelId", "Address", "PropertyType", "Side lot Eligible?", "Usage", "SQFT"];
const PREV = "data", OUT = "out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const prev = (f) => (existsSync(`${PREV}/${f}`) ? readFileSync(`${PREV}/${f}`) : null);
const now = new Date().toISOString();

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function idsOf(buf) {
  const t = parseCsv(buf.toString("latin1"));
  const h = t[0] ?? [];
  const missing = HEADER.filter((c) => !h.includes(c));
  if (missing.length) throw new Error(`CSV is missing columns: ${missing.join(", ")}`);
  const bad = t.slice(1).filter((r) => r.length !== h.length).length;
  if (bad) throw new Error(`CSV has ${bad} malformed rows`);
  const i = h.indexOf("ParcelId");
  return { rows: t.length - 1, ids: [...new Set(t.slice(1).map((r) => r[i].trim()).filter(Boolean))] };
}

async function post(where, extra) {
  const body = new URLSearchParams({ where, ...extra, f: "json" });
  const res = await fetch(`${PARCELS}/query`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`parcel layer HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`parcel layer error: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.features ?? [];
}
const inList = (ids) => `ParcelId IN (${ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")})`;

// ---- a. CSV ----
const res = await fetch(CSV_URL, { signal: AbortSignal.timeout(60_000) });
if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
const csv = Buffer.from(await res.arrayBuffer());
const { rows, ids } = idsOf(csv);
const prevMeta = prev("meta.json") ? JSON.parse(prev("meta.json").toString()) : null;
if (prevMeta?.csv?.rows) {
  const r = rows / prevMeta.csv.rows;
  if (r < 0.8 || r > 1.2) throw new Error(`CSV has ${rows} rows vs ${prevMeta.csv.rows} last time (outside 20%); not publishing`);
} else if (rows < 1000) throw new Error(`first mirror: only ${rows} rows`);
console.log(`CSV: ${rows} rows, ${ids.length} parcel ids, ${csv.length} bytes`);
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/lra.csv`, csv);
const meta = { fetchedAt: now, csv: { url: CSV_URL, fetchedAt: now, rows, ids: ids.length, bytes: csv.length, sha256: sha(csv) } };

// ---- b. values: 400 ids per request, AprLand + CostAprImprove (as readCountyValues) ----
let requests = 0;
try {
  const values = {};
  for (let i = 0; i < ids.length; i += 400) {
    for (const f of await post(inList(ids.slice(i, i + 400)), { outFields: "ParcelId,AprLand,CostAprImprove", returnGeometry: "false" })) {
      const a = f.attributes;
      values[String(a.ParcelId)] = { AprLand: a.AprLand ?? null, CostAprImprove: a.CostAprImprove ?? null };
    }
    requests++; await sleep(500);
  }
  const b = Buffer.from(JSON.stringify(values));
  writeFileSync(`${OUT}/values.json`, b);
  meta.values = { fetchedAt: now, count: Object.keys(values).length, bytes: b.length, sha256: sha(b) };
  console.log(`values: ${meta.values.count} parcels, ${requests} requests`);
} catch (e) {
  // Keep yesterday's values (with yesterday's fetchedAt) rather than none.
  console.log(`values FAILED, keeping previous: ${e.message}`);
  if (prev("values.json")) { writeFileSync(`${OUT}/values.json`, prev("values.json")); meta.values = { ...prevMeta?.values, error: e.message }; }
}

// ---- c. outlines: 100 ids per request, outSR 4326 (as lookupOutlines). New ids only; all on the first run ----
const prevAll = prev("outlines-all.json") ? JSON.parse(prev("outlines-all.json").toString()) : {};
const prevIds = prev("lra.csv") ? new Set(idsOf(prev("lra.csv")).ids) : null;
const want = ids.filter((id) => !prevIds || !prevIds.has(id) || !(id in prevAll));
const fresh = {}, dupes = new Set();
let oreq = 0, outlineError = null;
try {
  for (let i = 0; i < want.length; i += 100) {
    for (const f of await post(inList(want.slice(i, i + 100)), { outFields: "ParcelId", returnGeometry: "true", outSR: "4326" })) {
      const id = String(f.attributes.ParcelId ?? "");
      if (!f.geometry?.rings?.length) continue;
      if (id in fresh) dupes.add(id);
      fresh[id] = f.geometry.rings;
    }
    oreq++; await sleep(500);
  }
} catch (e) { outlineError = e.message; console.log(`outlines FAILED part way: ${e.message}`); }
for (const d of dupes) delete fresh[d];
// The full set, for today's parcels only: yesterday's plus today's.
const keep = new Set(ids);
const all = Object.fromEntries(Object.entries({ ...prevAll, ...fresh }).filter(([id]) => keep.has(id)));
for (const [name, obj, key] of [["outlines-new.json", fresh, "outlinesNew"], ["outlines-all.json", all, "outlinesAll"]]) {
  const b = Buffer.from(JSON.stringify(obj));
  writeFileSync(`${OUT}/${name}`, b);
  meta[key] = { fetchedAt: now, count: Object.keys(obj).length, bytes: b.length, sha256: sha(b), ...(key === "outlinesNew" ? { asked: want.length, requests: oreq, error: outlineError } : {}) };
}
console.log(`outlines: ${Object.keys(fresh).length} new of ${want.length} asked (${oreq} requests), ${Object.keys(all).length} in full set`);
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta, null, 2));

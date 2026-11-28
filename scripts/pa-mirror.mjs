// Pennsylvania repository lists for tls-ai-platform, from counties whose
// sites refuse its servers but not GitHub's. The app gives the plan (which
// county pages, which parcel keys); this script makes one request per page
// and per list file, and posts what it gets straight back to the app, which
// reads it with its own code. NOTHING is written to this repository: the
// lists carry owner names. Logs show status lines only, never content.
// Exits non-zero (the job fails) if any step fails.
const APP = `${process.env.APP_URL ?? "https://app.taxlienai1.com"}/api/cron/pa-mirror`;
const TOKEN = process.env.PA_MIRROR_TOKEN;
if (!TOKEN) throw new Error("PA_MIRROR_TOKEN is not set");
const UA = { "User-Agent": "Mozilla/5.0 (compatible; TaxLienSchool-Marketplace)" };
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

async function app(query, init = {}) {
  const res = await fetch(`${APP}${query}`, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(280_000) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
}

const plan = await app("?step=plan", { method: "POST" });
if (plan.status !== 200) throw new Error(`plan: HTTP ${plan.status}`);

for (const c of plan.body.counties ?? []) {
  try {
    const page = await fetch(c.pageUrl, { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!page.ok) throw new Error(`county page HTTP ${page.status}`);
    const link = await app(`?step=page&county=${encodeURIComponent(c.county)}`, { method: "POST", body: await page.text(), headers: { "Content-Type": "text/html" } });
    if (link.status !== 200) throw new Error(`no list link (HTTP ${link.status})`);
    await sleep(1000);
    const file = await fetch(link.body.listUrl, { headers: UA, signal: AbortSignal.timeout(120_000) });
    if (!file.ok) throw new Error(`list file HTTP ${file.status}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const r = await app(`?step=list&county=${encodeURIComponent(c.county)}&url=${encodeURIComponent(file.url || link.body.listUrl)}`, {
      method: "POST", body: bytes, headers: { "Content-Type": file.headers.get("content-type") ?? "application/octet-stream" },
    });
    console.log(`${c.county}: list ${bytes.length}B -> app ${r.status} ${r.body.status ?? ""}`);
    if (r.status !== 200) failed++;
  } catch (e) {
    console.log(`${c.county}: FAILED ${e.message}`);
    failed++;
  }
  await sleep(1000);
}

for (const p of plan.body.parcels ?? []) {
  try {
    // Query the layer 50 keys at a time, then post everything in ONE request.
    const features = [];
    for (let i = 0; i < p.pins.length; i += 50) {
      const asked = p.pins.slice(i, i + 50);
      const where = `${p.pinField} IN (${asked.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",")})`;
      const res = await fetch(`${p.layerUrl}/query`, {
        method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ f: "json", where, outFields: p.outFields.join(","), returnGeometry: "true", outSR: "4326" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`parcel layer HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(`parcel layer error ${j.error.code ?? ""}`);
      for (const f of j.features ?? []) features.push({ attributes: f.attributes, geometry: f.geometry });
      await sleep(400);
    }
    const r = await app(`?step=parcels&county=${encodeURIComponent(p.county)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asked: p.pins, features }),
    });
    if (r.status !== 200) throw new Error(`app HTTP ${r.status}`);
    console.log(`${p.county}: parcels ${p.pins.length} asked, ${r.body.matched} matched, ${r.body.none} not in the layer`);
  } catch (e) {
    console.log(`${p.county}: parcels FAILED ${e.message}`);
    failed++;
  }
}

if (failed) { console.error(`${failed} step(s) failed`); process.exit(1); }

// Analyse results/tuning_*.json.  node tests/analyze.js
const fs = require('fs');
const files = fs.readdirSync(__dirname + '/../results').filter(f => /^tuning_\d+\.json$/.test(f));
const runs = files.map(f => JSON.parse(fs.readFileSync(__dirname + '/../results/' + f)));
const pairs = { register: ['low', 'high'], key: ['keyC', 'keyFs'], rhythm: ['straight', 'broken'], order: ['up', 'down'] };
const L = Math.log;
function rng(s) { return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const report = { seeds: [], pooled: {} };
const allPair = {}; let allDiag = [], allNull = [];
for (const R of runs) {
  const names = R.names, n = names.length;
  // log responses, grown worlds x songs, double-centred (removes "this world is louder" and "this song is louder")
  const M = names.map(w => names.map(s => L(R.resp[w][s])));
  const rm = M.map(r => r.reduce((a, b) => a + b) / n), cm = names.map((_, j) => M.reduce((a, r) => a + r[j], 0) / n), gm = rm.reduce((a, b) => a + b) / n;
  const C = M.map((r, i) => r.map((v, j) => v - rm[i] - cm[j] + gm));
  const diag = names.reduce((a, _, i) => a + C[i][i], 0) / n;
  // permutation null: shuffle which world is "own"
  const r = rng(R.seed + 1); let ge = 0, le = 0; const T = 20000, nulls = [];
  for (let t = 0; t < T; t++) { const p = names.map((_, i) => i); for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    const v = p.reduce((a, pi, i) => a + C[pi][i], 0) / n; nulls.push(v); if (v >= diag) ge++; if (v <= diag) le++; }
  const recog = names.filter((s, j) => { let best = -1, bv = -1e9; for (let i = 0; i < n; i++) if (C[i][j] > bv) { bv = C[i][j]; best = i; } return best === j; }).length;
  const recogQuiet = names.filter((s, j) => { let best = -1, bv = 1e9; for (let i = 0; i < n; i++) if (C[i][j] < bv) { bv = C[i][j]; best = i; } return best === j; }).length;
  const pr = {};
  for (const [k, [a, b]] of Object.entries(pairs)) {
    pr[k] = +(L(R.resp[a][a]) + L(R.resp[b][b]) - L(R.resp[a][b]) - L(R.resp[b][a])).toFixed(4);
    (allPair[k] = allPair[k] || []).push(pr[k]);
  }
  const growth = names.map(w => names.reduce((a, s) => a + L(R.resp[w][s] / R.resp.seed[s]), 0) / n);
  const dist = (x, y) => Math.sqrt(x.reduce((a, v, k) => a + (v - y[k]) ** 2, 0) / x.length);
  const irPair = Object.fromEntries(Object.entries(pairs).map(([k, [a, b]]) => [k, { betweenPair: +dist(R.ir[a], R.ir[b]).toFixed(2), aToOriginal: +dist(R.ir[a], R.ir.seed).toFixed(2), bToOriginal: +dist(R.ir[b], R.ir.seed).toFixed(2) }]));
  report.seeds.push({ seed: R.seed, grow_s: R.GROW, diagonal: +diag.toFixed(4), p_higher: ge / T, p_lower: le / T, recognitionLoudest: `${recog}/${n}`, recognitionQuietest: `${recogQuiet}/${n}`,
    pairContrast: pr, meanGrowthEffect_logRatio: +(growth.reduce((a, b) => a + b) / n).toFixed(3), irDistance_dB: irPair,
    matter: Object.fromEntries(Object.entries(R.matter).map(([k, v]) => [k, { goldOnCracks: +v.goldOnCracks.toFixed(3), sandSD: +v.sandSD.toFixed(3) }])) });
  allDiag.push(diag);
}
// pooled: mean diagonal across seeds; sign test on pair contrasts
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
report.pooled.meanDiagonal = +mean(allDiag).toFixed(4);
report.pooled.seedsWithPositiveDiagonal = `${allDiag.filter(x => x > 0).length}/${allDiag.length}`;
report.pooled.pairs = Object.fromEntries(Object.entries(allPair).map(([k, v]) => [k, { mean: +mean(v).toFixed(4), positive: `${v.filter(x => x > 0).length}/${v.length}`, values: v }]));
const all = Object.values(allPair).flat();
report.pooled.allPairContrasts = { positive: `${all.filter(x => x > 0).length}/${all.length}`, mean: +mean(all).toFixed(4) };
fs.writeFileSync(__dirname + '/../results/tuning_summary.json', JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));

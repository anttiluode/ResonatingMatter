// Tuning experiment for one seed: grow one body per song, freeze, play every song into every body.
// Usage: node tests/experiment.js SEED [growSeconds] [listenSeconds]
const RM = require('./load')(), fs = require('fs');
const seed = +process.argv[2] || 2718, GROW = +process.argv[3] || 90, LISTEN = +process.argv[4] || 6;
const names = Object.keys(RM.SONGS), PR = RM.PR, CH = PR;
const songs = {}; for (const k of names) songs[k] = RM.makeSong(RM.SONGS[k], Math.max(GROW, LISTEN));
function grow(name, seconds, body) {
  const b = body || new RM.Body(seed); const s = songs[name];
  for (let t = 0; t < seconds; t++) b.run(CH, s.subarray(t * CH, (t + 1) * CH));
  return b;
}
// response of a frozen body to a song: output power over the last (LISTEN-2) s
function listen(matter, name) {
  const b = new RM.Body(seed, { frozen: 1 }); if (matter) b.setMatter(matter);
  const s = songs[name], out = new Float32Array(2 * CH); let e = 0;
  for (let t = 0; t < LISTEN; t++) { b.run(CH, s.subarray(t * CH, (t + 1) * CH), out); if (t >= 2) for (let i = 0; i < out.length; i++) e += out[i] * out[i]; }
  return e / ((LISTEN - 2) * 2 * CH);
}
// impulse response spectrum at a fixed strike point, read at both pickups
function irSpectrum(matter, sx, sy) {
  const b = new RM.Body(seed, { frozen: 1 }); if (matter) b.setMatter(matter);
  const n = 16384, out = new Float32Array(2 * n); b.strike(sx, sy, 1); b.run(n, null, out);
  return bandSpectrum(out, n);
}
function bandSpectrum(out, n) { // 48 log-spaced bands 80 Hz .. 4 kHz, via direct DFT on bins (cheap enough offline)
  const bands = 48, res = new Float64Array(bands);
  for (let k = 0; k < bands; k++) {
    const f0 = 80 * Math.pow(50, k / bands), f1 = 80 * Math.pow(50, (k + 1) / bands);
    let acc = 0, cnt = 0;
    for (let f = f0; f < f1; f += Math.max(2, (f1 - f0) / 6)) {
      const w = 2 * Math.PI * f / PR; let re = 0, im = 0;
      for (let t = 0; t < n; t += 1) { const x = out[2 * t] + out[2 * t + 1]; re += x * Math.cos(w * t); im += x * Math.sin(w * t); }
      acc += re * re + im * im; cnt++;
    }
    res[k] = 10 * Math.log10(acc / cnt + 1e-30);
  }
  return Array.from(res);
}
const t0 = Date.now(), R = { seed, GROW, LISTEN, names, matter: {}, resp: {}, ir: {} };
const seedBody = new RM.Body(seed), strikePt = seedBody.driver.slice();
const grown = {};
for (const k of names) { grown[k] = grow(k, GROW).getMatter(); process.stderr.write(`seed ${seed} grew ${k} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`); }
const worlds = ['seed', ...names];
for (const w of worlds) { R.resp[w] = {}; for (const s of names) R.resp[w][s] = listen(w === 'seed' ? null : grown[w], s); }
for (const w of worlds) R.ir[w] = irSpectrum(w === 'seed' ? null : grown[w], strikePt[0], strikePt[1]);
// summary of matter: sand SD and gold mean on cracks
for (const k of names) {
  const b = new RM.Body(seed); b.setMatter(grown[k]); let g = 0, nc = 0;
  for (let c = 0; c < RM.NN; c++) { if (b.bx[c] > 0 && b.bx[c] < 0.1) { g += b.gx[c]; nc++; } if (b.by[c] > 0 && b.by[c] < 0.1) { g += b.gy[c]; nc++; } }
  let m = 0; for (const x of b.sand) m += x; m /= b.sand.length; let v = 0; for (const x of b.sand) v += (x - m) ** 2;
  R.matter[k] = { goldOnCracks: g / nc, sandSD: Math.sqrt(v / b.sand.length) };
}
R.seconds = (Date.now() - t0) / 1000;
fs.writeFileSync(`results/tuning_${seed}.json`, JSON.stringify(R));
fs.writeFileSync(`results/grown_${seed}.json`, JSON.stringify(Object.fromEntries(names.map(k => [k, { sand: Array.from(grown[k].sand), gx: Array.from(grown[k].gx), gy: Array.from(grown[k].gy) }]))));
process.stderr.write(`seed ${seed} done in ${R.seconds.toFixed(0)}s\n`);

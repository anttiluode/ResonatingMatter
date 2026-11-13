// Control for the IR distances: the same song started 0.125 s later. If a pair's IR distance is no
// bigger than this, the pair's difference is just sensitivity to timing, not a property of the song.
// Also: mechanism check for the tuning result, swapping sand vs gold between the keyC and keyFs plates.
const RM = require('./load')(), fs = require('fs');
const seed = +process.argv[2] || 2718, GROW = 90, LISTEN = 6, CH = RM.PR;
const grown = JSON.parse(fs.readFileSync(`results/grown_${seed}.json`));
const R = JSON.parse(fs.readFileSync(`results/tuning_${seed}.json`));
const f32 = a => Float32Array.from(a);
const matter = k => ({ v: 1, seed, sand: f32(grown[k].sand), gx: f32(grown[k].gx), gy: f32(grown[k].gy) });
const song = k => RM.makeSong(RM.SONGS[k], GROW + 1);
// late copy of "up"
const up = song('up'), late = new Float32Array(up.length); late.set(up.subarray(0, up.length - 3000), 3000);
const b = new RM.Body(seed); for (let t = 0; t < GROW; t++) b.run(CH, late.subarray(t * CH, (t + 1) * CH));
const strikePt = new RM.Body(seed).driver;
function bands(m) { const bb = new RM.Body(seed, { frozen: 1 }); bb.setMatter(m); const n = 16384, o = new Float32Array(2 * n); bb.strike(strikePt[0], strikePt[1], 1); bb.run(n, null, o);
  const B = 48, res = []; for (let k = 0; k < B; k++) { const f0 = 80 * Math.pow(50, k / B), f1 = 80 * Math.pow(50, (k + 1) / B); let acc = 0, c = 0;
    for (let f = f0; f < f1; f += Math.max(2, (f1 - f0) / 6)) { const w = 2 * Math.PI * f / RM.PR; let re = 0, im = 0; for (let t = 0; t < n; t++) { const x = o[2 * t] + o[2 * t + 1]; re += x * Math.cos(w * t); im += x * Math.sin(w * t); } acc += re * re + im * im; c++; }
    res.push(10 * Math.log10(acc / c + 1e-30)); } return res; }
const dist = (x, y) => Math.sqrt(x.reduce((a, v, k) => a + (v - y[k]) ** 2, 0) / x.length);
const lateIR = bands(b.getMatter());
const out = { seed, upVsUpLate_dB: +dist(lateIR, R.ir.up).toFixed(2), upVsDown_dB: +dist(R.ir.up, R.ir.down).toFixed(2) };
// mechanism: which material carries the key-pair contrast?
function listen(m, k) { const bb = new RM.Body(seed, { frozen: 1 }); bb.setMatter(m); const s = song(k), o = new Float32Array(2 * CH); let e = 0;
  for (let t = 0; t < LISTEN; t++) { bb.run(CH, s.subarray(t * CH, (t + 1) * CH), o); if (t >= 2) for (const x of o) e += x * x; } return e; }
const C = matter('keyC'), Fs = matter('keyFs');
const mix = (sandFrom, goldFrom) => ({ v: 1, seed, sand: sandFrom.sand, gx: goldFrom.gx, gy: goldFrom.gy });
const contrast = (mc, mf) => Math.log(listen(mc, 'keyC')) + Math.log(listen(mf, 'keyFs')) - Math.log(listen(mc, 'keyFs')) - Math.log(listen(mf, 'keyC'));
out.keyContrast = { full: +contrast(C, Fs).toFixed(3), sandOnly: +contrast(mix(C, Fs), mix(Fs, Fs)).toFixed(3), goldOnly: +contrast(mix(Fs, C), mix(Fs, Fs)).toFixed(3) };
// sandOnly: plates differ only in sand (both carry keyFs gold); goldOnly: differ only in gold (both carry keyFs sand)
fs.writeFileSync(`results/control_${seed}.json`, JSON.stringify(out));
console.log(JSON.stringify(out));

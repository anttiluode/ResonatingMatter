// Core checks, run against the engine exactly as shipped inside index.html.
// node tests/core.test.js   (about 2 minutes on one core)
const load = require('./load'), RM = load(), RMModes = require('../src/modes.js'), fs = require('fs'), crypto = require('crypto');
const out = []; let fails = 0;
function check(name, pass, details) { out.push({ name, pass, ...details }); if (!pass) fails++; console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`); }
const hash = b => crypto.createHash('sha1').update(Buffer.from(b.sand.buffer)).update(Buffer.from(b.gx.buffer)).update(Buffer.from(b.gy.buffer)).digest('hex').slice(0, 12);
const songs = {}; for (const k of ['low', 'high', 'keyC']) songs[k] = RM.makeSong(RM.SONGS[k], 60);
function grow(b, song, seconds, from = 0) { for (let t = 0; t < seconds; t++) b.run(RM.PR, songs[song].subarray((from + t) * RM.PR, (from + t + 1) * RM.PR)); return b; }
function ir(matter, sx, sy, P = {}) { const b = new RM.Body(matter.seed, Object.assign({ frozen: 1 }, P)); b.setMatter(matter); const n = 24000, o = new Float32Array(2 * n); b.strike(sx, sy, 10); b.run(n, null, o); return o; }
const rel = (a, b) => { let e = 0, ee = 0; for (let i = 0; i < a.length; i++) { e += (a[i] - b[i]) ** 2; ee += b[i] * b[i]; } return Math.sqrt(e / ee); };
const energy = (o, ch) => { let e = 0; for (let t = 0; t < o.length / 2; t++) e += o[2 * t + ch] ** 2; return e; };

// 0. the tested engine is the shipped engine
const shipped = fs.readFileSync(__dirname + '/../index.html', 'utf8').match(/<script id="rm-engine">\n?([\s\S]*?)<\/script>/)[1];
const src = fs.readFileSync(__dirname + '/../src/engine.js', 'utf8');
check('Engine in index.html is byte-identical to src/engine.js', load.from === 'index.html' && shipped === src, { loadedFrom: load.from, sha1: crypto.createHash('sha1').update(src).digest('hex').slice(0, 12) });

// 1. determinism
const a1 = grow(new RM.Body(2718), 'keyC', 20), a2 = grow(new RM.Body(2718), 'keyC', 20), b1 = grow(new RM.Body(2718), 'high', 20);
check('Same seed + same song gives bit-identical matter', hash(a1) === hash(a2), { a: hash(a1), b: hash(a2) });
check('Same seed + different song gives different matter', hash(a1) !== hash(b1), { keyC: hash(a1), high: hash(b1) });

// 2. conservation
const t0 = new RM.Body(2718).totalSand(), t1 = b1.totalSand();
check('Sand is conserved while it moves', Math.abs(t1 - t0) / t0 < 1e-5, { before: t0, after: t1, relErr: Math.abs(t1 - t0) / t0 });

// 3. freeze and silence
const fz = new RM.Body(2718, { frozen: 1 }); const h0 = hash(fz); grow(fz, 'high', 10);
check('Frozen matter is bit-identical after 10 s of loud song', hash(fz) === h0, { before: h0, after: hash(fz) });
const si = new RM.Body(2718); const hs = hash(si); si.run(3 * RM.PR, null);
check('A silent plate keeps every grain and every thread of gold', hash(si) === hs, { before: hs, after: hash(si) });

// 4. layer audit
const noMove = grow(new RM.Body(2718, { sandMoves: 0 }), 'high', 20), base = new RM.Body(2718);
let sandSame = true; for (let i = 0; i < base.sand.length; i++) if (base.sand[i] !== noMove.sand[i]) { sandSame = false; break; }
check('Audit: with sand moves off, no grain moves', sandSame, {});
const noGold = grow(new RM.Body(2718, { goldGrows: 0 }), 'high', 20);
check('Audit: with gold grows off, no gold appears', Math.max(...noGold.gx, ...noGold.gy) === 0, {});
const mA = a1.getMatter(), mB = b1.getMatter(), d = base.driver;
const swapGold = Object.assign({}, mA, { gx: mB.gx, gy: mB.gy }), swapSand = Object.assign({}, mA, { sand: mB.sand });
check('Audit: with "sand weighs" off, swapping the sand leaves the sound identical', rel(ir(swapSand, d[0], d[1], { sandMass: 0 }), ir(mA, d[0], d[1], { sandMass: 0 })) === 0, {});
check('Audit: with "gold joins" off, swapping the gold leaves the sound identical', rel(ir(swapGold, d[0], d[1], { goldCouples: 0 }), ir(mA, d[0], d[1], { goldCouples: 0 })) === 0, {});
check('With both on, swapping sand changes the sound', rel(ir(swapSand, d[0], d[1]), ir(mA, d[0], d[1])) > 0.05, { relDiff: rel(ir(swapSand, d[0], d[1]), ir(mA, d[0], d[1])) });
check('With both on, swapping gold changes the sound', rel(ir(swapGold, d[0], d[1]), ir(mA, d[0], d[1])) > 0.05, { relDiff: rel(ir(swapGold, d[0], d[1]), ir(mA, d[0], d[1])) });

// 5. matter to sound, and restoring
const seedM = new RM.Body(2718).getMatter(), irSeed = ir(seedM, d[0], d[1]), irGrown = ir(mB, d[0], d[1]);
check('A grown plate sounds different from the original (same strike)', rel(irGrown, irSeed) > 0.1, { relDiff: rel(irGrown, irSeed) });
const restored = ir(new RM.Body(2718).getMatter(), d[0], d[1]);
check('Restoring the original matter restores the original sound exactly', rel(restored, irSeed) === 0, {});

// 6. Moon-style compile fidelity
{ const b = new RM.Body(2718, { frozen: 1 }); b.setMatter(mB); const C = RMModes.compile(b, RM);
  const sim = ir(mB, d[0], d[1]); const b2 = new RM.Body(2718, { frozen: 1 }); b2.setMatter(mB);
  const voice = RMModes.strikeVoice(C, b2, RM, d[0], d[1], 10, 24000, C.n); const e = rel(voice, sim);
  check('Compiled modes reproduce the simulated strike (all 1024 modes)', e < 0.1, { relErr: +e.toFixed(4), compileMs: C.ms }); }

// 7. bridge cut: does the grown gold carry the strike to the far ear?
{ const g = grow(new RM.Body(2718), 'high', 60); const m = g.getMatter();
  const onBoundary0 = [], elsewhere = [];
  for (let c = 0; c < RM.NN; c++) {
    if (g.bx[c] > 0 && g.bx[c] < 0.1 && g.gx[c] > 0.05) ((g.tile[c] === 0 || g.tile[c + 1] === 0) ? onBoundary0 : elsewhere).push(['gx', c]);
    if (g.by[c] > 0 && g.by[c] < 0.1 && g.gy[c] > 0.05) ((g.tile[c] === 0 || g.tile[c + RM.N] === 0) ? onBoundary0 : elsewhere).push(['gy', c]);
  }
  const cutSet = set => { const mm = { ...m, gx: Float32Array.from(m.gx), gy: Float32Array.from(m.gy) }; for (const [k, c] of set) mm[k][c] = 0; return mm; };
  const goldOf = set => set.reduce((s, [k, c]) => s + m[k][c], 0);
  // control: cut the same number of gilded crack links away from the speaker's tile, largest first
  const ctrl = elsewhere.sort((p, q) => m[q[0]][q[1]] - m[p[0]][p[1]]).slice(0, onBoundary0.length);
  const far = mm => energy(ir(mm, d[0], d[1]), 1), farGrown = far(m), farCut = far(cutSet(onBoundary0)), farCtrl = far(cutSet(ctrl)), farSeed = far(seedM);
  const db = x => +(10 * Math.log10(x / farGrown)).toFixed(1);
  check('Cutting the gold around the speaker\'s tile silences the far ear more than an equal cut elsewhere', farCut < farCtrl,
    { linksCut: onBoundary0.length, goldCut: +goldOf(onBoundary0).toFixed(2), controlGoldCut: +goldOf(ctrl).toFixed(2), farEar_dB_vs_grown: { cutAroundSpeaker: db(farCut), controlCut: db(farCtrl), original: db(farSeed) } }); }

fs.writeFileSync(__dirname + '/../results/core.json', JSON.stringify({ date: new Date().toISOString(), engine: load.from, checks: out }, null, 1));
console.log(`\n${out.length - fails}/${out.length} passed`); process.exit(fails ? 1 : 0);

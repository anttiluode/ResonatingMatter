// ResonatingMatter engine. One source of truth: the page's AudioWorklet, the
// page's offline compare, and the Node tests all run exactly this code.
// Only + - * / and Math.sqrt / Math.min / Math.max / Math.floor / Math.abs are
// used in the simulation path, so a given input sample stream gives bit-identical
// results in any IEEE-754 JavaScript engine.
//
// THE BODY
//   A clamped square membrane, G x G interior nodes, simulated in the time
//   domain at PR physics steps per second (symplectic Euler, dt = 1 step).
//     v += [ sum_links k_l (u_nbr - u) + eta * lap(v) ] / m  -  gamma * v  + drive
//     u += v
//   The membrane is cracked into tiles (a seeded Voronoi map). Links that cross
//   a tile boundary start almost broken (k = kc << k0).
//   Sound out = velocity at two pickup nodes. Sound in = force at a driver node.
//   What you hear is the same vibration that moves the sand and grows the gold.
//
// MATTER (updated every MAT steps unless frozen)
//   sand  s (fine grid, FS x finer): grains hop where the local vibration energy
//         exceeds a threshold and settle where it does not:  ds/dt = lap(D s),
//         D = mobility(local energy). This is the Chladni mechanism: sand leaves
//         antinodes and collects on nodal lines. Mass is conserved exactly.
//         Sand loads the membrane: m = 1 + mu * S, and adds friction gamma.
//   gold  g per link (Kerrostuma's rule, re-sourced): sustained traffic through
//         a path turns into conductance. Here "traffic" is the shear energy
//         <(v_a - v_b)^2> across the link. Gold needs sand nearby as material.
//         k = kbase + kg * g. Gold across a crack mends it; gold elsewhere is a rib.
//   Sand and gold both read ACCELERATION statistics (the Chladni criterion is |a| > g).
//   Local acceleration power at any fine point is computed exactly for the
//   bilinearly interpolated velocity field from accumulated node covariances.
'use strict';

const RM = (() => {
  const PR = 24000;          // physics steps per second (independent of the sound card)
  const G = 32, N = G + 2, NN = N * N;
  const FS = 4, F = G * FS, FF = F * F;
  const MAT = 240;           // physics steps per matter update (100 Hz)

  const DEFAULTS = {
    k0: 0.2,       // intact membrane link stiffness
    kc: 0.012,     // cracked link stiffness
    kg: 0.2,       // stiffness added by full gold
    mu: 2.0,       // mass per unit sand
    g0: 2e-4,      // base damping per step
    gs: 2.5e-4,    // extra damping per unit sand (granular friction)
    eta: 0.002,    // viscous (velocity-Laplacian) loss, tames the top octave
    drive: 0.06,   // input force gain (after AGC)
    agc: 0.25,     // AGC target RMS of the input
    agcMax: 30,    // max AGC gain
    eFloor: 1.5e-7, // absolute sand hop threshold (acceleration^2): below it nothing moves
    eRel: 1.6,     // ...and grains only hop where local power exceeds eRel x the plate mean
    D0: 0.6,       // sand mobility per unit relative excess
    Dmax: 0.35,
    repose: 0.9,   // max sand difference between fine neighbours before slumping
    slump: 0.12,
    gFloor: 3e-7,  // absolute gold traffic threshold (shear acceleration^2)
    gRel: 2.0,     // ...and gold only grows where shear exceeds gRel x the plate mean power
    gRate: 4e-4,   // gold growth per matter step at unit relative traffic
    gDecay: 2e-5,  // use-dependent decay (scaled by local activity)
    gSand: 0.35,   // sand half-saturation for gold growth
    // layer audit switches
    sandMoves: 1, sandMass: 1, goldGrows: 1, goldCouples: 1, frozen: 0,
  };

  function xorshift(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  // value noise with golden-ratio octave spacing ("law of scale" seed for the sand)
  function phiNoise(seed) {
    const r = xorshift(seed * 7919 + 13), L = 64, tab = new Float32Array(L * L);
    for (let i = 0; i < L * L; i++) tab[i] = r();
    const at = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = tab[((yi & 63) * L) + (xi & 63)], b = tab[((yi & 63) * L) + ((xi + 1) & 63)];
      const c = tab[(((yi + 1) & 63) * L) + (xi & 63)], d = tab[(((yi + 1) & 63) * L) + ((xi + 1) & 63)];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy; };
    return (x, y) => { let s = 0, w = 1, f = 2, tw = 0;
      for (let o = 0; o < 5; o++) { s += w * at(x * f + o * 17.3, y * f + o * 9.1); tw += w; w /= 1.618034; f *= 1.618034; }
      return s / tw; };
  }

  class Body {
    constructor(seed = 2718, params = {}) {
      this.P = Object.assign({}, DEFAULTS, params);
      this.seed = seed;
      this.u = new Float32Array(NN); this.v = new Float32Array(NN); this.vn = new Float32Array(NN);
      this.im = new Float32Array(NN); this.gm = new Float32Array(NN); this.S = new Float32Array(NN);
      this.kx = new Float32Array(NN); this.ky = new Float32Array(NN);       // effective
      this.bx = new Float32Array(NN); this.by = new Float32Array(NN);       // base (cracks)
      this.gx = new Float32Array(NN); this.gy = new Float32Array(NN);       // gold
      this.tile = new Int16Array(NN);
      this.sand = new Float32Array(FF); this.sand2 = new Float32Array(FF); this.Dm = new Float32Array(FF);
      // accumulators: E = <v^2>, Cx = <v v_east>, Cy = <v v_south>, Cd = <v v_se>, Ca = <v_east v_south>
      this.aE = new Float32Array(NN); this.aX = new Float32Array(NN); this.aY = new Float32Array(NN);
      this.aD = new Float32Array(NN); this.aA = new Float32Array(NN); this.na = 0;
      this.E = new Float32Array(NN); this.Cx = new Float32Array(NN); this.Cy = new Float32Array(NN);
      this.Cd = new Float32Array(NN); this.Ca = new Float32Array(NN);
      this.Ef = new Float32Array(FF);
      this.step_ = 0; this.meanE = 0; this.lp1 = 0; this.lp2 = 0; this.env = this.P.agc * this.P.agc; this.lastOut = [0, 0];
      this.driver = [0, 0]; this.pick = [[0, 0], [0, 0]];
      this.seedWorld(seed);
    }
    idx(x, y) { return y * N + x; }

    seedWorld(seed) {
      const r = xorshift(seed), nz = phiNoise(seed);
      // tiles: 7 seed points, rejection-sampled for spacing
      const pts = [];
      for (let tries = 0; pts.length < 7 && tries < 4000; tries++) {
        const p = [3 + r() * (G - 5), 3 + r() * (G - 5)];
        if (pts.every(q => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 > 80)) pts.push(p);
      }
      this.tilePts = pts;
      for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) {
        const wx = x + 2.4 * (nz(x * 0.09, y * 0.09) - 0.5), wy = y + 2.4 * (nz(x * 0.09 + 5, y * 0.09 + 3) - 0.5);
        let best = 0, bd = 1e9;
        for (let t = 0; t < pts.length; t++) { const d = (pts[t][0] - wx) ** 2 + (pts[t][1] - wy) ** 2; if (d < bd) { bd = d; best = t; } }
        this.tile[this.idx(x, y)] = best;
      }
      for (let i = 0; i < NN; i++) this.tile[i] = (i % N === 0 || i % N === N - 1 || i < N || i >= NN - N) ? -1 : this.tile[i];
      const P = this.P;
      this.bx.fill(0); this.by.fill(0);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const c = this.idx(x, y);
        if (x < N - 1 && y >= 1 && y <= G) { const a = this.tile[c], b = this.tile[c + 1]; this.bx[c] = (a >= 0 && b >= 0 && a !== b) ? P.kc : P.k0; }
        if (y < N - 1 && x >= 1 && x <= G) { const a = this.tile[c], b = this.tile[c + N]; this.by[c] = (a >= 0 && b >= 0 && a !== b) ? P.kc : P.k0; }
      }
      this.gx.fill(0); this.gy.fill(0);
      for (let fy = 0; fy < F; fy++) for (let fx = 0; fx < F; fx++)
        this.sand[fy * F + fx] = 0.25 + 0.5 * nz(fx / F * 3.0 + 1.7, fy / F * 3.0 + 4.1);
      // driver near the first tile's centre, pickups at two other tiles' centres
      const at = p => [Math.max(2, Math.min(G - 1, Math.round(p[0]))), Math.max(2, Math.min(G - 1, Math.round(p[1])))];
      // left ear: a point in the driver's own tile; right ear: the centre of the farthest tile
      this.driver = at(pts[0]);
      let near = this.driver, far = at(pts[1]), bd = -1;
      for (let y = 2; y < G; y++) for (let x = 2; x < G; x++) {
        const d2 = (x - this.driver[0]) ** 2 + (y - this.driver[1]) ** 2;
        if (this.tile[this.idx(x, y)] === 0 && d2 >= 16 && d2 <= 36 && near === this.driver) near = [x, y];
      }
      for (let t = 1; t < pts.length; t++) { const p = at(pts[t]), d2 = (p[0] - this.driver[0]) ** 2 + (p[1] - this.driver[1]) ** 2; if (d2 > bd) { bd = d2; far = p; } }
      this.pick = [near, far];
      this.u.fill(0); this.v.fill(0); this.vn.fill(0);
      this.clearAcc(); this.refresh();
    }

    clearAcc() { this.aE.fill(0); this.aX.fill(0); this.aY.fill(0); this.aD.fill(0); this.aA.fill(0); this.na = 0; }

    // recompute mass, damping and stiffness from matter
    refresh() {
      const P = this.P, S = this.S, s = this.sand;
      S.fill(0);
      for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) {
        let t = 0; const fx0 = (x - 1) * FS, fy0 = (y - 1) * FS;
        for (let j = 0; j < FS; j++) for (let i = 0; i < FS; i++) t += s[(fy0 + j) * F + fx0 + i];
        S[this.idx(x, y)] = t / (FS * FS);
      }
      for (let c = 0; c < NN; c++) {
        this.im[c] = 1 / (1 + (P.sandMass ? P.mu * S[c] : 0));
        this.gm[c] = P.g0 + (P.sandMass ? P.gs * S[c] : 0);
        this.kx[c] = this.bx[c] + (P.goldCouples ? P.kg * this.gx[c] : 0);
        this.ky[c] = this.by[c] + (P.goldCouples ? P.kg * this.gy[c] : 0);
      }
    }

    // Run n physics steps. input: array-like of n samples (or null = silence).
    // out: optional Float32Array(2n) receiving interleaved L,R pickup velocity.
    run(n, input, out) {
      const P = this.P, kx = this.kx, ky = this.ky, im = this.im, gm = this.gm, eta = P.eta;
      const dI = this.idx(this.driver[0], this.driver[1]);
      const pL = this.idx(this.pick[0][0], this.pick[0][1]), pR = this.idx(this.pick[1][0], this.pick[1][1]);
      for (let t = 0; t < n; t++) {
        let u = this.u, v = this.v, vn = this.vn;
        let x = input ? input[t] : 0;
        // the "speaker": two one-pole low-passes at ~1.2 kHz (the 32-node body cannot resolve much above ~2 kHz)
        this.lp1 += 0.27 * (x - this.lp1); this.lp2 += 0.27 * (this.lp1 - this.lp2); x = this.lp2;
        // slow AGC: env time constant ~ 1.4 s
        this.env += 3e-5 * (x * x - this.env);
        let gain = P.agc / Math.sqrt(this.env + 1e-6); if (gain > P.agcMax) gain = P.agcMax;
        const f = x * gain * P.drive;
        for (let y = 1; y <= G; y++) {
          let c = y * N + 1;
          for (let xx = 1; xx <= G; xx++, c++) {
            const uc = u[c], vc = v[c];
            const fo = kx[c] * (u[c + 1] - uc) + kx[c - 1] * (u[c - 1] - uc) + ky[c] * (u[c + N] - uc) + ky[c - N] * (u[c - N] - uc);
            const lv = v[c + 1] + v[c - 1] + v[c + N] + v[c - N] - 4 * vc;
            vn[c] = vc + (fo + eta * lv) * im[c] - gm[c] * vc;
          }
        }
        // driver: 5-point footprint
        vn[dI] += f * im[dI]; vn[dI + 1] += 0.5 * f * im[dI + 1]; vn[dI - 1] += 0.5 * f * im[dI - 1];
        vn[dI + N] += 0.5 * f * im[dI + N]; vn[dI - N] += 0.5 * f * im[dI - N];
        const acc = (this.step_ & 1) === 0;
        for (let y = 1; y <= G; y++) {
          let c = y * N + 1;
          for (let xx = 1; xx <= G; xx++, c++) u[c] += vn[c];
        }
        if (acc) {
          // accumulate ACCELERATION covariances (a = vn - v): Chladni grains jump when |a| beats gravity
          const aE = this.aE, aX = this.aX, aY = this.aY, aD = this.aD, aA = this.aA;
          for (let y = 1; y <= G; y++) {
            let c = y * N + 1;
            for (let xx = 1; xx <= G; xx++, c++) {
              const w = vn[c] - v[c], we = vn[c + 1] - v[c + 1], ws = vn[c + N] - v[c + N];
              aE[c] += w * w; aX[c] += w * we; aY[c] += w * ws; aD[c] += w * (vn[c + N + 1] - v[c + N + 1]); aA[c] += we * ws;
            }
          }
          // left/top border nodes need aX/aY/aA terms into the first interior row/column: they are zero (v=0 at border)
          this.na++;
        }
        this.v = vn; this.vn = v;
        if (out) { out[2 * t] = vn[pL]; out[2 * t + 1] = vn[pR]; }
        this.step_++;
        if (this.step_ % MAT === 0) this.matter();
      }
    }

    // energy of the bilinearly interpolated velocity field at each fine cell
    fineEnergy() {
      const E = this.E, Cx = this.Cx, Cy = this.Cy, Cd = this.Cd, Ca = this.Ca, Ef = this.Ef;
      for (let fy = 0; fy < F; fy++) {
        const Y = 0.5 + (fy + 0.5) / FS, j0 = Math.floor(Y), ty = Y - j0;
        for (let fx = 0; fx < F; fx++) {
          const X = 0.5 + (fx + 0.5) / FS, i0 = Math.floor(X), tx = X - i0;
          const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
          const n00 = j0 * N + i0, n10 = n00 + 1, n01 = n00 + N, n11 = n01 + 1;
          Ef[fy * F + fx] = w00 * w00 * E[n00] + w10 * w10 * E[n10] + w01 * w01 * E[n01] + w11 * w11 * E[n11]
            + 2 * (w00 * w10 * Cx[n00] + w01 * w11 * Cx[n01] + w00 * w01 * Cy[n00] + w10 * w11 * Cy[n10]
            + w00 * w11 * Cd[n00] + w10 * w01 * Ca[n00]);
        }
      }
      return Ef;
    }

    matter() {
      const P = this.P, n = this.na || 1;
      for (let c = 0; c < NN; c++) {
        this.E[c] = this.aE[c] / n; this.Cx[c] = this.aX[c] / n; this.Cy[c] = this.aY[c] / n;
        this.Cd[c] = this.aD[c] / n; this.Ca[c] = this.aA[c] / n;
      }
      this.clearAcc();
      let m = 0; for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) m += this.E[y * N + x];
      this.meanE = m / (G * G);
      if (P.frozen) return;
      let changed = false;
      if (P.sandMoves) { this.moveSand(); changed = true; }
      if (P.goldGrows) { this.growGold(); changed = true; }
      if (changed) this.refresh();
    }

    moveSand() {
      const P = this.P, s = this.sand, s2 = this.sand2, D = this.Dm, Ef = this.fineEnergy();
      const inv = 1 / Math.max(P.eFloor, P.eRel * this.meanE);
      let any = false;
      for (let i = 0; i < FF; i++) {
        const ex = Ef[i] * inv - 1;
        const d = ex > 0 ? Math.min(P.Dmax, P.D0 * ex) : 0;
        D[i] = d; if (d > 0) any = true;
      }
      // a still body keeps every grain exactly where it is
      if (!any) return;
      // hop diffusion  ds_i = 1/4 sum_j (D_j s_j - D_i s_i), reflecting edges
      for (let y = 0; y < F; y++) for (let x = 0; x < F; x++) {
        const i = y * F + x, out = D[i] * s[i];
        let acc = 0;
        if (x > 0) acc += D[i - 1] * s[i - 1] - out;
        if (x < F - 1) acc += D[i + 1] * s[i + 1] - out;
        if (y > 0) acc += D[i - F] * s[i - F] - out;
        if (y < F - 1) acc += D[i + F] * s[i + F] - out;
        s2[i] = s[i] + 0.25 * acc;
      }
      // slumping: piles steeper than repose spill to the lower neighbour (only where grains are agitated)
      s.set(s2);
      for (let y = 0; y < F; y++) for (let x = 0; x < F - 1; x++) {
        const i = y * F + x;
        if (D[i] === 0 && D[i + 1] === 0) continue;
        const d = s[i] - s[i + 1];
        if (d > P.repose) { const m = P.slump * (d - P.repose); s[i] -= m; s[i + 1] += m; }
        else if (-d > P.repose) { const m = P.slump * (-d - P.repose); s[i] += m; s[i + 1] -= m; }
      }
      for (let y = 0; y < F - 1; y++) for (let x = 0; x < F; x++) {
        const i = y * F + x;
        if (D[i] === 0 && D[i + F] === 0) continue;
        const d = s[i] - s[i + F];
        if (d > P.repose) { const m = P.slump * (d - P.repose); s[i] -= m; s[i + F] += m; }
        else if (-d > P.repose) { const m = P.slump * (-d - P.repose); s[i] += m; s[i + F] -= m; }
      }
    }

    growGold() {
      const P = this.P, E = this.E, S = this.S, th = Math.max(P.gFloor, P.gRel * this.meanE), inv = 1 / th;
      const grow = (g, a, b, C) => {
        const shear = E[a] + E[b] - 2 * C;
        const r = shear * inv - 1;
        const sa = 0.5 * (S[a] + S[b]), mat = sa / (sa + P.gSand);
        let gn = g;
        if (r > 0) gn += P.gRate * Math.min(r, 4) * mat * (1 - g);
        gn -= P.gDecay * g * Math.min(4, (E[a] + E[b]) * 0.5 * inv);
        return gn < 0 ? 0 : (gn > 1 ? 1 : gn);
      };
      for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) {
        const c = y * N + x;
        if (x < G) this.gx[c] = grow(this.gx[c], c, c + 1, this.Cx[c]);
        if (y < G) this.gy[c] = grow(this.gy[c], c, c + N, this.Cy[c]);
      }
    }

    // ---- interventions -------------------------------------------------
    strike(x, y, amp = 1) {   // x,y in node coordinates (1..G)
      const xi = Math.round(x), yi = Math.round(y);
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
        const X = xi + i, Y = yi + j; if (X < 1 || X > G || Y < 1 || Y > G) continue;
        const w = Math.max(0, 1 - Math.sqrt(i * i + j * j) / 2.5);
        const c = Y * N + X; this.v[c] += amp * 0.05 * w * w * this.im[c];
      }
    }
    cut(x, y, r = 1.6) {     // removes gold within r nodes (both link families)
      for (let yy = 1; yy <= G; yy++) for (let xx = 1; xx <= G; xx++) {
        const c = yy * N + xx;
        if ((xx + 0.5 - x) ** 2 + (yy - y) ** 2 < r * r) this.gx[c] = 0;
        if ((xx - x) ** 2 + (yy + 0.5 - y) ** 2 < r * r) this.gy[c] = 0;
      }
      this.refresh();
    }
    rake(x, y, dx, dy, r = 2.2) {  // push sand along the drag, conservatively
      const fx = (x - 0.5) * FS, fy = (y - 0.5) * FS, R = r * FS, len = Math.hypot(dx, dy);
      if (len < 1e-6) return;
      const ox = Math.round(dx / len), oy = Math.round(dy / len), s = this.sand;
      for (let j = Math.max(0, Math.floor(fy - R)); j <= Math.min(F - 1, Math.ceil(fy + R)); j++)
        for (let i = Math.max(0, Math.floor(fx - R)); i <= Math.min(F - 1, Math.ceil(fx + R)); i++) {
          const d2 = (i + 0.5 - fx) ** 2 + (j + 0.5 - fy) ** 2; if (d2 > R * R) continue;
          const ti = i + ox * 2, tj = j + oy * 2; if (ti < 0 || ti >= F || tj < 0 || tj >= F) continue;
          const m = s[j * F + i] * 0.35 * (1 - d2 / (R * R)); s[j * F + i] -= m; s[tj * F + ti] += m;
        }
      this.refresh();
    }
    silence() { this.u.fill(0); this.v.fill(0); this.vn.fill(0); this.clearAcc(); }

    // ---- state ---------------------------------------------------------
    getMatter() {
      return { v: 1, seed: this.seed, sand: Float32Array.from(this.sand), gx: Float32Array.from(this.gx), gy: Float32Array.from(this.gy),
        driver: this.driver.slice(), pick: this.pick.map(p => p.slice()) };
    }
    setMatter(m) {
      if (m.seed !== this.seed) this.seedWorld(m.seed);
      this.sand.set(m.sand); this.gx.set(m.gx); this.gy.set(m.gy);
      if (m.driver) this.driver = m.driver.slice(); if (m.pick) this.pick = m.pick.map(p => p.slice());
      this.refresh();
    }
    totalSand() { let t = 0; for (let i = 0; i < FF; i++) t += this.sand[i]; return t; }
  }

  // ---- deterministic test songs (used by the page's demo and by the tests) ----
  // spec: {notes:[Hz...], beat: seconds per note, pattern:[indices], decay, bright, seed}
  function makeSong(spec, seconds, rate = PR) {
    const n = Math.floor(seconds * rate), out = new Float32Array(n);
    const pat = spec.pattern || spec.notes.map((_, i) => i), beat = spec.beat || 0.25;
    const per = Math.floor(beat * rate), dec = spec.decay || 0.35, harm = spec.harmonics || [1, 0.5, 0.25];
    for (let k = 0; k * per < n; k++) {
      const step = pat[k % pat.length]; if (step < 0) continue;
      const chord = Array.isArray(step) ? step : [step];
      for (const ni of chord) {
        const f0 = spec.notes[ni];
        for (let h = 0; h < harm.length; h++) {
          const f = f0 * (h + 1); if (f > rate * 0.45) continue;
          const w = 2 * Math.PI * f / rate, a = harm[h] / chord.length, len = Math.min(n - k * per, Math.floor(rate * dec * 4));
          for (let t = 0; t < len; t++) out[k * per + t] += a * Math.sin(w * t) * Math.exp(-t / (dec * rate)) * Math.min(1, t / 40);
        }
      }
    }
    let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] *= 0.7 / (pk || 1);
    return out;
  }

  // The eight test songs: four pairs, each pair differs in one property.
  const LOWC = [131, 165, 196, 247, 262, 330], HIGHC = LOWC.map(f => f * 4), MIDC = LOWC.map(f => f * 2);
  const MIDF = [370, 466, 554, 698, 740, 932];
  const STRAIGHT = [0, 2, 4, 1, 3, 5, [0, 2], -1], BROKEN = [0, -1, 2, 4, -1, -1, 1, 3, 5, -1, [0, 2], -1];
  const SONGS = {
    low:      { pair: 'register', notes: LOWC,  pattern: STRAIGHT, beat: 0.3, decay: 0.5 },
    high:     { pair: 'register', notes: HIGHC, pattern: STRAIGHT, beat: 0.3, decay: 0.5 },
    keyC:     { pair: 'key',      notes: MIDC,  pattern: STRAIGHT, beat: 0.3, decay: 0.5 },
    keyFs:    { pair: 'key',      notes: MIDF,  pattern: STRAIGHT, beat: 0.3, decay: 0.5 },
    straight: { pair: 'rhythm',   notes: MIDC,  pattern: [0, 1, 2, 3, 4, 5, 4, 2], beat: 0.25, decay: 0.4 },
    broken:   { pair: 'rhythm',   notes: MIDC,  pattern: BROKEN.map(i => (i === -1 ? -1 : i)), beat: 0.2, decay: 0.4 },
    up:       { pair: 'order',    notes: MIDC,  pattern: [0, 1, 2, 3, 4, 5], beat: 0.25, decay: 0.4 },
    down:     { pair: 'order',    notes: MIDC,  pattern: [5, 4, 3, 2, 1, 0], beat: 0.25, decay: 0.4 },
  };

  return { Body, makeSong, SONGS, PR, G, N, NN, F, FS, MAT, DEFAULTS, xorshift };
})();
if (typeof module !== 'undefined') module.exports = RM;

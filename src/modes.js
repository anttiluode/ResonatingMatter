// Moon-style compile: turn the body's current matter into its vibration modes.
// Slow part (once per matter state): K and M from sand and gold, eigen-decomposition
//   A = M^-1/2 K M^-1/2,  A psi = lambda psi.
// Fast part (per sound): every mode is an independent two-line recursion.
// The time stepper is symplectic Euler with dt = 1, so a mode with eigenvalue lambda
// rings at exactly cos(theta) = 1 - lambda/2 (theta in radians per physics step):
// the compiled voice is not an approximation of the stepper's pitch, only of its damping.
'use strict';
const RMModes = (() => {
  // JAMA-style Householder tridiagonalisation + implicit QL, on a dense symmetric matrix.
  // V: Float64Array(n*n) row-major, overwritten with eigenvectors (columns). d: eigenvalues ascending.
  function symEig(V, n) {
    const d = new Float64Array(n), e = new Float64Array(n);
    for (let j = 0; j < n; j++) d[j] = V[(n - 1) * n + j];
    for (let i = n - 1; i > 0; i--) {
      let scale = 0, h = 0;
      for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
      if (scale === 0) {
        e[i] = d[i - 1];
        for (let j = 0; j < i; j++) { d[j] = V[(i - 1) * n + j]; V[i * n + j] = 0; V[j * n + i] = 0; }
      } else {
        for (let k = 0; k < i; k++) { d[k] /= scale; h += d[k] * d[k]; }
        let f = d[i - 1], g = Math.sqrt(h);
        if (f > 0) g = -g;
        e[i] = scale * g; h -= f * g; d[i - 1] = f - g;
        for (let j = 0; j < i; j++) e[j] = 0;
        for (let j = 0; j < i; j++) {
          f = d[j]; V[j * n + i] = f; g = e[j] + V[j * n + j] * f;
          for (let k = j + 1; k <= i - 1; k++) { g += V[k * n + j] * d[k]; e[k] += V[k * n + j] * f; }
          e[j] = g;
        }
        f = 0;
        for (let j = 0; j < i; j++) { e[j] /= h; f += e[j] * d[j]; }
        const hh = f / (h + h);
        for (let j = 0; j < i; j++) e[j] -= hh * d[j];
        for (let j = 0; j < i; j++) {
          f = d[j]; g = e[j];
          for (let k = j; k <= i - 1; k++) V[k * n + j] -= (f * e[k] + g * d[k]);
          d[j] = V[(i - 1) * n + j]; V[i * n + j] = 0;
        }
      }
      d[i] = h;
    }
    for (let i = 0; i < n - 1; i++) {
      V[(n - 1) * n + i] = V[i * n + i]; V[i * n + i] = 1;
      const h = d[i + 1];
      if (h !== 0) {
        for (let k = 0; k <= i; k++) d[k] = V[k * n + i + 1] / h;
        for (let j = 0; j <= i; j++) {
          let g = 0;
          for (let k = 0; k <= i; k++) g += V[k * n + i + 1] * V[k * n + j];
          for (let k = 0; k <= i; k++) V[k * n + j] -= g * d[k];
        }
      }
      for (let k = 0; k <= i; k++) V[k * n + i + 1] = 0;
    }
    for (let j = 0; j < n; j++) { d[j] = V[(n - 1) * n + j]; V[(n - 1) * n + j] = 0; }
    V[(n - 1) * n + n - 1] = 1; e[0] = 0;
    // tql2
    for (let i = 1; i < n; i++) e[i - 1] = e[i];
    e[n - 1] = 0;
    let f = 0, tst1 = 0; const eps = Math.pow(2, -52);
    for (let l = 0; l < n; l++) {
      tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
      let m = l; while (m < n) { if (Math.abs(e[m]) <= eps * tst1) break; m++; }
      if (m > l) {
        do {
          let g = d[l], p = (d[l + 1] - g) / (2 * e[l]), r = Math.hypot(p, 1);
          if (p < 0) r = -r;
          d[l] = e[l] / (p + r); d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1]; let h = g - d[l];
          for (let i = l + 2; i < n; i++) d[i] -= h;
          f += h;
          p = d[m]; let c = 1, c2 = c, c3 = c; const el1 = e[l + 1]; let s = 0, s2 = 0;
          for (let i = m - 1; i >= l; i--) {
            c3 = c2; c2 = c; s2 = s; g = c * e[i]; h = c * p; r = Math.hypot(p, e[i]);
            e[i + 1] = s * r; s = e[i] / r; c = p / r; p = c * d[i] - s * g; d[i + 1] = h + s * (c * g + s * d[i]);
            for (let k = 0; k < n; k++) { h = V[k * n + i + 1]; V[k * n + i + 1] = s * V[k * n + i] + c * h; V[k * n + i] = c * V[k * n + i] - s * h; }
          }
          p = -s * s2 * c3 * el1 * e[l] / dl1; e[l] = s * p; d[l] = c * p;
        } while (Math.abs(e[l]) > eps * tst1);
      }
      d[l] = d[l] + f; e[l] = 0;
    }
    // sort ascending
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[a] - d[b]);
    const d2 = new Float64Array(n), V2 = new Float64Array(n * n);
    order.forEach((o, j) => { d2[j] = d[o]; for (let k = 0; k < n; k++) V2[k * n + j] = V[k * n + o]; });
    return { d: d2, V: V2 };
  }

  // Build the mass-normalised operator from a Body (any object with the Body's arrays).
  function compile(body, RM) {
    const G = RM.G, N = RM.N, n = G * G, A = new Float64Array(n * n);
    const id = (x, y) => (y - 1) * G + (x - 1), node = (x, y) => y * N + x;
    const sm = new Float64Array(n); // M^-1/2 = sqrt(im)
    for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) sm[id(x, y)] = Math.sqrt(body.im[node(x, y)]);
    for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) {
      const c = node(x, y), i = id(x, y);
      const ks = [[body.kx[c], x + 1, y], [body.kx[c - 1], x - 1, y], [body.ky[c], x, y + 1], [body.ky[c - N], x, y - 1]];
      let diag = 0;
      for (const [k, X, Y] of ks) {
        diag += k;
        if (X >= 1 && X <= G && Y >= 1 && Y <= G) A[i * n + id(X, Y)] -= k * sm[i] * sm[id(X, Y)];
      }
      A[i * n + i] += diag * sm[i] * sm[i];
    }
    const t0 = Date.now();
    const { d, V } = symEig(A, n);
    const ms = Date.now() - t0;
    // modal damping: psi^T (Gamma - eta M^-1/2 L M^-1/2) psi  (L = 5-point Laplacian, Dirichlet)
    const damp = new Float64Array(n), eta = body.P.eta;
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let y = 1; y <= G; y++) for (let x = 1; x <= G; x++) {
        const i = id(x, y), p = V[i * n + j] * sm[i];
        let lap = -4 * p;
        if (x > 1) lap += V[id(x - 1, y) * n + j] * sm[id(x - 1, y)];
        if (x < G) lap += V[id(x + 1, y) * n + j] * sm[id(x + 1, y)];
        if (y > 1) lap += V[id(x, y - 1) * n + j] * sm[id(x, y - 1)];
        if (y < G) lap += V[id(x, y + 1) * n + j] * sm[id(x, y + 1)];
        s += V[i * n + j] * (body.gm[node(x, y)] * V[i * n + j] - eta * sm[i] * lap);
      }
      damp[j] = s;
    }
    return { n, lambda: d, V, sm, damp, ms, G, N };
  }
  const theta = lam => Math.acos(Math.max(-1, Math.min(1, 1 - lam / 2)));   // rad per physics step

  // Compiled voice of a strike: same footprint and units as Body.strike, read at both pickups.
  function strikeVoice(C, body, RM, sx, sy, amp, steps, K) {
    const G = C.G, N = C.N, n = C.n, id = (x, y) => (y - 1) * G + (x - 1);
    K = Math.min(K || n, n);
    const dv = new Float64Array(n), xi = Math.round(sx), yi = Math.round(sy);
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const X = xi + i, Y = yi + j; if (X < 1 || X > G || Y < 1 || Y > G) continue;
      const w = Math.max(0, 1 - Math.sqrt(i * i + j * j) / 2.5);
      dv[id(X, Y)] = amp * 0.05 * w * w * body.im[Y * N + X];
    }
    const pL = id(body.pick[0][0], body.pick[0][1]), pR = id(body.pick[1][0], body.pick[1][1]);
    const out = new Float32Array(2 * steps);
    for (let m = 0; m < K; m++) {
      let w0 = 0; for (let i = 0; i < n; i++) w0 += C.V[i * n + m] * dv[i] / C.sm[i];   // psi^T M^1/2 dv
      if (w0 === 0) continue;
      const lam = C.lambda[m], dm = C.damp[m];
      const gL = C.V[pL * n + m] * C.sm[pL], gR = C.V[pR * n + m] * C.sm[pR];
      let q = 0, v = w0;
      // engine order: strike adds to v before the next step; the step then updates v then q
      for (let t = 0; t < steps; t++) {
        v = v - lam * q - dm * v; q = q + v;
        out[2 * t] += v * gL; out[2 * t + 1] += v * gR;
      }
    }
    return out;
  }
  return { symEig, compile, strikeVoice, theta };
})();
if (typeof module !== 'undefined') module.exports = RMModes;

// Loads the engine exactly as shipped: from index.html's <script id="rm-engine"> when it exists.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
function load() {
  const html = path.join(root, 'index.html');
  let src;
  if (fs.existsSync(html)) {
    const m = fs.readFileSync(html, 'utf8').match(/<script id="rm-engine">([\s\S]*?)<\/script>/);
    if (!m) throw Error('rm-engine block not found in index.html');
    src = m[1]; load.from = 'index.html';
  } else { src = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8'); load.from = 'src/engine.js'; }
  return new Function(src.replace(/if \(typeof module[^\n]*/, '') + '\nreturn RM;')();
}
module.exports = load;

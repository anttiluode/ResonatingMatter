// Builds the single self-contained index.html from src/page.html + src/engine.js + src/modes.js.
const fs = require('fs'), path = require('path'), r = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let html = r('src/page.html');
html = html.replace('<script id="rm-engine"></script>', () => '<script id="rm-engine">\n' + r('src/engine.js') + '</script>');
html = html.replace('<script id="rm-modes"></script>', () => '<script id="rm-modes">\n' + r('src/modes.js') + '</script>');
fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
console.log('index.html', html.length, 'bytes');

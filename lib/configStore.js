const fs = require('fs');
const path = require('path');
const CFG_DIR = path.join(__dirname, '..', 'config');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(CFG_DIR, `${name}.json`), 'utf8'));
}
function save(name, data) {
  fs.writeFileSync(path.join(CFG_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
  return true;
}
module.exports = {
  load, save,
  prompts: () => load('prompts'),
  pricing: () => load('pricing'),
};

const fs = require('fs');
const path = require('path');
const indexPath = path.join(__dirname, '..', 'public', 'index.html');
const viewsPath = path.join(__dirname, '..', 'views.json');

if (!fs.existsSync(indexPath)) {
  console.error('index.html not found');
  process.exit(1);
}
const html = fs.readFileSync(indexPath, 'utf8');
// find all data-id values in .image-container blocks
const ids = Array.from(html.matchAll(/data-id=["']([^"']+)["']/g)).map(m => m[1]);

let views = {};
if (fs.existsSync(viewsPath)) {
  try {
    views = JSON.parse(fs.readFileSync(viewsPath, 'utf8'));
  } catch (e) {
    // try to clean comments/trailing commas
    const txt = fs.readFileSync(viewsPath, 'utf8').replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
    try { views = JSON.parse(txt); } catch { views = {}; }
  }
}

// Add missing ids and remove extra ids not present in index.html
let added = 0;
let removed = 0;

// Add missing ids from index -> views
ids.forEach(id => {
  if (!views[id]) {
    views[id] = { views: 0, hearts: 0, usersHearted: [] };
    added++;
  } else {
    // normalize existing entries
    views[id].views = Number.isFinite(views[id].views) ? views[id].views : 0;
    views[id].hearts = Number.isFinite(views[id].hearts) ? views[id].hearts : 0;
    views[id].usersHearted = Array.isArray(views[id].usersHearted) ? views[id].usersHearted : [];
  }
});

// Remove entries present in views.json but not in index.html
Object.keys(views).forEach(id => {
  if (!ids.includes(id)) {
    delete views[id];
    removed++;
  }
});

fs.writeFileSync(viewsPath, JSON.stringify(views, null, 2), 'utf8');
console.log(`done. ids scanned: ${ids.length}. added: ${added}. removed: ${removed}. views.json updated: ${viewsPath}`);
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const indexPath = path.join(__dirname, '..', 'public', 'index.html');
const viewsPath = path.join(__dirname, '..', 'views.json');

function checkUrl(url, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        {
          method: 'GET',
          hostname: u.hostname,
          path: u.pathname + (u.search || ''),
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          headers: { 'User-Agent': 'image-checker' },
          timeout
        },
        (res) => {
          const ct = (res.headers['content-type'] || '').toLowerCase();
          const ok = res.statusCode >= 200 && res.statusCode < 300 && ct.startsWith('image');
          // consume a little then abort to avoid full download
          res.once('data', () => req.destroy());
          resolve({ ok, status: res.statusCode, contentType: ct });
        }
      );
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end();
    } catch (e) {
      resolve({ ok: false });
    }
  });
}

// extract image-container blocks robustly by scanning HTML and matching nested <div> / </div>
function extractImageContainers(html) {
  const blocks = [];
  let idx = 0;
  while (true) {
    const openIdx = html.indexOf('<div', idx);
    if (openIdx === -1) break;
    const tagEnd = html.indexOf('>', openIdx);
    if (tagEnd === -1) break;
    const openTag = html.slice(openIdx, tagEnd + 1);
    // ensure this div has class "image-container" and a data-id
    if (!/class\s*=\s*["'][^"']*\bimage-container\b[^"']*["']/i.test(openTag) ||
        !/data-id\s*=\s*["']([^"']+)["']/i.test(openTag)) {
      idx = tagEnd + 1;
      continue;
    }
    // find matching closing </div> at same nesting level
    let searchPos = tagEnd + 1;
    let depth = 1;
    const re = /<div\b|<\/div>/ig;
    re.lastIndex = searchPos;
    let match;
    while ((match = re.exec(html)) !== null) {
      if (match[0].toLowerCase().startsWith('<div')) depth++;
      else depth--;
      if (depth === 0) {
        const closeIdx = re.lastIndex;
        const block = html.slice(openIdx, closeIdx);
        blocks.push(block);
        idx = closeIdx;
        break;
      }
    }
    if (match === null) break; // unmatched; stop
  }
  return blocks;
}

// Try to parse JSON even if file contains // comments or trailing commas
function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    // remove // comments and trailing commas heuristically
    const noComments = text.replace(/\/\/.*$/gm, '');
    const noTrailing = noComments.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(noTrailing);
    } catch {
      return {};
    }
  }
}

(async function main() {
  if (!fs.existsSync(indexPath)) {
    console.error('index.html not found:', indexPath);
    process.exit(1);
  }
  const html = fs.readFileSync(indexPath, 'utf8');

  // find gallery section
  const galleryRe = /(<section[^>]*class=["']gallery["'][^>]*>)([\s\S]*?)(<\/section>)/i;
  const galleryMatch = html.match(galleryRe);
  if (!galleryMatch) {
    console.error('Gallery section not found in index.html');
    process.exit(1);
  }
  const galleryOpen = galleryMatch[1];
  const galleryContent = galleryMatch[2];
  const galleryClose = galleryMatch[3];

  const blocks = extractImageContainers(galleryContent);
  if (!blocks.length) {
    console.log('No .image-container blocks found.');
    return;
  }

  const results = [];
  const seenIds = new Set();
  const seenSrcs = new Set();

  for (const block of blocks) {
    const idMatch = block.match(/data-id=["']([^"']+)["']/i);
    const srcMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    const id = idMatch ? idMatch[1] : '(no-id)';
    const src = srcMatch ? srcMatch[1] : null;

    // drop duplicates: same data-id OR same src (keep first seen)
    if (seenIds.has(id)) {
      console.log(`Skipping duplicate id ${id}`);
      results.push({ id, src, ok: false, reason: 'duplicate-id', block });
      continue;
    }
    if (src && seenSrcs.has(src)) {
      console.log(`Skipping duplicate src for ${id} -> ${src}`);
      // still mark id as seen so any further repeated id is caught
      seenIds.add(id);
      results.push({ id, src, ok: false, reason: 'duplicate-src', block });
      continue;
    }

    // mark seen (we mark id even if no-src to avoid multiple no-src duplicates)
    seenIds.add(id);
    if (src) seenSrcs.add(src);

    if (!src) {
      results.push({ id, src: null, ok: false, reason: 'no-src', block });
      continue;
    }

    process.stdout.write(`Checking ${id} -> ${src} ... `);
    if (!/^https?:\/\//i.test(src)) {
      console.log('kept (local/relative)');
      results.push({ id, src, ok: true, reason: 'local', block });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const r = await checkUrl(src);
    if (r.ok) {
      console.log(`ok (${r.status}, ${r.contentType})`);
      results.push({ id, src, ok: true, reason: 'reachable', block });
    } else {
      console.log('FAILED');
      results.push({ id, src, ok: false, reason: 'unreachable', block });
    }
  }

  // previous `results` collected above

  // normalize src for de-duplication
  function normalizeSrc(src) {
    if (!src) return src;
    try {
      const u = new URL(src);
      u.search = '';
      const href = u.href.replace(/\/$/, '');
      return href.toLowerCase();
    } catch {
      return src.replace(/\?.*$/, '').replace(/\/$/, '').toLowerCase();
    }
  }

  // build final kept list, dropping duplicates (same data-id or same normalized src)
  const seenFinalIds = new Set();
  const seenFinalSrcs = new Set();
  const kept = [];
  const removed = [];

  for (const r of results) {
    const id = r.id;
    const src = r.src || '';
    const norm = normalizeSrc(src);

    if (!r.ok) {
      removed.push({ id, src, reason: r.reason });
      // still mark id so further duplicates of the same id are considered duplicates
      seenFinalIds.add(id);
      if (norm) seenFinalSrcs.add(norm);
      continue;
    }

    if (seenFinalIds.has(id)) {
      console.log(`Removing duplicate (id) ${id}`);
      removed.push({ id, src, reason: 'duplicate-id' });
      continue;
    }
    if (norm && seenFinalSrcs.has(norm)) {
      console.log(`Removing duplicate (src) ${id} -> ${src}`);
      removed.push({ id, src, reason: 'duplicate-src' });
      // mark id so further duplicates of same id are also removed
      seenFinalIds.add(id);
      continue;
    }

    // keep this block
    kept.push(r.block);
    seenFinalIds.add(id);
    if (norm) seenFinalSrcs.add(norm);
   }
    console.log(`\nKept ${kept.length}, removed ${removed.length} image blocks.`);
    if (removed.length) {
      console.log('Removed items:');
        for (const rem of removed) {
            console.log(` - ${rem.id} (${rem.reason}) ${rem.src || ''}`);
        }
    }
    // rebuild gallery section
    const newGalleryContent = '\n' + kept.join('\n') + '\n';
    const newHtml = html.slice(0, galleryMatch.index) +
        galleryOpen + newGalleryContent + galleryClose +
        html.slice(galleryMatch.index + galleryMatch[0].length);
    fs.writeFileSync(indexPath, newHtml, 'utf8');
    console.log(`\nUpdated index.html written to ${indexPath}`);
    // update views.json to keep only kept ids
    if (fs.existsSync(viewsPath)) {
      const viewsText = fs.readFileSync(viewsPath, 'utf8');
      const viewsData = safeParseJSON(viewsText);
      const newViews = {}; // only keep entries for kept ids
        for (const id of seenFinalIds) {
            if (viewsData[id]) newViews[id] = viewsData[id];
        }
        fs.writeFileSync(viewsPath, JSON.stringify(newViews, null, 2) + '\n', 'utf8');
        console.log(`Updated views.json written to ${viewsPath}`);
    } else {
        console.log('views.json not found, skipping update.');
    }
}());
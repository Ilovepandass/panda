const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 80;

const viewsFile = path.join(__dirname, 'views.json');
const usersFile = path.join(__dirname, 'users.json');
let data = {};
let users = {};

// Load data from file if exists
if (fs.existsSync(viewsFile)) {
  try {
    data = JSON.parse(fs.readFileSync(viewsFile));
    // Convert usersHearted arrays back to Sets for runtime use
    for (const id in data) {
      if (Array.isArray(data[id].usersHearted)) {
        data[id].usersHearted = new Set(data[id].usersHearted);
      } else if (!(data[id].usersHearted instanceof Set)) {
        data[id].usersHearted = new Set();
      }
      // Ensure views and hearts are numbers
      data[id].views = Number(data[id].views) || 0;
      data[id].hearts = Number(data[id].hearts) || 0;
    }
  } catch (err) {
    console.error('Error parsing views.json:', err);
    data = {};
  }
}

// Load users from file
if (fs.existsSync(usersFile)) {
  try {
    users = JSON.parse(fs.readFileSync(usersFile));
  } catch (err) {
    console.error('Error parsing users.json:', err);
    users = {};
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Middleware to get userId from header or fallback
app.use((req, res, next) => {
  req.userId = req.header('X-User-Id') || 'guest';
  next();
});

// Save data helper (convert Sets to arrays for JSON)
function saveData() {
  const toSave = {};
  for (const id in data) {
    toSave[id] = {
      views: data[id].views,
      hearts: data[id].hearts,
      usersHearted: Array.from(data[id].usersHearted),
    };
  }
  fs.writeFileSync(viewsFile, JSON.stringify(toSave, null, 2));
}

// Simple helper to save users
function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// Register endpoint
app.post('/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'Missing username, email, or password' });
  if (users[username]) return res.status(409).json({ error: 'Username taken' });
  users[username] = { email, password, viewed: [], hearted: [] };
  saveUsers();
  res.json({ success: true });
});

// Login endpoint
app.post('/login', (req, res) => {
  const { username, email, password } = req.body;
  if (!users[username] || users[username].password !== password || users[username].email !== email) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ success: true, userId: username });
});

// Middleware: require userId for view/heart
function requireUser(req, res, next) {
  const userId = req.header('X-User-Id');
  if (!userId || !users[userId]) return res.status(401).json({ error: 'Login required' });
  req.userId = userId;
  req.user = users[userId];
  next();
}

// Serve a JSON representation of the views/hearts file so the client can fetch('/views.json')
app.get('/views.json', (req, res) => {
  const out = {};
  for (const id in data) {
    out[id] = {
      views: typeof data[id].views === 'number' ? data[id].views : 0,
      hearts: typeof data[id].hearts === 'number' ? data[id].hearts : 0,
      usersHearted: Array.from(data[id].usersHearted || [])
    };
  }
  res.json(out);
});

// Get data for specific panda (optional user header to indicate whether this user has hearted/viewed)
app.get('/data/:id', (req, res) => {
  const id = req.params.id;
  if (!data[id]) data[id] = { views: 0, hearts: 0, usersHearted: new Set() };
  if (Array.isArray(data[id].usersHearted)) data[id].usersHearted = new Set(data[id].usersHearted);
  const userId = req.header('X-User-Id');
  res.json({
    views: data[id].views || 0,
    hearts: data[id].hearts || 0,
    userHasHearted: userId ? data[id].usersHearted.has(userId) : false,
    userHasViewed: userId ? (users[userId] && users[userId].viewed.includes(id)) : false
  });
});

// Increment view (body: { id: 'panda1' }). Works for anonymous users and signed-in users.
// If signed-in, only counts once per user (tracked in users[user].viewed). Anonymous increments always.
app.post('/view', (req, res) => {
  const id = (req.body && req.body.id) || req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  if (!data[id]) data[id] = { views: 0, hearts: 0, usersHearted: new Set() };
  if (Array.isArray(data[id].usersHearted)) data[id].usersHearted = new Set(data[id].usersHearted);

  const userId = req.header('X-User-Id');
  if (userId && users[userId]) {
    // only count first view per user
    if (!users[userId].viewed.includes(id)) {
      data[id].views = (data[id].views || 0) + 1;
      users[userId].viewed.push(id);
      saveUsers();
      saveData();
    }
  } else {
    // anonymous: always increment (can't dedupe)
    data[id].views = (data[id].views || 0) + 1;
    saveData();
  }

  res.json({
    views: data[id].views || 0,
    hearts: data[id].hearts || 0,
    userHasHearted: userId ? data[id].usersHearted.has(userId) : false,
    userHasViewed: userId ? users[userId] && users[userId].viewed.includes(id) : false
  });
});

// Toggle heart (body: { id: 'panda1' }). Requires X-User-Id header that maps to a real user.
app.post('/heart', (req, res) => {
  const id = (req.body && req.body.id) || req.query.id;
  const userId = req.header('X-User-Id');
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (!userId || !users[userId]) return res.status(401).json({ error: 'Login required' });

  if (!data[id]) data[id] = { views: 0, hearts: 0, usersHearted: new Set() };
  if (Array.isArray(data[id].usersHearted)) data[id].usersHearted = new Set(data[id].usersHearted);

  const usersSet = data[id].usersHearted;
  const has = usersSet.has(userId);
  if (has) {
    usersSet.delete(userId);
    // remove from user's hearted list
    users[userId].hearted = (users[userId].hearted || []).filter(x => x !== id);
  } else {
    usersSet.add(userId);
    users[userId].hearted = Array.from(new Set([...(users[userId].hearted || []), id]));
  }

  data[id].hearts = usersSet.size;
  saveUsers();
  saveData();

  res.json({
    views: data[id].views || 0,
    hearts: data[id].hearts || 0,
    userHasHearted: usersSet.has(userId)
  });
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});

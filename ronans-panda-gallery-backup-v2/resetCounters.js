const fs = require('fs');
const path = require('path');

const viewsFile = path.join(__dirname, 'views.json');

// Default panda IDs
const pandaIds = ['panda1', 'panda2', 'panda3', 'panda4', 'panda5'];

// Create default counters for each panda
const defaultCounters = {};
pandaIds.forEach(id => {
  defaultCounters[id] = { views: 0, hearts: 0, usersHearted: [] };
});

try {
  fs.writeFileSync(viewsFile, JSON.stringify(defaultCounters, null, 2), 'utf-8');
  console.log('✅ views.json counters have been reset for all pandas.');
} catch (error) {
  console.error('❌ Error resetting views.json:', error);
}

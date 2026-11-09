/**
 * Saves the project, its lists and team in the database from config/project.json,
 * then asks the running API to import the board's existing cards.
 *   npm run setup:project
 * The API must be running (npm run start:dev). Safe to run again.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const configPath = path.resolve(process.argv[2] || 'config/project.json');
const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing in .env`);
  return v;
};

async function trello(pathname, params = {}) {
  const url = new URL(`https://api.trello.com/1${pathname}`);
  url.searchParams.set('key', env('TRELLO_API_KEY'));
  url.searchParams.set('token', env('TRELLO_TOKEN'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello ${pathname} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const prisma = new PrismaClient();

  try {
    // 1. Board: accepts the full ID or the short code from the board address
    const board = await trello(`/boards/${cfg.project.trelloBoard}`, { fields: 'id,name' });
    console.log(`✔ Trello board: ${board.name} (${board.id})`);

    // 2. Lists: find the 5 lists by NAME and map them to statuses
    const lists = await trello(`/boards/${board.id}/lists`, { fields: 'id,name' });
    const listMap = {};
    for (const [status, name] of Object.entries(cfg.lists)) {
      const found = lists.find((l) => l.name.trim().toLowerCase() === String(name).trim().toLowerCase());
      if (!found) throw new Error(`List "${name}" not found. Lists on the board: ${lists.map((l) => l.name).join(', ')}`);
      listMap[found.id] = status;
    }
    console.log(`✔ Lists mapped: ${Object.values(cfg.lists).join(', ')}`);

    // 3. Team members (matched by email)
    for (const m of cfg.team) {
      if (!['DEV', 'QA', 'COORDINATOR'].includes(m.role)) throw new Error(`Role for ${m.name} must be DEV, QA or COORDINATOR`);
      const data = { name: m.name, trelloMemberId: m.trelloMemberId || null, slackUserId: m.slackUserId || null, role: m.role, active: true };
      await prisma.teamMember.upsert({ where: { email: m.email }, create: { email: m.email, ...data }, update: data });
    }
    console.log(`✔ Team saved: ${cfg.team.map((m) => `${m.name} (${m.role})`).join(', ')}`);

    // 4. Project
    const coordinator = cfg.coordinatorEmail ? await prisma.teamMember.findUnique({ where: { email: cfg.coordinatorEmail } }) : null;
    const projectData = {
      name: cfg.project.name,
      listMap,
      sheetId: cfg.project.sheetId,
      slackChannelId: cfg.project.slackChannelId,
      coordinatorId: coordinator ? coordinator.id : null,
      settings: cfg.project.settings || {},
      active: true,
    };
    const project = await prisma.project.upsert({
      where: { trelloBoardId: board.id },
      create: { trelloBoardId: board.id, ...projectData },
      update: projectData,
    });
    console.log(`✔ Project saved: ${project.name} (id ${project.id})`);

    // 5. Import existing cards through the running API (same rules as live changes)
    const apiBase = `http://localhost:${process.env.PORT || 3000}`;
    const res = await fetch(`${apiBase}/internal/projects/${project.id}/import`, {
      method: 'POST',
      headers: { 'X-Api-Key': env('INTERNAL_API_KEY') },
    });
    if (!res.ok) {
      console.warn(`⚠ Import failed: ${res.status} ${await res.text()}`);
      console.warn('  Start the API (npm run start:dev) and run this again.');
    } else {
      const r = await res.json();
      console.log(`✔ Cards imported: ${r.imported} new, ${r.skipped} already known`);
    }
    console.log('\nNext: npm run trello:webhook -- register');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
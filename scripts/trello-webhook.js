/**
 * Manage the Trello webhook:
 *   npm run trello:webhook -- list
 *   npm run trello:webhook -- register     (uses PUBLIC_BASE_URL + the board in config/project.json)
 *   npm run trello:webhook -- delete <webhookId>
 * "register" removes old webhooks for the same board first (e.g. an old ngrok address).
 */
const fs = require('fs');
const path = require('path');

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing in .env`);
  return v;
};

async function trello(method, pathname, params = {}) {
  const url = new URL(`https://api.trello.com/1${pathname}`);
  url.searchParams.set('key', env('TRELLO_API_KEY'));
  url.searchParams.set('token', env('TRELLO_TOKEN'));
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trello ${method} ${pathname} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const token = env('TRELLO_TOKEN');

  if (command === 'list') {
    const hooks = await trello('GET', `/tokens/${token}/webhooks`);
    if (!hooks.length) console.log('No webhooks registered.');
    for (const h of hooks) console.log(`${h.id}  active=${h.active}  board=${h.idModel}  ${h.callbackURL}`);
    return;
  }

  if (command === 'delete') {
    if (!arg) throw new Error('Usage: npm run trello:webhook -- delete <webhookId>');
    await trello('DELETE', `/webhooks/${arg}`);
    console.log(`✔ Deleted webhook ${arg}`);
    return;
  }

  if (command === 'register') {
    const cfg = JSON.parse(fs.readFileSync(path.resolve('config/project.json'), 'utf8'));
    const board = await trello('GET', `/boards/${cfg.project.trelloBoard}`, { fields: 'id,name' });
    const callbackURL = `${env('PUBLIC_BASE_URL').replace(/\/$/, '')}/webhooks/trello`;

    const existing = await trello('GET', `/tokens/${token}/webhooks`);
    for (const h of existing.filter((h) => h.idModel === board.id)) {
      await trello('DELETE', `/webhooks/${h.id}`);
      console.log(`✔ Removed old webhook ${h.id} (${h.callbackURL})`);
    }

    const hook = await trello('POST', '/webhooks', { callbackURL, idModel: board.id, description: `Task Sync – ${board.name}` });
    console.log(`✔ Webhook registered: ${hook.id}`);
    console.log(`  Board:    ${board.name}`);
    console.log(`  Callback: ${callbackURL}`);
    return;
  }

  console.log('Usage: npm run trello:webhook -- list | register | delete <webhookId>');
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  console.error('  If registering failed: is the API running, and does PUBLIC_BASE_URL (ngrok) open /health in the browser?');
  process.exit(1);
});
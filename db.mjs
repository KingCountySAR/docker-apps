#!/usr/bin/env node
// Opens psql on the shared postgres as its superuser (postgres), on the VM or in the stack on this machine. psql runs
// inside the postgres container, which trusts its own connections, so no password is needed. See lib/vm.mjs for the
// ssh settings (DEPLOY_HOST and such, in .env).
import { spawnSync } from 'node:child_process';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote, tunnel } from './lib/vm.mjs';

// postgres on the VM's loopback address (compose.yaml), and here at the other end of --tunnel
const TUNNEL_PORT = 15432;

const USAGE = `Usage: node db.mjs [--local] [--host <user@host>] [--ssh-options "<options>"] [database] [psql options...]
       node db.mjs --tunnel [--host <user@host>] [--ssh-options "<options>"]

Opens psql as the postgres superuser, in the given database (by default postgres). Anything after the database goes
to psql as it is.

  node db.mjs hydra                         psql in Hydra's database
  node db.mjs                               the postgres database (\\l lists the databases, \\du the users)
  node db.mjs hydra -c "select count(*) from hydra_client"
  node db.mjs hydra < query.sql             runs a file of SQL

  --local               Use the stack on this machine (docker compose up here) instead of the VM
  --tunnel              Instead, make the VM's postgres reachable at localhost:${TUNNEL_PORT} here, through ssh, until
                        Ctrl+C: for a job run on this machine against an app's database, signing in as the app's own
                        user (its URL with localhost:${TUNNEL_PORT} for postgres:5432)
${SSH_USAGE}`;

const rest = parseArgs(process.argv.slice(2), USAGE, { strict: false });
if (rest.includes('--tunnel')) {
  if (rest.length > 1) fail(USAGE);
  console.log(`The VM's postgres: localhost:${TUNNEL_PORT} (Ctrl+C to close)`);
  await tunnel(TUNNEL_PORT, TUNNEL_PORT);
  process.exit(0);
}
const local = rest.includes('--local');
const args = rest.filter(arg => arg !== '--local');
if (args[0] === '--help' || args[0] === '-h') fail(USAGE);
// A database name first, unless it's a psql option
const database = args[0] && !args[0].startsWith('-') ? args.shift() : 'postgres';

// A terminal only when you're typing at one, so input from a file or pipe still reaches psql.
const interactive = process.stdin.isTTY;
const exec = ['compose', 'exec', ...(interactive ? [] : ['-T']), 'postgres', 'psql', '-U', 'postgres', '-d', database, ...args];

if (local) {
  const result = spawnSync('docker', exec, { cwd: here, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  await onVm([`cd ${ROOT}`, ['docker', ...exec].map(quote).join(' ')], { tty: interactive });
}

#!/usr/bin/env node
// Sets up the VM and copies this folder's files to it, from Windows, macOS or Linux. See lib/vm.mjs for the settings
// (DEPLOY_HOST and such, in .env).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote, sendFile } from './lib/vm.mjs';

const USAGE = `Usage: node deploy.mjs <command> [--host <user@host>] [--ssh-options "<options>"]

  setup                 Install Docker and create ${ROOT} on a fresh VM (asks for your sudo password)
  vm                    Copy compose.yaml, hydra/, caddy/, postgres/, monitoring/, bin/ and the config examples, make
                        any missing secrets, and apply them
  rad [bundle]          Copy the RAD portal's build (../rad-portal/server/dist/rad-portal.mjs, unless given) to
                        ${ROOT}/apps/rad, and restart it
  cedar [bundle]        The same for cedar (../cedar/dist/cedar.mjs)
  reports [bundle]      The same for KCSARA Reports (../db-reporting/server/dist/db-reporting.mjs)
  respond [folder]      Copy Respond's build, a folder (../respond-sync/dist, unless given), to
                        ${ROOT}/apps/respond/current (keeping the one before as previous), and restart it
  seed-respond <file>   Import a Respond seed file (organizations, providers, site admins) into its database, and
                        restart it. The file goes to the import on its standard input, never onto the VM's disk
  import-respond <folder> [--dry-run]
                        Import respond-next's activities and saved locations from a mongoexport folder (its
                        *.activities.json and *.locations.json) into Respond's database, skipping those already there,
                        and restart it. Seed the organizations, with their legacyId, first. With --dry-run, only say
                        what it would import. The files stay off the VM's disk, as with seed-respond
  status                What's running
  logs [-f] [service]   The last 200 lines of a service's log (hydra, postgres, caddy, grafana, ...), or all of them;
                        with -f (--follow), then what's logged after, until Ctrl+C

${SSH_USAGE}

Example: node deploy.mjs status --host me@vm.example.org --ssh-options "-i ~/.ssh/vm_key"`;

const FOLDERS = ['hydra', 'caddy', 'postgres', 'monitoring', 'bin'];

// Configuration a service reads only when it starts, which compose doesn't watch: the service restarts when any of it
// changed since the last deploy (when the service is running).
const RESTART_ON_CHANGE = {
  hydra: ['hydra/hydra.yml'],
  caddy: ['caddy'],
  prometheus: ['monitoring/prometheus/prometheus.yml'],
  grafana: ['monitoring/grafana'],
  alloy: ['monitoring/alloy'],
  'blackbox-exporter': ['monitoring/blackbox.yml'],
};

/** Shell commands restarting each service in RESTART_ON_CHANGE whose files changed, remembering their checksums */
function restartsOnChange() {
  return Object.entries(RESTART_ON_CHANGE).map(([service, paths]) => {
    const sum = `find ${paths.join(' ')} -type f -exec md5sum {} + | sort | md5sum`;
    const state = `.${service}.md5`;
    return `{ now=$(${sum}); [ "$now" = "$(cat ${state} 2> /dev/null)" ] || { [ -z "$(docker compose ps -q ${service} 2> /dev/null)" ] || docker compose restart ${service}; echo "$now" > ${state}; }; }`;
  });
}

async function deployVm() {
  // Only the examples: never your own config/*.env, if you have any here.
  const examples = fs.readdirSync(path.join(here, 'config')).filter(f => f.endsWith('.env.example')).map(f => `config/${f}`);
  console.log(`Deploying compose.yaml, ${FOLDERS.join('/, ')}/ to ${ROOT}`);
  await onVm([
    `cd ${ROOT}`,
    'rm -rf .incoming',
    // apps/ has each app's build, copied by its own command (like `rad`); made here so docker doesn't make it, as root.
    `mkdir -p .incoming ${FOLDERS.join(' ')} config apps/rad apps/cedar apps/reports apps/respond`,
    'tar -xz -C .incoming',
    // Replaces the files inside each folder, keeping the folders: a running container's mount of a folder that was
    // removed and made again still shows the old, empty one.
    `for dir in ${FOLDERS.join(' ')}; do find "$dir" -mindepth 1 ! -type d -delete && cp -a ".incoming/$dir/." "$dir/" || exit 1; done`,
    'cp .incoming/compose.yaml . && cp .incoming/config/*.env.example config/',
    'rm -rf .incoming',
    // Secrets nobody needs to choose (postgres.env, hydra.env, ...); files that exist are left alone.
    'sh bin/secrets.sh',
    // Everything runs unless .env says otherwise (see "Choosing what runs" in the README).
    'grep -qs "^COMPOSE_PROFILES=" .env || echo COMPOSE_PROFILES=full >> .env',
    // docker compose won't run while an env file it names is missing, as on a new VM: say which, and stop here.
    'missing=$(for example in config/*.env.example; do [ -f "${example%.example}" ] || echo "  ' + ROOT + '/${example%.example}"; done)',
    `{ [ -z "$missing" ] || { printf 'Copied. Before anything can start, create these from the .env.example next to each, then run this again:\\n%s\\n' "$missing"; exit 0; }; }`,
    // Recreates whatever compose.yaml changed, then restarts services whose own configuration did.
    'docker compose up -d --remove-orphans',
    ...restartsOnChange(),
    'docker compose ps',
  ], { files: ['compose.yaml', ...FOLDERS, ...examples], cwd: here });
}

// Apps that run from one built file, copied to apps/<name>/ by `node deploy.mjs <name>`: the service in compose.yaml,
// the file it runs, and where the build is, in the app's repo next to this one.
const APPS = {
  rad: { file: 'rad-portal.mjs', build: ['rad-portal', 'server', 'dist', 'rad-portal.mjs'], repo: 'rad-portal' },
  cedar: { file: 'cedar.mjs', build: ['cedar', 'dist', 'cedar.mjs'], repo: 'cedar' },
  // reports-etl runs the same file, and picks up the new one on its next run.
  reports: { file: 'db-reporting.mjs', build: ['db-reporting', 'server', 'dist', 'db-reporting.mjs'], repo: 'db-reporting' },
};

async function deployApp(app, bundle = path.join(here, '..', ...APPS[app].build)) {
  const { file, repo } = APPS[app];
  bundle = path.resolve(bundle);
  if (!fs.existsSync(bundle)) fail(`No ${bundle}. Run \`npm run build\` in ${repo} first, or give the bundle's path.`);
  const name = path.basename(bundle);
  const files = [name, ...(fs.existsSync(`${bundle}.map`) ? [`${name}.map`] : [])];
  console.log(`Deploying ${bundle} to ${ROOT}/apps/${app}`);
  await onVm([
    `mkdir -p ${ROOT}/apps/${app}`,
    `cd ${ROOT}/apps/${app}`,
    'rm -rf .incoming',
    'mkdir .incoming',
    'tar -xz -C .incoming',
    // Moved into place whole, under the name compose.yaml runs, so the app never starts from a half-copied file.
    `mv -f .incoming/${quote(name)} ${file}`,
    `{ [ ! -f .incoming/${quote(`${name}.map`)} ] || mv -f .incoming/${quote(`${name}.map`)} ${file}.map; }`,
    'rm -rf .incoming',
    `cd ${ROOT}`,
    `{ [ -f config/${app}.env ] || { echo 'Copied. Before it can start, create ${ROOT}/config/${app}.env from ${app}.env.example next to it, then run node deploy.mjs vm.'; exit 0; }; }`,
    // Restarts it with the new file if it's running; otherwise it starts with the next `node deploy.mjs vm` (with its
    // profile on).
    `{ [ -z "$(docker compose ps -q ${app} 2> /dev/null)" ] || docker compose restart ${app}; }`,
    'docker compose ps',
  ], { files, cwd: path.dirname(bundle) });
}

// Respond's build is a folder (the server, the UI it serves, and its seed import): apps/respond/current, run by the
// respond service in compose.yaml.
const RESPOND_BUILD = path.join(here, '..', 'respond-sync', 'dist');

async function deployRespond(dir = RESPOND_BUILD) {
  dir = path.resolve(dir);
  if (!fs.existsSync(path.join(dir, 'index.mjs'))) fail(`No ${path.join(dir, 'index.mjs')}. Run \`npm run build\` in respond-sync first, or give the build folder's path.`);
  console.log(`Deploying ${dir} to ${ROOT}/apps/respond/current`);
  await onVm([
    `mkdir -p ${ROOT}/apps/respond`,
    `cd ${ROOT}/apps/respond`,
    'rm -rf .incoming',
    'mkdir .incoming',
    'tar -xz -C .incoming',
    // Swapped in whole, so the app never starts from a half-copied folder. The build before stays as previous: to go
    // back, swap the two by hand and restart.
    'rm -rf previous',
    '{ [ ! -d current ] || mv current previous; }',
    'mv .incoming current',
    `cd ${ROOT}`,
    `{ [ -f config/respond.env ] || { echo 'Copied. Before it can start, create ${ROOT}/config/respond.env from respond.env.example next to it, then run node deploy.mjs vm.'; exit 0; }; }`,
    // Restarts it with the new build if it's running; otherwise it starts with the next `node deploy.mjs vm` (with its
    // profile on).
    '{ [ -z "$(docker compose ps -q respond 2> /dev/null)" ] || docker compose restart respond; }',
    'docker compose ps',
  ], { files: fs.readdirSync(dir), cwd: dir });
}

async function seedRespond(file) {
  if (!file) fail(`Give the seed file: node deploy.mjs seed-respond <file>\n\n${USAGE}`);
  file = path.resolve(file);
  if (!fs.existsSync(file)) fail(`No ${file}.`);
  console.log(`Importing ${file} into Respond's database`);
  await onVm([
    `cd ${ROOT}`,
    `{ [ -f apps/respond/current/seed.mjs ] || { echo 'No Respond build on the VM yet: run node deploy.mjs respond first.'; exit 1; }; }`,
    `{ [ -n "$(docker compose ps -q respond 2> /dev/null)" ] || { echo 'Respond is not running: start it with node deploy.mjs vm first.'; exit 1; }; }`,
    // The file arrives in a tar on standard input, and goes from it straight to the import (seed.mjs reads - as
    // standard input), run in the app's container, with its database and SECRETS_KEY. Not in a one-off container
    // (`docker compose run`): that would carry the service's caddy labels, making Respond's sites twice for Caddy.
    'tar -xzO | docker compose exec -T respond node --enable-source-maps current/seed.mjs -',
    // The app reads the organizations when it starts.
    'docker compose restart respond',
  ], { files: [path.basename(file)], cwd: path.dirname(file) });
}

async function importRespond(folder, dryRun) {
  if (!folder) fail(`Give the export folder: node deploy.mjs import-respond <folder> [--dry-run]\n\n${USAGE}`);
  folder = path.resolve(folder);
  if (!fs.existsSync(folder)) fail(`No ${folder}.`);
  // Only the two collections the import reads, not the rest of the export.
  const files = ['.activities.json', '.locations.json'].map(suffix => {
    const names = fs.readdirSync(folder).filter(n => n.endsWith(suffix));
    return names.length === 1 ? names[0] : fail(`${folder}: expected one *${suffix}, found ${names.length ? names.join(', ') : 'none'}`);
  });
  console.log(`Importing ${files.join(' and ')} into Respond's database${dryRun ? ' (dry run)' : ''}`);
  const run = `dir=$(mktemp -d) && tar -xz -C "$dir" && node --enable-source-maps current/import-legacy.mjs "$dir"${dryRun ? ' --dry-run' : ''}; status=$?; rm -rf "$dir"; exit $status`;
  await onVm([
    `cd ${ROOT}`,
    `{ [ -f apps/respond/current/import-legacy.mjs ] || { echo 'No import-legacy.mjs in the Respond build on the VM: run node deploy.mjs respond first.'; exit 1; }; }`,
    `{ [ -n "$(docker compose ps -q respond 2> /dev/null)" ] || { echo 'Respond is not running: start it with node deploy.mjs vm first.'; exit 1; }; }`,
    // The tar goes on standard input to the app's container (with its database and SECRETS_KEY; not a one-off
    // container, as in seedRespond), which unpacks it into a temporary folder inside itself and removes it after.
    `docker compose exec -T respond sh -c ${quote(run)}`,
    // The app adds imported activities to its list and archive when it starts.
    ...(dryRun ? [] : ['docker compose restart respond']),
  ], { files, cwd: folder });
}

async function setupVm() {
  // Copied over first, then run with a terminal, so sudo can ask for your password.
  const script = '/tmp/kcsara-setup-vm.sh';
  await sendFile(path.join(here, 'setup-vm.sh'), script);
  await onVm([`bash ${script}`, `rm ${script}`], { tty: true });
}

const argv = process.argv.slice(2);
const follow = argv[0] === 'logs' && ['-f', '--follow'].some(flag => argv.includes(flag));
const dryRun = argv[0] === 'import-respond' && argv.includes('--dry-run');
const [command, arg] = parseArgs(argv.filter(a => !(follow && (a === '-f' || a === '--follow')) && !(dryRun && a === '--dry-run')), USAGE);
switch (command) {
  case 'setup':
    await setupVm();
    break;
  case 'vm':
    await deployVm();
    break;
  case 'rad':
  case 'cedar':
  case 'reports':
    await deployApp(command, arg);
    break;
  case 'respond':
    await deployRespond(arg);
    break;
  case 'seed-respond':
    await seedRespond(arg);
    break;
  case 'import-respond':
    await importRespond(arg, dryRun);
    break;
  case 'status':
    await onVm([`cd ${ROOT}`, 'docker compose ps']);
    break;
  case 'logs':
    if (follow) {
      // With a terminal on the VM, Ctrl+C stops docker compose there, rather than just this end of ssh; stopping that
      // way (exit 130) isn't a failure.
      await onVm([`cd ${ROOT}`, `{ docker compose logs --tail 200 -f ${arg ? quote(arg) : ''} || [ $? -eq 130 ]; }`], { tty: process.stdout.isTTY });
    } else {
      await onVm([`cd ${ROOT}`, `docker compose logs --tail 200 ${arg ? quote(arg) : ''}`]);
    }
    break;
  default:
    fail(USAGE);
}

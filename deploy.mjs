#!/usr/bin/env node
// Sets up the VM and copies this folder's files to it, from Windows, macOS or Linux. See lib/vm.mjs for the settings
// (DEPLOY_HOST and such, in .env).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote, sendFile } from './lib/vm.mjs';

const USAGE = `Usage: node deploy.mjs <command> [--host <user@host>] [--ssh-options "<options>"]

  setup                 Install Docker and create ${ROOT} on a fresh VM (asks for your sudo password)
  vm                    Copy compose.yaml, hydra/, caddy/, postgres/, monitoring/, mail/, bin/ and the config examples,
                        make any missing secrets, and apply them (building the mail service first)
  app <repo>            Deploy an app from its repo: its deploy/ folder (with its compose.yaml), and the build files
                        its deploy/app.json lists, to ${ROOT}/apps/<name> (see "Apps" in the README). Build it first
  database <name> [database]
                        Give such an app a database and user in the shared postgres, with its URL in
                        ${ROOT}/apps/<name>/config/database.env. The database is the name with _ for -, unless given
  exec <app> <service> [--put <path>]... -- <command>
                        Run a command in an app's running container (like a script in its build), with your terminal,
                        or this end's standard input. With --put, the files or folders go first to a temporary folder in
                        the container, removed after, and {put} in the command is that folder
  backup [-- <restic command>]
                        Back up to Azure now (it also runs every day), or run a restic command in the backup service,
                        like backup -- snapshots (see "Backups" in the README)
  restart <name>        Restart an app (all its services), or one of this project's services
  status                What's running, and each app's compose project
  logs [-f] [service]   The last 200 lines of a service's log (hydra, postgres, caddy, grafana, ...), or all of an
                        app's (rad, cedar, reports, respond, ...), or all of this project's; with -f (--follow), then
                        what's logged after, until Ctrl+C

${SSH_USAGE}

Example: node deploy.mjs status --host me@vm.example.org --ssh-options "-i ~/.ssh/vm_key"`;

const FOLDERS = ['hydra', 'caddy', 'postgres', 'monitoring', 'mail', 'bin'];

/** Bundles the mail service into mail/dist/mail.mjs (see mail/build.mjs), installing its dependencies the first time. */
function buildMail() {
  const dir = path.join(here, 'mail');
  // npm is npm.cmd on Windows, which only runs through a shell. Node itself mustn't: its path (C:\Program Files\...) has
  // a space, which the shell would split.
  const run = (command, args) => {
    const shell = process.platform === 'win32' && command === 'npm';
    const { status } = spawnSync(command, args, { cwd: dir, stdio: 'inherit', shell });
    if (status !== 0) fail(`Building the mail service failed: ${command} ${args.join(' ')} in mail/`);
  };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) run('npm', ['ci']);
  run(process.execPath, ['build.mjs']);
}

// Configuration a service reads only when it starts, which compose doesn't watch: the service restarts when any of it
// changed since the last deploy (when the service is running).
const RESTART_ON_CHANGE = {
  hydra: ['hydra/hydra.yml'],
  caddy: ['caddy'],
  prometheus: ['monitoring/prometheus/prometheus.yml'],
  grafana: ['monitoring/grafana'],
  alloy: ['monitoring/alloy'],
  'blackbox-exporter': ['monitoring/blackbox.yml'],
  // Its daily loop is the script, read once when it starts.
  backup: ['bin/backup.sh'],
  // The bundle, which it reads once when it starts.
  mail: ['mail/dist'],
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
  // Every time, so what's sent is never an old build.
  buildMail();
  // Only the examples: never your own config/*.env, if you have any here.
  const examples = fs.readdirSync(path.join(here, 'config')).filter(f => f.endsWith('.env.example')).map(f => `config/${f}`);
  console.log(`Deploying compose.yaml, ${FOLDERS.join('/, ')}/ to ${ROOT}`);
  await onVm([
    `cd ${ROOT}`,
    'rm -rf .incoming',
    // apps/ has each app with its own compose.yaml (node deploy.mjs app); made here so docker doesn't make it, as root.
    `mkdir -p .incoming ${FOLDERS.join(' ')} config apps`,
    'tar -xz -C .incoming',
    // Replaces the files inside each folder, keeping the folders: a running container's mount of a folder that was
    // removed and made again still shows the old, empty one.
    `for dir in ${FOLDERS.join(' ')}; do find "$dir" -mindepth 1 ! -type d -delete && cp -a ".incoming/$dir/." "$dir/" || exit 1; done`,
    // The examples are replaced as a set, so one for a service no longer here doesn't ask for its env file below.
    'cp .incoming/compose.yaml . && rm -f config/*.env.example && cp .incoming/config/*.env.example config/',
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

// Running something in an app's container, always the running one: a one-off container (`docker compose run`) would
// carry the service's caddy labels, making its sites twice for Caddy.
const NAME = /^[a-z0-9][a-z0-9_.-]*$/;

/** Shell commands going to an app's folder on the VM, checking that its service is running */
const appRunning = (app, service) => [
  `{ [ -f ${ROOT}/apps/${app}/current/compose.yaml ] || { echo ${quote(`No app ${app} on the VM: deploy it with node deploy.mjs app <repo>.`)}; exit 1; }; }`,
  `cd ${ROOT}/apps/${app}/current`,
  `{ [ -n "$(docker compose ps -q ${service} 2> /dev/null)" ] || { echo ${quote(`${app}'s ${service} isn't running.`)}; exit 1; }; }`,
];

async function execInApp(app, service, puts, command) {
  if (!app || !service || !command.length) fail(`Give the app, its service and the command: node deploy.mjs exec <app> <service> [--put <path>]... -- <command>\n\n${USAGE}`);
  for (const name of [app, service]) if (!NAME.test(name)) fail(`Not an app or service name: ${name}`);
  if (!puts.length) {
    // Your terminal reaches the command, or else this end's standard input (a file or pipe).
    const tty = process.stdin.isTTY;
    await onVm([...appRunning(app, service), ['docker', 'compose', 'exec', ...(tty ? [] : ['-T']), service, ...command].map(quote).join(' ')], { tty });
    return;
  }
  const paths = puts.map(p => path.resolve(p));
  const missing = paths.find(p => !fs.existsSync(p));
  if (missing) fail(`No ${missing}.`);
  const names = paths.map(p => path.basename(p));
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) fail(`Two of the --put files are ${twice}.`);
  // All in one folder, sent as one tar, which the container unpacks into a folder of its own, where {put} in the command
  // points. It's removed after, however the command ends, so the files never stay on the VM.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsara-put-'));
  process.on('exit', () => fs.rmSync(staging, { recursive: true, force: true }));
  for (const p of paths) fs.cpSync(p, path.join(staging, path.basename(p)), { recursive: true });
  const dir = `/tmp/put-${crypto.randomBytes(8).toString('hex')}`;
  const run = `mkdir -p ${dir} && tar -xz -C ${dir} && "$@"; status=$?; rm -rf ${dir}; exit $status`;
  const args = command.map(a => a.replaceAll('{put}', dir));
  await onVm([...appRunning(app, service), ['docker', 'compose', 'exec', '-T', service, 'sh', '-c', run, 'sh', ...args].map(quote).join(' ')], {
    files: fs.readdirSync(staging),
    cwd: staging,
  });
}

/** A shell command going to the project with `name`: an app's (all its services), or else this one, for its service `name` */
const projectOf = name =>
  name
    ? `{ if [ -f apps/${quote(name)}/current/compose.yaml ]; then cd apps/${quote(name)}/current; service=''; else service=${quote(name)}; fi; }`
    : "service=''";

// Apps that bring their own compose.yaml, in a deploy/ folder in their repo, with app.json:
//   { "name": "reports", "files": ["server/dist/db-reporting.mjs", "server/dist/db-reporting.mjs.map"] }
// The files (or folders) are paths in the repo, sent next to compose.yaml under their own names. On the VM,
// bin/deploy-app.sh does the rest, which a GitHub workflow can run the same way.
async function deployComposeApp(repo) {
  if (!repo) fail(`Give the app's repo: node deploy.mjs app <repo>\n\n${USAGE}`);
  repo = path.resolve(repo);
  const deployDir = path.join(repo, 'deploy');
  const manifest = path.join(deployDir, 'app.json');
  let app;
  try {
    app = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (err) {
    fail(`${manifest}: ${err.message}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(app.name ?? '') || app.name === 'kcsara') fail(`${manifest}: "name" must be lower case letters, digits and -, not kcsara.`);
  if (!fs.existsSync(path.join(deployDir, 'compose.yaml'))) fail(`No ${path.join(deployDir, 'compose.yaml')}.`);
  const files = (app.files ?? []).map(file => path.resolve(repo, file));
  const names = [...fs.readdirSync(deployDir), ...files.map(file => path.basename(file))];
  const twice = names.find((name, i) => names.indexOf(name) !== i);
  if (twice) fail(`${manifest}: two files would be ${twice}.`);
  const missing = files.find(file => !fs.existsSync(file));
  if (missing) fail(`No ${missing}. Build ${app.name} first.`);

  // All in one folder, sent as one tar.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kcsara-app-'));
  process.on('exit', () => fs.rmSync(staging, { recursive: true, force: true }));
  fs.cpSync(deployDir, staging, { recursive: true });
  for (const file of files) fs.cpSync(file, path.join(staging, path.basename(file)), { recursive: true });
  console.log(`Deploying ${repo} to ${ROOT}/apps/${app.name}`);
  await onVm([`sh ${ROOT}/bin/deploy-app.sh ${app.name}`], { files: fs.readdirSync(staging), cwd: staging });
}

async function appDatabase(app, database) {
  if (!app) fail(`Give the app's name: node deploy.mjs database <name> [database]\n\n${USAGE}`);
  await onVm([`sh ${ROOT}/bin/app-database.sh ${quote(app)}${database ? ` ${quote(database)}` : ''}`]);
}

async function setupVm() {
  // Copied over first, then run with a terminal, so sudo can ask for your password.
  const script = '/tmp/kcsara-setup-vm.sh';
  await sendFile(path.join(here, 'setup-vm.sh'), script);
  await onVm([`bash ${script}`, `rm ${script}`], { tty: true });
}

const argv = process.argv.slice(2);
const follow = argv[0] === 'logs' && ['-f', '--follow'].some(flag => argv.includes(flag));
// exec's and backup's command, after --, goes to the VM as it is; exec's --put options come out before parseArgs sees
// the rest.
const split = ['exec', 'backup'].includes(argv[0]) && argv.includes('--') ? argv.indexOf('--') : argv.length;
const execCommand = argv.slice(split + 1);
const puts = [];
const options = argv.slice(0, split).filter((a, i, all) => {
  if (argv[0] !== 'exec') return true;
  if (a === '--put') return puts.push(all[i + 1] ?? fail(`--put needs a path

${USAGE}`)) && false;
  return all[i - 1] !== '--put';
});
const [command, arg, arg2] = parseArgs(options.filter(a => !(follow && (a === '-f' || a === '--follow'))), USAGE);
switch (command) {
  case 'setup':
    await setupVm();
    break;
  case 'vm':
    await deployVm();
    break;
  case 'app':
    await deployComposeApp(arg);
    break;
  case 'database':
    await appDatabase(arg, arg2);
    break;
  case 'exec':
    await execInApp(arg, arg2, puts, execCommand);
    break;
  case 'backup': {
    // A restic command, or else bin/backup.sh, the same as the daily one, shown in the service's log as well as here
    // (/proc/1/fd/1 is the log: the container's first process's output).
    const run = execCommand.length
      ? ['restic', ...execCommand]
      : ['sh', '-c', 'set -o pipefail; sh /scripts/backup.sh 2>&1 | tee /proc/1/fd/1'];
    const tty = process.stdin.isTTY;
    await onVm([
      `cd ${ROOT}`,
      `{ [ -n "$(docker compose ps -q backup 2> /dev/null)" ] || { echo ${quote("The backup service isn't running: see Backups in the README.")}; exit 1; }; }`,
      ['docker', 'compose', 'exec', ...(tty ? [] : ['-T']), 'backup', ...run].map(quote).join(' '),
    ], { tty });
    break;
  }
  case 'restart':
    if (!arg) fail(`Give an app's name, or a service's: node deploy.mjs restart <name>

${USAGE}`);
    await onVm([`cd ${ROOT}`, projectOf(arg), 'docker compose restart $service']);
    break;
  case 'status':
    // This project's services, then every project: this one and each app's.
    await onVm([`cd ${ROOT}`, 'docker compose ps', 'echo', 'docker compose ls']);
    break;
  case 'logs': {
    const where = projectOf(arg);
    if (follow) {
      // With a terminal on the VM, Ctrl+C stops docker compose there, rather than just this end of ssh; stopping that
      // way (exit 130) isn't a failure.
      await onVm([`cd ${ROOT}`, where, '{ docker compose logs --tail 200 -f $service || [ $? -eq 130 ]; }'], { tty: process.stdout.isTTY });
    } else {
      await onVm([`cd ${ROOT}`, where, 'docker compose logs --tail 200 $service']);
    }
    break;
  }
  default:
    fail(USAGE);
}

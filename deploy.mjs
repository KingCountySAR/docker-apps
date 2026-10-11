#!/usr/bin/env node
// Sets up the VM and copies this folder's files to it, from Windows, macOS or Linux. See lib/vm.mjs for the settings
// (DEPLOY_HOST and such, in .env).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote, sendFile } from './lib/vm.mjs';

const USAGE = `Usage: node deploy.mjs <command> [--host <user@host>] [--ssh-options "<options>"]

  setup                 Install Docker and create ${ROOT} on a fresh VM (asks for your sudo password)
  vm                    Copy compose.yaml, hydra/, nginx/, postgres/, monitoring/, bin/ and the config examples, make
                        any missing secrets, and apply them
  status                What's running
  logs [-f] [service]   The last 200 lines of a service's log (hydra, postgres, nginx, grafana, ...), or all of them;
                        with -f (--follow), then what's logged after, until Ctrl+C

${SSH_USAGE}

Example: node deploy.mjs status --host me@vm.example.org --ssh-options "-i ~/.ssh/vm_key"`;

const FOLDERS = ['hydra', 'nginx', 'postgres', 'monitoring', 'bin'];

// Configuration a service reads only when it starts, which compose doesn't watch: the service restarts when any of it
// changed since the last deploy (when the service is running).
const RESTART_ON_CHANGE = {
  hydra: ['hydra/hydra.yml'],
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
    `mkdir -p .incoming ${FOLDERS.join(' ')} config`,
    'tar -xz -C .incoming',
    // Replaces the files inside each folder, keeping the folders: a running container's mount of a folder that was
    // removed and made again still shows the old, empty one.
    `for dir in ${FOLDERS.join(' ')}; do find "$dir" -mindepth 1 ! -type d -delete && cp -a ".incoming/$dir/." "$dir/" || exit 1; done`,
    'cp .incoming/compose.yaml . && cp .incoming/config/*.env.example config/',
    'rm -rf .incoming',
    // Secrets nobody needs to choose (postgres.env, hydra.env, ...); files that exist are left alone.
    'sh bin/secrets.sh',
    // The sites for Prometheus's health checks
    'sh bin/site-targets.sh',
    // Everything runs unless .env says otherwise (see "Choosing what runs" in the README).
    'grep -qs "^COMPOSE_PROFILES=" .env || echo COMPOSE_PROFILES=full >> .env',
    // docker compose won't run while an env file it names is missing, as on a new VM: say which, and stop here.
    'missing=$(for example in config/*.env.example; do [ -f "${example%.example}" ] || echo "  ' + ROOT + '/${example%.example}"; done)',
    `{ [ -z "$missing" ] || { printf 'Copied. Before anything can start, create these from the .env.example next to each, then run this again:\\n%s\\n' "$missing"; exit 0; }; }`,
    // Recreates whatever compose.yaml changed, then restarts services whose own configuration did.
    'docker compose up -d --remove-orphans',
    ...restartsOnChange(),
    // Loads new or changed sites now rather than within the minute; a site without a certificate yet waits for one.
    'docker compose exec -T nginx sh /etc/kcsara-nginx/run.sh check',
    // A new site gets its certificate on certbot's next try; restarting it tries now.
    'docker compose restart certbot',
    'docker compose ps',
  ], { files: ['compose.yaml', ...FOLDERS, ...examples], cwd: here });
}

async function setupVm() {
  // Copied over first, then run with a terminal, so sudo can ask for your password.
  const script = '/tmp/kcsara-setup-vm.sh';
  await sendFile(path.join(here, 'setup-vm.sh'), script);
  await onVm([`bash ${script}`, `rm ${script}`], { tty: true });
}

const argv = process.argv.slice(2);
const follow = argv[0] === 'logs' && ['-f', '--follow'].some(flag => argv.includes(flag));
const [command, arg] = parseArgs(argv.filter(a => !follow || (a !== '-f' && a !== '--follow')), USAGE);
switch (command) {
  case 'setup':
    await setupVm();
    break;
  case 'vm':
    await deployVm();
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

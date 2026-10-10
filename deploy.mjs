#!/usr/bin/env node
// Sets up the VM and copies this folder's files to it, from Windows, macOS or Linux. See lib/vm.mjs for the settings
// (DEPLOY_HOST and such, in .env).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote, sendFile } from './lib/vm.mjs';

const USAGE = `Usage: node deploy.mjs <command> [--host <user@host>] [--ssh-options "<options>"]

  setup                 Install Docker, create ${ROOT} and Hydra's secrets on a fresh VM (asks for your sudo password)
  vm                    Copy compose.yaml, hydra/, nginx/ and the config examples, and apply them
  status                What's running
  logs [service]        The last 200 lines of a service's log (hydra, postgres, nginx, certbot), or all of them

${SSH_USAGE}

Example: node deploy.mjs status --host me@vm.example.org --ssh-options "-i ~/.ssh/vm_key"`;

const FOLDERS = ['hydra', 'nginx'];

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
    // docker compose won't run while an env file it names is missing, as on a new VM: say which, and stop here.
    'missing=$(for example in config/*.env.example; do [ -f "${example%.example}" ] || echo "  ' + ROOT + '/${example%.example}"; done)',
    `{ [ -z "$missing" ] || { printf 'Copied. Before anything can start, create these from the .env.example next to each, then run this again:\\n%s\\n' "$missing"; exit 0; }; }`,
    // Recreates whatever compose.yaml changed; hydra restarts too if hydra.yml did (compose doesn't notice that).
    'docker compose up -d --remove-orphans',
    'if [ "$(md5sum hydra/hydra.yml)" != "$(cat .hydra.yml.md5 2> /dev/null)" ]; then docker compose restart hydra && md5sum hydra/hydra.yml > .hydra.yml.md5; fi',
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

const [command, arg] = parseArgs(process.argv.slice(2), USAGE);
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
    await onVm([`cd ${ROOT}`, `docker compose logs --tail 200 ${arg ? quote(arg) : ''}`]);
    break;
  default:
    fail(USAGE);
}

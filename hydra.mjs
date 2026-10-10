#!/usr/bin/env node
// Runs Hydra's own command line (https://www.ory.sh/docs/hydra/cli/hydra) on the VM, against its admin API, which
// only the VM itself can reach. See lib/vm.mjs for the ssh settings (DEPLOY_HOST and such, in .env).
import { spawnSync } from 'node:child_process';
import { ROOT, SSH_USAGE, fail, here, onVm, parseArgs, quote } from './lib/vm.mjs';

const USAGE = `Usage: node hydra.mjs [--local] [--host <user@host>] [--ssh-options "<options>"] <hydra command...>

Runs \`hydra <command...>\` in the hydra container on the VM, with its admin API as the endpoint. Everything other than
the options below goes to hydra as it is (put -- in front if one of hydra's own options is called --host).

  node hydra.mjs list oauth2-clients
  node hydra.mjs create oauth2-client --name "Some app" --grant-type client_credentials --scope read --format json
  node hydra.mjs get oauth2-client <id>
  node hydra.mjs delete oauth2-client <id>
  node hydra.mjs help

  --local               Run it in the stack on this machine (docker compose up here) instead of on the VM
${SSH_USAGE}`;

const rest = parseArgs(process.argv.slice(2), USAGE, { strict: false });
const local = rest.includes('--local');
const hydraArgs = rest.filter(arg => arg !== '--local');
if (hydraArgs.length === 0 || hydraArgs[0] === '--help' || hydraArgs[0] === '-h') fail(USAGE);

// The admin API, from inside the hydra container. Give --endpoint (-e) for commands meant for the public one (4444).
const exec = ['compose', 'exec', '-T', '-e', 'ORY_SDK_URL=http://127.0.0.1:4445', 'hydra', 'hydra', ...hydraArgs];

if (local) {
  const result = spawnSync('docker', exec, { cwd: here, stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  await onVm([`cd ${ROOT}`, ['docker', ...exec].map(quote).join(' ')]);
}

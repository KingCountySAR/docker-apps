// What deploy.mjs and hydra.mjs share: settings, the command line's ssh options, and running commands on the VM over
// ssh. Needs Node 22 and the ssh and tar commands (built into Windows 10 and later, macOS and Linux). Uses your own ssh
// setup: keys, ~/.ssh/config and agent.
//
// Settings come from the command line, or from .env next to the scripts (see .env.example) or the environment:
//   DEPLOY_HOST          your ssh login on the VM, user@host, or a Host name from ~/.ssh/config (--host)
//   DEPLOY_SSH           the ssh command, if not `ssh` (rarely needed)
//   DEPLOY_SSH_OPTIONS   extra ssh options, like `-p 2222`; --ssh-options adds to these
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = '/srv/kcsara';

try {
  process.loadEnvFile(path.join(here, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

export const SSH_USAGE = `  --host <user@host>    Your ssh login on the VM, or a Host name from ~/.ssh/config (instead of DEPLOY_HOST in .env)
  --ssh-options "..."   Options for ssh, in one quoted string, like "-i C:\\Users\\me\\.ssh\\vm_key -p 2222". Quote a
                        path with spaces inside it: "-i 'C:\\Users\\Jo Smith\\.ssh\\vm_key'". Adds to DEPLOY_SSH_OPTIONS.`;

// The ssh login and options given on the command line (see parseArgs)
const ssh = { host: undefined, options: [] };

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Splits a string of ssh options into separate ones, at spaces outside quotes. Single or double quotes keep a path
 * with spaces together. Backslashes are ordinary characters, so Windows paths need no escaping.
 */
function splitOptions(text) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (quote) fail(`Unclosed ${quote} in ssh options: ${text}`);
  if (word !== null) words.push(word);
  return words;
}

/**
 * Takes --host and --ssh-options ("--name value" or "--name=value") out of the command line, and returns the rest.
 * With `strict`, any other option is an error; otherwise it's left in the rest (for hydra.mjs to pass on).
 */
export function parseArgs(argv, usage, { strict = true } = {}) {
  const rest = [];
  const valueOf = (arg, name, i) => {
    if (arg === name) return argv[i + 1] === undefined ? fail(`${name} needs a value\n\n${usage}`) : [argv[i + 1], 1];
    if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1), 0];
    return undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let found;
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    } else if ((found = valueOf(arg, '--host', i))) {
      ssh.host = found[0];
      i += found[1];
    } else if ((found = valueOf(arg, '--ssh-options', i))) {
      ssh.options.push(...splitOptions(found[0]));
      i += found[1];
    } else if (strict && (arg === '--help' || arg === '-h')) {
      fail(usage);
    } else if (strict && arg.startsWith('-')) {
      fail(`Unknown option ${arg}. Options for ssh go in --ssh-options "...".\n\n${usage}`);
    } else {
      rest.push(arg);
    }
  }
  return rest;
}

export function deployHost() {
  return ssh.host || process.env.DEPLOY_HOST || fail('Give your ssh login on the VM with --host user@host, or set DEPLOY_HOST in .env.');
}

const sshCommand = () => process.env.DEPLOY_SSH || 'ssh';
const sshOptions = () => [...splitOptions(process.env.DEPLOY_SSH_OPTIONS || ''), ...ssh.options];

/** Quotes a word for the VM's shell */
export const quote = word => `'${String(word).replaceAll("'", `'\\''`)}'`;

/** Waits for a child process, failing with its name if it doesn't succeed */
function finished(child, name) {
  return new Promise((resolve, reject) => {
    child.on('error', err => reject(new Error(`${name}: ${err.message}`)));
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${name} failed (exit ${code})`))));
  });
}

/**
 * Runs commands on the VM, one after another, stopping at the first that fails. With `files`, a gzipped tar of them
 * (relative to `cwd`) arrives on the first command's standard input. With `tty`, the commands get a terminal, so
 * sudo can ask for a password.
 */
export async function onVm(commands, { files, cwd, tty } = {}) {
  const child = spawn(sshCommand(), [...sshOptions(), ...(tty ? ['-t'] : []), deployHost(), commands.join(' && ')], {
    stdio: [files ? 'pipe' : 'inherit', 'inherit', 'inherit'],
  });
  const waits = [finished(child, 'ssh')];
  if (files) {
    // Relative paths from cwd, so no tar (Windows', GNU's or BSD's) mistakes C: for a remote host.
    // Never anyone's node_modules (mail/'s, from building it): what runs there is bundled.
    const tar = spawn('tar', ['-czf', '-', '--exclude=node_modules', ...files], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    tar.stdout.pipe(child.stdin);
    waits.push(finished(tar, 'tar'));
  }
  await Promise.all(waits).catch(err => fail(err.message));
}

/** Forwards a port on this machine to one on the VM's own loopback address, until Ctrl+C (or ssh fails) */
export async function tunnel(localPort, remotePort) {
  const child = spawn(sshCommand(), [...sshOptions(), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${localPort}:127.0.0.1:${remotePort}`, deployHost()], {
    stdio: 'inherit',
  });
  // Ctrl+C reaches ssh too, which then stops; stopping that way isn't a failure.
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  await finished(child, 'ssh').catch(err => stopping || fail(err.message));
}

/** Copies one local file to a path on the VM */
export async function sendFile(local, remote) {
  const child = spawn(sshCommand(), [...sshOptions(), deployHost(), `cat > ${remote}`], { stdio: ['pipe', 'inherit', 'inherit'] });
  fs.createReadStream(local).pipe(child.stdin);
  await finished(child, 'ssh').catch(err => fail(err.message));
}

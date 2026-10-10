#!/usr/bin/env node
// Opens Grafana on the VM at http://localhost:3030, through an ssh tunnel, until Ctrl+C. Grafana is only on the VM's
// own loopback address (port 3030 there too). See lib/vm.mjs for the ssh settings (DEPLOY_HOST and such, in .env).
import { SSH_USAGE, fail, parseArgs, tunnel } from './lib/vm.mjs';

const USAGE = `Usage: node grafana.mjs [--host <user@host>] [--ssh-options "<options>"]

Opens Grafana at http://localhost:3030 until Ctrl+C. Sign in as admin (the password is GF_SECURITY_ADMIN_PASSWORD
in /srv/kcsara/config/grafana.env on the VM), or with Google once that's set up.

${SSH_USAGE}`;

// Grafana's root_url (monitoring/grafana/grafana.ini) and Google's sign-in callback both say 3030.
const PORT = 3030;

if (parseArgs(process.argv.slice(2), USAGE).length > 0) fail(USAGE);
console.log(`Grafana: http://localhost:${PORT} (Ctrl+C to close)`);
await tunnel(PORT, PORT);

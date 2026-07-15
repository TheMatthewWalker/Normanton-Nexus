const Service = require('node-windows').Service;
const path = require('path');
const { execSync } = require('child_process');

const svc = new Service({
  name: 'Normanton Nexus',
  description: 'Enterprise bridge service for SAP and SQL Server integration for Kongsberg Normanton',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: [
    '--max_old_space_size=4096'
  ],
  stopparentfirst: true,
});

svc.on('install', () => {
  console.log('Service installed — starting…');
  svc.start();
});

// Service was already registered — just ensure it is running.
svc.on('alreadyinstalled', () => {
  console.log('Service already installed — starting…');
  svc.start();
});

svc.on('start', () => {
  console.log('Service started successfully.');
  configureFailureRecovery();
});

// Defense in depth: tell the Windows Service Control Manager itself to
// restart the service automatically on ANY crash, not just ones caught
// during a scheduled deploy (deploy-runner.cjs's own restart-verification
// only runs during a deploy — this covers the service dying at any other
// time, e.g. an unhandled exception hours later). Safe to re-run; sc.exe
// just overwrites the existing recovery config. Requires admin rights,
// same as the install itself — failures here are logged but non-fatal.
//
// sc.exe needs the SERVICE's actual registered key name, not its display
// name — 'Normanton Nexus' works fine for net start/net stop (which do
// resolve display names) but sc.exe does not, and fails with
// 'OpenService FAILED 1060: The specified service does not exist' if you
// pass it the display name. Resolve the real key via Get-Service first.
const DISPLAY_NAME = 'Normanton Nexus';

function resolveServiceKeyName(displayName) {
  try {
    const psCmd = "(Get-Service | Where-Object { $_.DisplayName -eq '" + displayName + "' }).Name";
    const out = execSync(
      'powershell -NoProfile -Command "' + psCmd + '"',
      { encoding: 'utf8' }
    ).trim();
    return out || null;
  } catch (err) {
    console.warn('Could not resolve service key name via Get-Service:', err.message);
    return null;
  }
}

function configureFailureRecovery() {
  const serviceKey = resolveServiceKeyName(DISPLAY_NAME) || DISPLAY_NAME;
  try {
    // reset=86400: forgive past failures after 24h of good uptime, so a
    // stale failure count from weeks ago doesn't count against the
    // restart/restart/restart action sequence below.
    // actions: restart after 15s, then 30s, then 60s for the 3rd+ failure
    // in that window.
    execSync(
      'sc failure "' + serviceKey + '" reset= 86400 actions= restart/15000/restart/30000/restart/60000',
      { encoding: 'utf8' }
    );
    execSync('sc failureflag "' + serviceKey + '" 1', { encoding: 'utf8' });
    console.log('Configured Windows Service auto-restart-on-crash recovery for "' + serviceKey + '".');
  } catch (err) {
    console.warn(
      'Could not configure sc failure recovery automatically for "' + serviceKey + '" (run install.cjs elevated, or set it manually):',
      err.message
    );
  }
}

svc.on('error', err => {
  console.error('Service error:', err);
});

svc.install();

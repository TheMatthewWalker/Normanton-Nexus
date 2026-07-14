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
function configureFailureRecovery() {
  try {
    // reset=86400: forgive past failures after 24h of good uptime, so a
    // stale failure count from weeks ago doesn't count against the
    // restart/restart/restart action sequence below.
    // actions: restart after 15s, then 30s, then 60s for the 3rd+ failure
    // in that window.
    execSync(
      'sc failure "Normanton Nexus" reset= 86400 actions= restart/15000/restart/30000/restart/60000',
      { encoding: 'utf8' }
    );
    execSync('sc failureflag "Normanton Nexus" 1', { encoding: 'utf8' });
    console.log('Configured Windows Service auto-restart-on-crash recovery.');
  } catch (err) {
    console.warn(
      'Could not configure sc failure recovery automatically (run install.cjs elevated, or set it manually):',
      err.message
    );
  }
}

svc.on('error', err => {
  console.error('Service error:', err);
});

svc.install();

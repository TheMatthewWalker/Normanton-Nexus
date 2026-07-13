const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'Normanton Nexus',
  script: path.join(__dirname, 'server.js'),
});

svc.on('stop', () => {
  console.log('Service stopped — uninstalling…');
  svc.uninstall();
});

svc.on('uninstall', () => {
  console.log('Service uninstalled successfully.');
});

svc.on('error', err => {
  console.error('Error:', err);
});

// Stop first; the 'stop' event will trigger uninstall.
// If the service is already stopped this fires immediately.
console.log('Stopping service…');
svc.stop();

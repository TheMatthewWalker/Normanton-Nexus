const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'Normanton Nexus',
  script: path.join(__dirname, 'server.js'),
});

svc.on('stop', () => {
  console.log('Service stopped — restarting…');
  svc.start();
});

svc.on('start', () => {
  console.log('Service restarted successfully.');
});

svc.on('error', err => {
  console.error('Service error:', err);
});

console.log('Stopping service…');
svc.stop();

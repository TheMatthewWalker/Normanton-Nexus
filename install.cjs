const Service = require('node-windows').Service;
const path = require('path');

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
});

svc.on('error', err => {
  console.error('Service error:', err);
});

svc.install();

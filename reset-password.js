/**
 * generate-superadmin.js
 *
 * One-time helper script — run this to generate a bcrypt hash for your
 * initial superadmin password, then paste the output into 001_create_users.sql
 * before running the migration.
 *
 * Usage:
 *   node generate-superadmin.js
 *
 * It will prompt for a password and print the hash to copy into the SQL file.
 */

import bcrypt   from 'bcrypt';
import readline from 'readline';

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

// Hide input while typing (basic — works on most terminals)
function promptPassword(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const stdin = process.openStdin();
    process.stdin.resume();
    process.stdin.setRawMode?.(true);
    let password = '';
    process.stdin.on('data', chunk => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdout.write('\n');
        stdin.pause();
        resolve(password);
      } else if (char === '\b' || char.charCodeAt(0) === 127) {
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    });
  });
}

// Hide input while typing (basic — works on most terminals)
function promptUsername(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const stdin = process.openStdin();
    process.stdin.resume();
    process.stdin.setRawMode?.(true);
    let username = '';
    process.stdin.on('data', chunk => {
      const char = chunk.toString();
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode?.(false);
        process.stdout.write('\n');
        stdin.pause();
        resolve(username);
      } else if (char === '\b' || char.charCodeAt(0) === 127) {
        username = username.slice(0, -1);
      } else {
        username += char;
      }
    });
  });
}

async function main() {
  console.log('\n── Kongsberg Portal — Superadmin hash generator ──\n');

  const username = await promptUsername('Enter Username: ')
  const password = await promptPassword('Enter Password: ');

  if (password.length < 10) {
    console.error('\n✕ Password must be at least 10 characters.');
    process.exit(1);
  }

  // Cost factor 12 is the recommended minimum for bcrypt in 2024+
  const hash = await bcrypt.hash(password, 12);

  console.log('\n✔ Copy this hash into 001_create_users.sql:\n');
  console.log(hash);
  console.log('\nReplace the line:');
  console.log("  '$2b$12$PLACEHOLDER_REPLACE_WITH_REAL_HASH'");
  console.log('with:');
  console.log(`  '${hash}'\n`);

  rl.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

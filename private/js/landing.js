'use strict';

const shell = document.getElementById('gemini-shell');
const openBtn = document.getElementById('btn-gemini-chat');
const closeBtn = document.getElementById('gemini-close');
const form = document.getElementById('gemini-form');
const input = document.getElementById('gemini-input');
const messages = document.getElementById('gemini-messages');
const statusEl = document.getElementById('gemini-status');
const sendBtn = document.getElementById('gemini-send');



(async () => {
  try {
    const session = await fetch('/session-check').then(r => r.json());
    if (!session.loggedIn) {
      window.location.href = '/';
      return;
    }
    document.getElementById('session-user').textContent = session.username.split('.')[0].toProperCase(); // Show the first name (username before the dot)
    const heroName = document.getElementById('hero-username');
    if (heroName) heroName.textContent = session.username.split('.')[0].toProperCase(); // Show first name in hero section, properly capitalized
  } catch {
    window.location.href = '/';
  }
})();

openBtn.addEventListener('click', () => {
  shell.classList.remove('hidden');
  input.focus();
});

closeBtn.addEventListener('click', () => {
  shell.classList.add('hidden');
  statusEl.textContent = '';
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) return;

  appendMessage(question, 'user');
  input.value = '';
  statusEl.textContent = 'Waiting for Gemini...';
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/gemini/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok || data.success === false) {
      throw new Error(data.error || res.statusText || `HTTP ${res.status}`);
    }

    appendMessage(data.answer || 'No response returned.', 'assistant');
    statusEl.textContent = '';
  } catch (err) {
    appendMessage('Sorry, it appears I am currently unavailable. Please try again later.', 'assistant');
    statusEl.textContent = 'Request failed';
    console.log('Gemini API error:', err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function appendMessage(text, role) {
  const row = document.createElement('div');
  row.className = `gemini-row gemini-row--${role}`;

  const bubble = document.createElement('div');
  bubble.className = `gemini-bubble gemini-bubble--${role}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}


// Source - https://stackoverflow.com/a/5574446
// Posted by Tuan
// Retrieved 2026-05-08, License - CC BY-SA 2.5

String.prototype.toProperCase = function () {
    return this.replace(/\w\S*/g, function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();});
};

(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const error = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const spinner = btn.querySelector('.spinner-border');
  const password = document.getElementById('password');
  // The server redirect keeps the URL fragment, so a deep link like /#/members arrives
  // here as /login?next=%2F#/members. Carry the fragment through sign-in.
  let next = new URLSearchParams(location.search).get('next') || '/';
  if (!next.includes('#') && location.hash) next += location.hash;

  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      document.getElementById('library-name').textContent = info.libraryName;
      document.title = `Sign in · ${info.libraryName}`;
    })
    .catch(() => {});

  document.getElementById('toggle-password').addEventListener('click', (e) => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    const icon = e.currentTarget.querySelector('i');
    icon.classList.toggle('bi-eye', !show);
    icon.classList.toggle('bi-eye-slash', show);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.classList.add('was-validated');
      return;
    }
    error.classList.add('d-none');
    btn.disabled = true;
    spinner.classList.remove('d-none');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value, password: password.value, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || 'Sign in failed. Please try again.');
      location.href = data.next || '/';
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('d-none');
      password.value = '';
      password.focus();
      btn.disabled = false;
      spinner.classList.add('d-none');
    }
  });
})();

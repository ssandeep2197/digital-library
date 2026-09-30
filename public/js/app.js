/* Staff dashboard for the Digital Library API. Plain JS, hash routing, Bootstrap 5. */
(() => {
  'use strict';

  const view = document.getElementById('view');
  let info = { libraryName: 'Digital Library', authEnabled: false, user: null, policy: {} };

  // ---- Helpers ---------------------------------------------------------------------

  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const money = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;
  const qs = (params) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined && v !== false) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const STATUS_LABEL = { available: 'Available', on_loan: 'On loan', on_hold: 'On hold', maintenance: 'Maintenance', lost: 'Lost' };
  const copyBadge = (s) => `<span class="badge status-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
  const NOTIF_BADGE = { sent: 'success', pending: 'secondary', failed: 'danger' };
  const RES_BADGE = { ready: 'warning text-dark', waiting: 'info text-dark' };
  const empty = (cols, text) => `<tr><td colspan="${cols}" class="empty">${esc(text)}</td></tr>`;

  // ---- API ---------------------------------------------------------------------------

  // Session expired or signed out elsewhere: go to the login page and come back here afterwards.
  const redirectToLogin = () => {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
  };

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.error?.message || `Request failed (${status})`);
      this.status = status;
      this.code = body?.error?.code;
    }
  }

  async function api(method, path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, data);
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  // ---- UI primitives -----------------------------------------------------------------

  function toast(message, variant = 'success') {
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${variant} border-0`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
    document.getElementById('toasts').appendChild(el);
    const t = new bootstrap.Toast(el, { delay: variant === 'danger' ? 7000 : 4000 });
    el.addEventListener('hidden.bs.toast', () => el.remove());
    t.show();
  }

  const fail = (err) => { if (err.status !== 401) toast(err.message, 'danger'); };

  // Runs an action from a button, disabling it meanwhile, then refreshes the view.
  async function act(button, fn, success) {
    if (button) button.disabled = true;
    try {
      const result = await fn();
      if (success) toast(typeof success === 'function' ? success(result) : success);
      await render();
      return result;
    } catch (err) {
      fail(err);
    } finally {
      if (button) button.disabled = false;
    }
  }

  const modalEl = document.getElementById('form-modal');
  const modal = new bootstrap.Modal(modalEl);
  let modalSubmit = null;

  // fields: [{ name, label, type, value, required, options, help, placeholder, datalist }]
  function openForm({ title, fields, submitLabel = 'Save', onSubmit }) {
    document.getElementById('form-modal-title').textContent = title;
    document.getElementById('form-modal-submit').textContent = submitLabel;
    document.getElementById('form-modal-error').textContent = '';
    document.getElementById('form-modal-body').innerHTML = fields.map(fieldHtml).join('');
    modalSubmit = onSubmit;
    modal.show();
    modalEl.addEventListener('shown.bs.modal', () => modalEl.querySelector('input, select, textarea')?.focus(), { once: true });
  }

  function fieldHtml(f) {
    const id = `f-${f.name}`;
    const req = f.required ? 'required' : '';
    if (f.type === 'checkbox') {
      return `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}>
        <label class="form-check-label" for="${id}">${esc(f.label)}</label></div>`;
    }
    let input;
    if (f.type === 'select') {
      input = `<select class="form-select" id="${id}" name="${f.name}" ${req}>${f.options
        .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    } else if (f.type === 'textarea') {
      input = `<textarea class="form-control" id="${id}" name="${f.name}" rows="3" ${req}>${esc(f.value)}</textarea>`;
    } else {
      input = `<input class="form-control" id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value)}"
        placeholder="${esc(f.placeholder)}" ${req} ${f.datalist ? `list="${f.datalist}"` : ''} autocomplete="off">`;
    }
    return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}${f.required ? ' <span class="text-danger">*</span>' : ''}</label>
      ${input}${f.help ? `<div class="form-text">${esc(f.help)}</div>` : ''}</div>`;
  }

  document.getElementById('form-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      values[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    const btn = document.getElementById('form-modal-submit');
    btn.disabled = true;
    try {
      await modalSubmit(values);
      modal.hide();
      await render();
    } catch (err) {
      document.getElementById('form-modal-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = '/login';
    }
  });

  // Member lookup: an input with a datalist of "Name (email) #id" suggestions.
  async function fillMemberList(listId, q) {
    const list = document.getElementById(listId);
    if (!list) return;
    try {
      const { items } = await api('GET', `/api/members${qs({ q, limit: 20 })}`);
      list.innerHTML = items.map((m) => `<option value="${esc(`${m.name} (${m.email}) #${m.id}`)}"></option>`).join('');
    } catch { /* suggestions are optional */ }
  }
  function wireMemberPicker(input, listId) {
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => fillMemberList(listId, input.value.replace(/\s*#\d+$/, '')), 200);
    });
    fillMemberList(listId, '');
  }
  function memberIdFrom(value) {
    const m = String(value).match(/#(\d+)\s*$/) || String(value).match(/^\s*(\d+)\s*$/);
    if (!m) throw new Error('Pick a member from the list (or type a member ID).');
    return Number(m[1]);
  }

  // ---- Views -------------------------------------------------------------------------

  const routes = [
    [/^#\/catalog$/, catalogView, 'catalog'],
    [/^#\/books\/(\d+)$/, bookView, 'catalog'],
    [/^#\/desk$/, deskView, 'desk'],
    [/^#\/members$/, membersView, 'members'],
    [/^#\/members\/(\d+)$/, memberView, 'members'],
    [/^#\/notifications$/, notificationsView, 'notifications'],
  ];

  // Per-view UI state that should survive re-renders (filters, search terms).
  const state = {
    catalog: { q: '', genre: '', available: false, page: 1 },
    members: { q: '', page: 1 },
    loans: 'open',
    notifications: { status: '', channel: '', page: 1 },
    lastReturn: null,
  };

  async function render() {
    const hash = location.hash || '#/catalog';
    const route = routes.find(([re]) => re.test(hash));
    if (!route) { location.hash = '#/catalog'; return; }
    const [re, fn, nav] = route;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    try {
      await fn(...hash.match(re).slice(1));
    } catch (err) {
      if (err.status !== 401) view.innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
    }
  }

  function pager(page, limit, total, onPage) {
    const pages = Math.max(1, Math.ceil(total / limit));
    if (pages <= 1) return '';
    setTimeout(() => {
      view.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => onPage(Number(b.dataset.page))));
    });
    return `<div class="d-flex justify-content-between align-items-center mt-2 small text-body-secondary">
      <span>Page ${page} of ${pages} · ${total} total</span>
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-secondary" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn btn-outline-secondary" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button>
      </div></div>`;
  }

  // Catalog -------------------------------------------------------------------------

  async function catalogView() {
    const s = state.catalog;
    const data = await api('GET', `/api/books${qs({ q: s.q, genre: s.genre, available: s.available ? 'true' : '', page: s.page, limit: 20 })}`);
    view.innerHTML = `
      <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
        <h1 class="h3 mb-0 me-auto">Catalog</h1>
        <button class="btn btn-primary" id="add-book"><i class="bi bi-plus-lg me-1"></i>Add book</button>
      </div>
      <form class="card card-body mb-3" id="search">
        <div class="row g-2 align-items-center">
          <div class="col-md-6"><input class="form-control" name="q" placeholder="Search title, author or ISBN" value="${esc(s.q)}" aria-label="Search"></div>
          <div class="col-md-3"><input class="form-control" name="genre" placeholder="Genre" value="${esc(s.genre)}" aria-label="Genre"></div>
          <div class="col-md-2"><div class="form-check"><input class="form-check-input" type="checkbox" id="avail" name="available" ${s.available ? 'checked' : ''}>
            <label class="form-check-label" for="avail">Available now</label></div></div>
          <div class="col-md-1 d-grid"><button class="btn btn-outline-primary" type="submit">Search</button></div>
        </div>
      </form>
      <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
        <thead><tr><th>Title</th><th>Author</th><th>Genre</th><th>ISBN</th><th class="text-end">Availability</th></tr></thead>
        <tbody>${data.items.length ? data.items.map((b) => `
          <tr data-href="#/books/${b.id}">
            <td class="fw-semibold">${esc(b.title)}</td><td>${esc(b.author)}</td><td>${esc(b.genre || '—')}</td>
            <td class="barcode">${esc(b.isbn || '—')}</td>
            <td class="text-end">${b.totalCopies === 0 ? '<span class="badge text-bg-light">No copies</span>'
              : `<span class="badge ${b.availableCopies ? 'text-bg-success' : 'text-bg-secondary'}">${b.availableCopies} of ${b.totalCopies} available</span>`}</td>
          </tr>`).join('') : empty(5, 'No books match your search.')}
        </tbody></table></div></div>
      ${pager(data.page, data.limit, data.total, (p) => { s.page = p; render(); })}`;

    view.querySelector('#search').onsubmit = (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      Object.assign(s, { q: f.q.value.trim(), genre: f.genre.value.trim(), available: f.available.checked, page: 1 });
      render();
    };
    view.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
    view.querySelector('#add-book').onclick = () => bookForm();
  }

  function bookForm(book) {
    openForm({
      title: book ? 'Edit book' : 'Add book',
      fields: [
        { name: 'title', label: 'Title', required: true, value: book?.title },
        { name: 'author', label: 'Author', required: true, value: book?.author },
        { name: 'isbn', label: 'ISBN', value: book?.isbn, help: 'ISBN-10 or ISBN-13; dashes are fine.' },
        { name: 'publisher', label: 'Publisher', value: book?.publisher },
        { name: 'publishedYear', label: 'Year published', type: 'number', value: book?.publishedYear },
        { name: 'genre', label: 'Genre', value: book?.genre },
        { name: 'description', label: 'Description', type: 'textarea', value: book?.description },
      ],
      onSubmit: async (v) => {
        const body = { ...v, publishedYear: v.publishedYear || null };
        if (book) {
          await api('PATCH', `/api/books/${book.id}`, body);
          toast('Book updated');
        } else {
          const created = await api('POST', '/api/books', body);
          toast(`Added “${created.title}”. Now add its copies.`);
          location.hash = `#/books/${created.id}`;
        }
      },
    });
  }

  async function bookView(id) {
    const [book, avail] = await Promise.all([api('GET', `/api/books/${id}`), api('GET', `/api/books/${id}/availability`)]);
    const [copies, queue] = await Promise.all([api('GET', `/api/books/${id}/copies`), api('GET', `/api/books/${id}/reservations`)]);
    const c = avail.copies;
    const stat = (value, label, cls = '') => `<div class="col-6 col-md"><div class="card card-body stat h-100"><div class="value ${cls}">${value}</div><div class="label">${label}</div></div></div>`;

    view.innerHTML = `
      <nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="#/catalog">Catalog</a></li><li class="breadcrumb-item active">${esc(book.title)}</li></ol></nav>
      <div class="d-flex flex-wrap gap-2 align-items-start mb-3">
        <div class="me-auto">
          <h1 class="h3 mb-1">${esc(book.title)}</h1>
          <div class="text-body-secondary">${esc(book.author)}${book.publishedYear ? ` · ${book.publishedYear}` : ''}${book.publisher ? ` · ${esc(book.publisher)}` : ''}${book.genre ? ` · ${esc(book.genre)}` : ''}${book.isbn ? ` · ISBN <span class="barcode">${esc(book.isbn)}</span>` : ''}</div>
          ${book.description ? `<p class="mt-2 mb-0">${esc(book.description)}</p>` : ''}
        </div>
        <button class="btn btn-outline-secondary" id="edit-book"><i class="bi bi-pencil me-1"></i>Edit</button>
        <button class="btn btn-outline-danger" id="delete-book" title="Only books without copies can be deleted"><i class="bi bi-trash"></i></button>
      </div>

      <div class="row g-3 mb-4">
        ${stat(c.available, 'Available', c.available ? 'text-success' : '')}
        ${stat(c.on_loan, 'On loan')}
        ${stat(c.on_hold, 'On hold')}
        ${stat(avail.waitingReservations, 'Waiting')}
        ${stat(fmtDate(avail.nextDueAt), 'Next due back')}
      </div>

      <div class="row g-4">
        <div class="col-lg-7">
          <div class="card">
            <div class="card-header bg-white d-flex align-items-center"><h2 class="h6 mb-0 me-auto">Copies</h2>
              <button class="btn btn-sm btn-primary" id="add-copy"><i class="bi bi-plus-lg me-1"></i>Add copy</button></div>
            <div class="table-responsive"><table class="table mb-0">
              <thead><tr><th>Barcode</th><th>Status</th><th>Location</th><th>Details</th><th></th></tr></thead>
              <tbody>${copies.items.length ? copies.items.map((cp) => `
                <tr>
                  <td class="barcode">${esc(cp.barcode)}</td>
                  <td>${copyBadge(cp.status)}</td>
                  <td>${esc(cp.location || '—')}</td>
                  <td class="small">${cp.status === 'on_loan' ? `Due ${fmtDate(cp.dueAt)}` : cp.status === 'on_hold' ? `Held until ${fmtDate(cp.holdExpiresAt)}` : ''}</td>
                  <td class="text-end">
                    <div class="dropdown">
                      <button class="btn btn-sm btn-light" data-bs-toggle="dropdown" aria-label="Copy actions"><i class="bi bi-three-dots"></i></button>
                      <ul class="dropdown-menu dropdown-menu-end">
                        ${['available', 'maintenance', 'lost'].filter((s) => s !== cp.status && cp.status !== 'on_loan')
                          .map((s) => `<li><button class="dropdown-item" data-copy="${cp.id}" data-status="${s}">Mark ${STATUS_LABEL[s].toLowerCase()}</button></li>`).join('')}
                        ${cp.status === 'on_loan' ? '<li><span class="dropdown-item-text small text-body-secondary">Check it in first to change status</span></li>' : ''}
                        <li><button class="dropdown-item" data-copy-loc="${cp.id}" data-loc="${esc(cp.location || '')}">Change location</button></li>
                      </ul>
                    </div>
                  </td>
                </tr>`).join('') : empty(5, 'No copies yet. Add one to make this book borrowable.')}
              </tbody></table></div>
          </div>
        </div>

        <div class="col-lg-5">
          <div class="card">
            <div class="card-header bg-white d-flex align-items-center"><h2 class="h6 mb-0 me-auto">Reservation queue</h2>
              <button class="btn btn-sm btn-primary" id="reserve"><i class="bi bi-bookmark-plus me-1"></i>Reserve</button></div>
            <ul class="list-group list-group-flush">
              ${queue.items.length ? queue.items.map((r) => `
                <li class="list-group-item d-flex align-items-center gap-2">
                  <span class="badge text-bg-${RES_BADGE[r.status]} align-self-center">${r.status === 'ready' ? 'Ready' : `#${r.position}`}</span>
                  <div class="me-auto"><a href="#/members/${r.memberId}">${esc(r.memberName)}</a>
                    <div class="small text-body-secondary">${r.status === 'ready' ? `Copy <span class="barcode">${esc(r.barcode)}</span> held until ${fmtDate(r.expiresAt)}` : `Since ${fmtDate(r.createdAt)}`}</div></div>
                  <button class="btn btn-sm btn-outline-danger" data-cancel="${r.reservationId}" title="Cancel reservation"><i class="bi bi-x-lg"></i></button>
                </li>`).join('') : '<li class="list-group-item empty">Nobody is waiting.</li>'}
            </ul>
          </div>
        </div>
      </div>`;

    view.querySelector('#edit-book').onclick = () => bookForm(book);
    view.querySelector('#delete-book').onclick = async (e) => {
      if (!confirm(`Delete “${book.title}”? This cannot be undone.`)) return;
      e.currentTarget.disabled = true;
      try {
        await api('DELETE', `/api/books/${book.id}`);
        toast('Book deleted');
        location.hash = '#/catalog';
      } catch (err) { fail(err); e.currentTarget.disabled = false; }
    };
    view.querySelector('#add-copy').onclick = () => openForm({
      title: `Add a copy of “${book.title}”`,
      fields: [
        { name: 'barcode', label: 'Barcode', required: true, placeholder: 'Scan or type the barcode' },
        { name: 'location', label: 'Shelf location', placeholder: 'e.g. Shelf F2' },
      ],
      onSubmit: async (v) => { await api('POST', `/api/books/${book.id}/copies`, v); toast(`Copy ${v.barcode} added`); },
    });
    view.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () =>
      act(b, () => api('PATCH', `/api/copies/${b.dataset.copy}`, { status: b.dataset.status }),
        (r) => (r.heldFor ? `Copy put on hold for member #${r.heldFor.memberId} (next in queue)` : `Copy marked ${STATUS_LABEL[r.status].toLowerCase()}`))));
    view.querySelectorAll('[data-copy-loc]').forEach((b) => (b.onclick = () => openForm({
      title: 'Change location',
      fields: [{ name: 'location', label: 'Shelf location', value: b.dataset.loc }],
      onSubmit: async (v) => { await api('PATCH', `/api/copies/${b.dataset.copyLoc}`, { location: v.location || null }); toast('Location updated'); },
    })));
    view.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => {
      if (!confirm('Cancel this reservation?')) return;
      act(b, () => api('DELETE', `/api/reservations/${b.dataset.cancel}`),
        (r) => (r.passedTo ? `Reservation cancelled; copy passed to member #${r.passedTo.memberId}` : 'Reservation cancelled'));
    }));
    view.querySelector('#reserve').onclick = () => {
      openForm({
        title: `Reserve “${book.title}”`,
        submitLabel: 'Reserve',
        fields: [{ name: 'member', label: 'Member', required: true, datalist: 'res-members', placeholder: 'Start typing a name or email' }],
        onSubmit: async (v) => {
          const r = await api('POST', '/api/reservations', { bookId: book.id, memberId: memberIdFrom(v.member) });
          toast(r.status === 'ready' ? `A copy (${r.barcode}) is on hold, ready for pickup` : `Reserved: #${r.position} in the queue`);
        },
      });
      ensureDatalist('res-members');
      wireMemberPicker(document.getElementById('f-member'), 'res-members');
    };
  }

  function ensureDatalist(id) {
    if (!document.getElementById(id)) {
      const dl = document.createElement('datalist');
      dl.id = id;
      document.body.appendChild(dl);
    }
  }

  // Circulation desk ----------------------------------------------------------------

  async function deskView() {
    const status = state.loans;
    const loans = await api('GET', `/api/loans${qs({ status, limit: 100 })}`);
    const now = Date.now();
    const lr = state.lastReturn;

    view.innerHTML = `
      <div class="d-flex align-items-center mb-3"><h1 class="h3 mb-0 me-auto">Circulation desk</h1></div>
      <div class="row g-4 mb-4">
        <div class="col-md-6">
          <form class="card card-body h-100" id="checkout">
            <h2 class="h5"><i class="bi bi-box-arrow-right me-2 text-primary"></i>Check out</h2>
            <label class="form-label" for="co-member">Member</label>
            <input class="form-control mb-2" id="co-member" list="desk-members" placeholder="Start typing a name or email" autocomplete="off" required>
            <label class="form-label" for="co-barcode">Copy barcode</label>
            <input class="form-control mb-3 barcode" id="co-barcode" placeholder="Scan barcode" autocomplete="off" required>
            <button class="btn btn-primary mt-auto" type="submit">Check out</button>
          </form>
        </div>
        <div class="col-md-6">
          <form class="card card-body h-100" id="checkin">
            <h2 class="h5"><i class="bi bi-box-arrow-in-left me-2 text-success"></i>Return</h2>
            <label class="form-label" for="ci-barcode">Copy barcode</label>
            <input class="form-control mb-3 barcode" id="ci-barcode" placeholder="Scan barcode" autocomplete="off" required>
            <button class="btn btn-success" type="submit">Check in</button>
            ${lr ? `<div class="alert ${lr.heldFor ? 'alert-warning' : 'alert-light'} mt-3 mb-0 small">
              <strong>${esc(lr.title)}</strong> (<span class="barcode">${esc(lr.barcode)}</span>) returned.
              ${lr.fineCents ? `<br><i class="bi bi-cash-coin me-1"></i>${lr.daysOverdue} day(s) late, fine <strong>${money(lr.fineCents)}</strong>.` : ''}
              ${lr.heldFor ? `<br><i class="bi bi-bookmark-star me-1"></i><strong>Put on the hold shelf</strong> for <a href="#/members/${lr.heldFor.memberId}">member #${lr.heldFor.memberId}</a> until ${fmtDate(lr.heldFor.expiresAt)}. They've been notified.`
                : '<br>Return it to the shelf.'}
            </div>` : ''}
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-header bg-white">
          <ul class="nav nav-tabs card-header-tabs">
            ${['open', 'overdue', 'returned'].map((s) => `<li class="nav-item"><button class="nav-link ${s === status ? 'active' : ''}" data-tab="${s}">${s[0].toUpperCase() + s.slice(1)}</button></li>`).join('')}
          </ul>
        </div>
        <div class="table-responsive"><table class="table mb-0">
          <thead><tr><th>Title</th><th>Barcode</th><th>Member</th><th>Checked out</th><th>${status === 'returned' ? 'Returned' : 'Due'}</th><th></th></tr></thead>
          <tbody>${loans.items.length ? loans.items.map((l) => {
            const late = !l.returnedAt && new Date(l.dueAt).getTime() < now;
            return `<tr>
              <td>${esc(l.title)}</td><td class="barcode">${esc(l.barcode)}</td>
              <td><a href="#/members/${l.memberId}">${esc(l.memberName)}</a></td>
              <td>${fmtDate(l.checkedOutAt)}</td>
              <td>${status === 'returned' ? fmtDate(l.returnedAt) : `<span class="${late ? 'text-danger fw-semibold' : ''}">${fmtDate(l.dueAt)}</span>${late ? ' <span class="badge text-bg-danger">Overdue</span>' : ''}`}</td>
              <td class="text-end">${status !== 'returned' ? `
                ${late ? '' : `<button class="btn btn-sm btn-outline-primary" data-renew="${l.loanId}">Renew</button>`}
                <button class="btn btn-sm btn-outline-success" data-return="${esc(l.barcode)}">Return</button>` : ''}</td>
            </tr>`;
          }).join('') : empty(6, status === 'overdue' ? 'Nothing is overdue.' : 'No loans.')}
          </tbody></table></div>
      </div>`;

    ensureDatalist('desk-members');
    wireMemberPicker(view.querySelector('#co-member'), 'desk-members');
    view.querySelector('#co-member').focus();

    view.querySelector('#checkout').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.currentTarget.querySelector('button');
      try {
        const memberId = memberIdFrom(view.querySelector('#co-member').value);
        await act(btn, () => api('POST', '/api/loans', { memberId, barcode: view.querySelector('#co-barcode').value.trim() }),
          (r) => `Checked out “${r.title}” — due ${fmtDate(r.dueAt)}`);
      } catch (err) { fail(err); }
    };
    const doReturn = async (barcode, btn) => {
      const r = await act(btn, async () => {
        const res = await api('POST', '/api/returns', { barcode });
        state.lastReturn = res;
        return res;
      }, (res) => (res.heldFor ? 'Returned — goes on the hold shelf' : 'Returned'));
      return r;
    };
    view.querySelector('#checkin').onsubmit = (e) => {
      e.preventDefault();
      doReturn(view.querySelector('#ci-barcode').value.trim(), e.currentTarget.querySelector('button'));
    };
    view.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.loans = b.dataset.tab; render(); }));
    view.querySelectorAll('[data-renew]').forEach((b) => (b.onclick = () =>
      act(b, () => api('POST', `/api/loans/${b.dataset.renew}/renew`), (r) => `Renewed — now due ${fmtDate(r.dueAt)} (${r.renewalsLeft} renewal(s) left)`)));
    view.querySelectorAll('[data-return]').forEach((b) => (b.onclick = () => doReturn(b.dataset.return, b)));
  }

  // Members -------------------------------------------------------------------------

  function memberForm(member) {
    openForm({
      title: member ? 'Edit member' : 'Add member',
      fields: [
        { name: 'name', label: 'Name', required: true, value: member?.name },
        { name: 'email', label: 'Email', type: 'email', required: true, value: member?.email },
        { name: 'phone', label: 'Mobile phone', type: 'tel', value: member?.phone, placeholder: '+15551234567', help: 'International format. Needed for SMS notifications.' },
        { name: 'notifyEmail', label: 'Send email notifications', type: 'checkbox', value: member ? member.notifyEmail : true },
        { name: 'notifySms', label: 'Send SMS notifications', type: 'checkbox', value: member ? member.notifySms : false },
        ...(member ? [{ name: 'status', label: 'Status', type: 'select', value: member.status, options: [['active', 'Active'], ['suspended', 'Suspended']] }] : []),
      ],
      onSubmit: async (v) => {
        const body = { ...v, phone: v.phone || null };
        if (member) {
          await api('PATCH', `/api/members/${member.id}`, body);
          toast('Member updated');
        } else {
          const m = await api('POST', '/api/members', body);
          toast(`Added ${m.name}`);
          location.hash = `#/members/${m.id}`;
        }
      },
    });
  }

  async function membersView() {
    const s = state.members;
    const data = await api('GET', `/api/members${qs({ q: s.q, page: s.page, limit: 25 })}`);
    view.innerHTML = `
      <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
        <h1 class="h3 mb-0 me-auto">Members</h1>
        <button class="btn btn-primary" id="add-member"><i class="bi bi-person-plus me-1"></i>Add member</button>
      </div>
      <form class="card card-body mb-3" id="search"><div class="input-group">
        <input class="form-control" name="q" placeholder="Search name, email or phone" value="${esc(s.q)}" aria-label="Search members">
        <button class="btn btn-outline-primary" type="submit">Search</button></div></form>
      <div class="card"><div class="table-responsive"><table class="table table-hover mb-0">
        <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Notifications</th><th>Status</th></tr></thead>
        <tbody>${data.items.length ? data.items.map((m) => `
          <tr data-href="#/members/${m.id}">
            <td class="fw-semibold">${esc(m.name)}</td><td>${esc(m.email)}</td><td>${esc(m.phone || '—')}</td>
            <td>${m.notifyEmail ? '<i class="bi bi-envelope me-2" title="Email"></i>' : ''}${m.notifySms ? '<i class="bi bi-phone" title="SMS"></i>' : ''}${!m.notifyEmail && !m.notifySms ? '<span class="text-body-secondary">Off</span>' : ''}</td>
            <td><span class="badge ${m.status === 'active' ? 'text-bg-success' : 'text-bg-danger'}">${esc(m.status)}</span></td>
          </tr>`).join('') : empty(5, 'No members found.')}
        </tbody></table></div></div>
      ${pager(data.page, data.limit, data.total, (p) => { s.page = p; render(); })}`;
    view.querySelector('#search').onsubmit = (e) => { e.preventDefault(); Object.assign(s, { q: e.currentTarget.q.value.trim(), page: 1 }); render(); };
    view.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => (location.hash = tr.dataset.href)));
    view.querySelector('#add-member').onclick = () => memberForm();
  }

  async function memberView(id) {
    const [acct, history, notifs] = await Promise.all([
      api('GET', `/api/members/${id}/account`),
      api('GET', `/api/members/${id}/history?limit=10`),
      api('GET', `/api/members/${id}/notifications?limit=10`),
    ]);
    const m = acct.member;
    const f = acct.fines;

    view.innerHTML = `
      <nav aria-label="breadcrumb"><ol class="breadcrumb"><li class="breadcrumb-item"><a href="#/members">Members</a></li><li class="breadcrumb-item active">${esc(m.name)}</li></ol></nav>
      <div class="d-flex flex-wrap gap-2 align-items-start mb-3">
        <div class="me-auto">
          <h1 class="h3 mb-1">${esc(m.name)} ${m.status !== 'active' ? '<span class="badge text-bg-danger align-middle fs-6">Suspended</span>' : ''}</h1>
          <div class="text-body-secondary"><i class="bi bi-envelope me-1"></i>${esc(m.email)}${m.phone ? ` · <i class="bi bi-phone me-1"></i>${esc(m.phone)}` : ''}
            · Notifications: ${[m.notifyEmail && 'email', m.notifySms && 'SMS'].filter(Boolean).join(' + ') || 'off'}</div>
        </div>
        <button class="btn btn-outline-secondary" id="edit-member"><i class="bi bi-pencil me-1"></i>Edit</button>
      </div>

      ${f.borrowingBlocked ? `<div class="alert alert-danger"><i class="bi bi-exclamation-octagon me-2"></i>Borrowing is blocked: this member owes ${money(f.totalCents)}.</div>` : ''}

      <div class="row g-4">
        <div class="col-lg-8">
          <div class="card mb-4">
            <div class="card-header bg-white"><h2 class="h6 mb-0">Checked out (${acct.loans.length})</h2></div>
            <div class="table-responsive"><table class="table mb-0">
              <thead><tr><th>Title</th><th>Barcode</th><th>Due</th><th>Fine</th><th></th></tr></thead>
              <tbody>${acct.loans.length ? acct.loans.map((l) => `
                <tr><td><a href="#/books/${l.bookId}">${esc(l.title)}</a><div class="small text-body-secondary">${esc(l.author)}</div></td>
                  <td class="barcode">${esc(l.barcode)}</td>
                  <td class="${l.overdue ? 'text-danger fw-semibold' : ''}">${fmtDate(l.dueAt)}${l.overdue ? `<div class="small">${l.daysOverdue} day(s) overdue</div>` : ''}</td>
                  <td>${l.accruedFineCents ? money(l.accruedFineCents) : '—'}</td>
                  <td class="text-end">${l.overdue ? '' : `<button class="btn btn-sm btn-outline-primary" data-renew="${l.loanId}">Renew</button>`}</td></tr>`).join('')
                : empty(5, 'Nothing checked out.')}
              </tbody></table></div>
          </div>

          <div class="card mb-4">
            <div class="card-header bg-white"><h2 class="h6 mb-0">Reservations (${acct.reservations.length})</h2></div>
            <ul class="list-group list-group-flush">${acct.reservations.length ? acct.reservations.map((r) => `
              <li class="list-group-item d-flex align-items-center gap-2">
                <span class="badge text-bg-${RES_BADGE[r.status]} align-self-center">${r.status === 'ready' ? 'Ready for pickup' : `#${r.position} in line`}</span>
                <div class="me-auto"><a href="#/books/${r.bookId}">${esc(r.title)}</a>
                  ${r.status === 'ready' ? `<div class="small text-body-secondary">Copy <span class="barcode">${esc(r.barcode)}</span> held until ${fmtDate(r.expiresAt)}</div>` : ''}</div>
                <button class="btn btn-sm btn-outline-danger" data-cancel="${r.reservationId}" title="Cancel"><i class="bi bi-x-lg"></i></button>
              </li>`).join('') : '<li class="list-group-item empty">No active reservations.</li>'}
            </ul>
          </div>

          <div class="card">
            <div class="card-header bg-white"><h2 class="h6 mb-0">Recent history</h2></div>
            <div class="table-responsive"><table class="table table-sm mb-0">
              <thead><tr><th>Title</th><th>Out</th><th>Returned</th><th>Fine</th></tr></thead>
              <tbody>${history.items.length ? history.items.map((h) => `
                <tr><td>${esc(h.title)}</td><td>${fmtDate(h.checkedOutAt)}</td><td>${h.returnedAt ? fmtDate(h.returnedAt) : '<span class="text-body-secondary">Out</span>'}</td>
                  <td>${h.fineCents ? `${money(h.fineCents)} ${h.finePaid ? '<span class="badge text-bg-light">paid</span>' : '<span class="badge text-bg-warning">unpaid</span>'}` : '—'}</td></tr>`).join('')
                : empty(4, 'No loans yet.')}
              </tbody></table></div>
          </div>
        </div>

        <div class="col-lg-4">
          <div class="card card-body mb-4">
            <h2 class="h6">Fines</h2>
            <dl class="row mb-2 small">
              <dt class="col-7 fw-normal">Unpaid (returned items)</dt><dd class="col-5 text-end mb-1">${money(f.unpaidCents)}</dd>
              <dt class="col-7 fw-normal">Accruing (overdue now)</dt><dd class="col-5 text-end mb-1">${money(f.accruingCents)}</dd>
              <dt class="col-7">Total</dt><dd class="col-5 text-end fw-semibold mb-0">${money(f.totalCents)}</dd>
            </dl>
            ${f.unpaidCents ? `<button class="btn btn-sm btn-outline-success" id="pay">Record payment of ${money(f.unpaidCents)}</button>` : ''}
          </div>

          <div class="card">
            <div class="card-header bg-white"><h2 class="h6 mb-0">Notifications sent</h2></div>
            <ul class="list-group list-group-flush small">${notifs.items.length ? notifs.items.map((n) => `
              <li class="list-group-item">
                <div class="d-flex gap-2"><i class="bi ${n.channel === 'sms' ? 'bi-phone' : 'bi-envelope'}"></i>
                  <span class="me-auto">${esc(n.subject || n.body)}</span>
                  <span class="badge text-bg-${NOTIF_BADGE[n.status]} align-self-start">${esc(n.status)}</span></div>
                <div class="text-body-secondary">${fmtDateTime(n.sentAt || n.createdAt)}${n.lastError ? ` · <span class="text-danger">${esc(n.lastError)}</span>` : ''}</div>
              </li>`).join('') : '<li class="list-group-item empty">None yet.</li>'}
            </ul>
          </div>
        </div>
      </div>`;

    view.querySelector('#edit-member').onclick = () => memberForm(m);
    view.querySelector('#pay')?.addEventListener('click', (e) => act(e.currentTarget, () => api('POST', `/api/members/${m.id}/fines/pay`), 'Payment recorded'));
    view.querySelectorAll('[data-renew]').forEach((b) => (b.onclick = () =>
      act(b, () => api('POST', `/api/loans/${b.dataset.renew}/renew`), (r) => `Renewed — now due ${fmtDate(r.dueAt)}`)));
    view.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = () => {
      if (confirm('Cancel this reservation?')) act(b, () => api('DELETE', `/api/reservations/${b.dataset.cancel}`), 'Reservation cancelled');
    }));
  }

  // Notifications -------------------------------------------------------------------

  async function notificationsView() {
    const s = state.notifications;
    const data = await api('GET', `/api/notifications${qs({ status: s.status, channel: s.channel, page: s.page, limit: 25 })}`);
    const opt = (v, l, cur) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`;
    view.innerHTML = `
      <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
        <h1 class="h3 mb-0 me-auto">Notifications</h1>
        <span class="small text-body-secondary">Email: ${esc(info.email || '?')} · SMS: ${esc(info.sms || '?')}</span>
        <button class="btn btn-outline-primary" id="run-jobs" title="Send due-soon reminders and overdue notices, expire old holds, and deliver pending messages now">
          <i class="bi bi-play-circle me-1"></i>Run reminders now</button>
      </div>
      <div class="card card-body mb-3"><div class="row g-2">
        <div class="col-sm-4"><select class="form-select" id="f-status" aria-label="Status">${opt('', 'All statuses', s.status)}${opt('pending', 'Pending', s.status)}${opt('sent', 'Sent', s.status)}${opt('failed', 'Failed', s.status)}</select></div>
        <div class="col-sm-4"><select class="form-select" id="f-channel" aria-label="Channel">${opt('', 'Email and SMS', s.channel)}${opt('email', 'Email', s.channel)}${opt('sms', 'SMS', s.channel)}</select></div>
      </div></div>
      <div class="card"><div class="table-responsive"><table class="table mb-0">
        <thead><tr><th>When</th><th>Type</th><th>To</th><th>Message</th><th>Status</th><th></th></tr></thead>
        <tbody>${data.items.length ? data.items.map((n) => `
          <tr>
            <td class="small text-nowrap">${fmtDateTime(n.sentAt || n.createdAt)}</td>
            <td class="small">${esc(n.type.replace(/_/g, ' '))}</td>
            <td class="small"><i class="bi ${n.channel === 'sms' ? 'bi-phone' : 'bi-envelope'} me-1"></i><a href="#/members/${n.memberId}">${esc(n.recipient)}</a></td>
            <td><details><summary class="small">${esc(n.subject || n.body.slice(0, 60))}</summary><div class="msg-body mt-1">${esc(n.body)}</div></details></td>
            <td><span class="badge text-bg-${NOTIF_BADGE[n.status]}">${esc(n.status)}</span>${n.attempts > 1 ? `<div class="small text-body-secondary">${n.attempts} attempts</div>` : ''}
              ${n.lastError ? `<div class="small text-danger">${esc(n.lastError)}</div>` : ''}</td>
            <td class="text-end">${n.status === 'failed' ? `<button class="btn btn-sm btn-outline-primary" data-retry="${n.id}">Retry</button>` : ''}</td>
          </tr>`).join('') : empty(6, 'No notifications.')}
        </tbody></table></div></div>
      ${data.items.length === data.limit || s.page > 1 ? `<div class="d-flex justify-content-end gap-2 mt-2">
        <button class="btn btn-sm btn-outline-secondary" id="prev" ${s.page <= 1 ? 'disabled' : ''}>Newer</button>
        <button class="btn btn-sm btn-outline-secondary" id="next" ${data.items.length < data.limit ? 'disabled' : ''}>Older</button></div>` : ''}`;

    view.querySelector('#f-status').onchange = (e) => { Object.assign(s, { status: e.target.value, page: 1 }); render(); };
    view.querySelector('#f-channel').onchange = (e) => { Object.assign(s, { channel: e.target.value, page: 1 }); render(); };
    view.querySelector('#prev')?.addEventListener('click', () => { s.page--; render(); });
    view.querySelector('#next')?.addEventListener('click', () => { s.page++; render(); });
    view.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = () => act(b, () => api('POST', `/api/notifications/${b.dataset.retry}/retry`), 'Queued for another attempt')));
    view.querySelector('#run-jobs').onclick = (e) => act(e.currentTarget, () => api('POST', '/api/jobs/run'),
      (r) => `Due-soon reminders: ${r.dueSoon} · Overdue notices: ${r.overdue} · Holds expired: ${r.expiredHolds} · Delivered: ${r.notificationsDispatched}`);
  }

  // ---- Boot --------------------------------------------------------------------------

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

  (async () => {
    try {
      info = await api('GET', '/api/info');
    } catch { /* fall back to defaults */ }
    document.getElementById('library-name').textContent = info.libraryName;
    document.title = info.libraryName;
    if (info.authEnabled && !info.user) return redirectToLogin();
    document.getElementById('user-name').textContent = info.user || '';
    document.getElementById('user-menu').classList.toggle('d-none', !info.authEnabled);
    render();
  })();
})();

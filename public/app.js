// @ts-check
import {api, ApiError, setCsrf} from './api.js';

/** @typedef {import('./api.js').User} User */
/** @typedef {import('./api.js').Assignee} Assignee */
/** @typedef {import('./api.js').RequestPage} RequestPage */
/** @typedef {import('./api.js').RequestDetail} RequestDetail */
/** @typedef {import('./api.js').HistoryEntry} HistoryEntry */
/** @typedef {import('./api.js').Session} Session */

/**
 * @template {Element} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function $(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error('The page is missing #' + id);
  return node;
}

const loginView = $('login-view', HTMLElement), appView = $('app-view', HTMLElement), boot = $('boot', HTMLElement);
const loginForm = $('login-form', HTMLFormElement), username = $('username', HTMLInputElement), password = $('password', HTMLInputElement), loginError = $('login-error', HTMLElement);
const userBox = $('user', HTMLElement), logoutButton = $('logout', HTMLButtonElement), appTitle = $('app-title', HTMLElement);
const message = $('message', HTMLElement), queue = $('queue', HTMLElement), count = $('count', HTMLElement), filters = $('filters', HTMLFormElement);
const assigneeFilter = $('assignee-filter', HTMLElement), list = $('requests', HTMLElement), record = $('record', HTMLElement);
const prev = $('prev', HTMLButtonElement), next = $('next', HTMLButtonElement), range = $('range', HTMLElement);
const dialog = $('create', HTMLDialogElement), createForm = $('create-form', HTMLFormElement), formError = $('form-error', HTMLElement);
const newButton = $('new', HTMLButtonElement), closeButton = $('close', HTMLButtonElement);
const assigneeSelect = /** @type {HTMLSelectElement} */ (filters.elements.namedItem('assignee'));

const PAGE_SIZE = 20;
const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
const ROLE_NAME = {requester: 'Requester', agent: 'Agent', admin: 'Admin'};
const format = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

/** @type {User | null} */
let me = null;
/** @type {Assignee[]} */
let assignees = [];
/** @type {number | null} */
let selected = null;
let offset = 0, listRun = 0, detailRun = 0;

/** @param {string} iso */
const when = iso => format.format(new Date(iso));
/** @param {string} text */
const slug = text => text.toLowerCase().replaceAll(' ', '-');
/** @param {string} text */
const note = text => { message.textContent = text; };

/**
 * Every value that came from the server goes into the page through textContent, so it can never be parsed as markup.
 * @param {string} tag
 * @param {string} [text]
 * @param {string} [cls]
 */
function el(tag, text = '', cls = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
/**
 * @param {string} text
 * @param {string} [cls]
 * @param {'button' | 'submit'} [type]
 */
function button(text, cls = '', type = 'button') {
  const node = document.createElement('button');
  node.type = type;
  node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
/** @param {string} status */
const pill = status => el('span', status, 'pill ' + slug(status));
/** @param {string} priority */
const priorityPill = priority => el('span', priority, 'pill priority-' + slug(priority));
/**
 * A labelled <select>.
 * @param {string} label
 * @param {[string, string][]} options value and text of each option
 * @param {string} current
 */
function choice(label, options, current) {
  const wrap = document.createElement('label'), select = document.createElement('select');
  wrap.append(label, select);
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = current;
  return {wrap, select};
}
/** @param {HistoryEntry} entry */
function describe(entry) {
  switch (entry.kind) {
    case 'opened': return 'Request opened';
    case 'status': return `${entry.from} → ${entry.to}`;
    case 'assigned': return entry.to ? `Assigned to ${entry.to}` : `Unassigned (was ${entry.from})`;
    case 'priority': return `Priority ${entry.from} → ${entry.to}`;
    case 'commented': return 'Comment added';
    default: return 'Updated';
  }
}

/** Shows what went wrong; a 401 while signed in means the session ended, so go back to the sign-in page. */
function failure(/** @type {unknown} */ error) {
  if (error instanceof ApiError && error.status === 401 && me) { showLogin('Your session has ended. Sign in again.'); return; }
  note(error instanceof Error ? error.message : 'Something went wrong.');
}

function showLogin(error = '', focus = true) {
  me = null; assignees = []; selected = null; offset = 0; setCsrf(''); filters.reset();
  boot.hidden = true; appView.hidden = true; loginView.hidden = false; userBox.hidden = true; logoutButton.hidden = true;
  list.replaceChildren(); record.replaceChildren(); note('');
  loginError.textContent = error;
  document.title = 'Sign in | Relay Desk';
  if (focus) username.focus();
}

/**
 * @param {Session} session
 * @param {boolean} focus move focus to the page heading (after an explicit sign-in)
 */
async function startSession(session, focus) {
  me = session.user;
  setCsrf(session.csrf_token);
  userBox.textContent = `${me.display_name} · ${ROLE_NAME[me.role]}`;
  userBox.hidden = false; logoutButton.hidden = false;
  const staff = me.role !== 'requester';
  assigneeFilter.hidden = !staff; assigneeSelect.disabled = !staff;   // agent-only controls are never rendered for requesters
  boot.hidden = true; loginView.hidden = true; appView.hidden = false;
  document.title = 'Service requests | Relay Desk';
  if (focus) appTitle.focus();
  if (staff) {
    try {
      assignees = (await api('/api/assignees')).items;
      while (assigneeSelect.options.length > 2) assigneeSelect.remove(2);   // keep Anyone and Unassigned
      for (const person of assignees) {
        const option = document.createElement('option');
        option.value = String(person.id);
        option.textContent = person.id === me.id ? person.display_name + ' (you)' : person.display_name;
        assigneeSelect.append(option);
      }
    } catch (error) { failure(error); }
  }
  await loadList();
}

/** @param {{focus?: boolean}} [options] focus the selected row when the list has loaded */
async function loadList({focus = false} = {}) {
  const run = ++listRun;
  queue.setAttribute('aria-busy', 'true');
  if (!list.children.length) list.replaceChildren(el('li', 'Loading requests…', 'empty'));
  const params = new URLSearchParams({sort: 'updated', order: 'desc', limit: String(PAGE_SIZE), offset: String(offset)});
  for (const [key, value] of new FormData(filters)) if (typeof value === 'string' && value) params.set(key, value);
  try {
    /** @type {RequestPage} */
    const page = await api('/api/requests?' + params);
    if (run !== listRun) return;
    if (!page.items.length && page.total > 0 && offset > 0) { offset = Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE; await loadList({focus}); return; }
    if (!page.items.some(item => item.id === selected)) selected = page.items[0]?.id ?? null;
    renderRows(page);
    await showDetail(selected);
    if (focus && selected !== null) /** @type {HTMLElement | null} */ (list.querySelector(`[data-id="${selected}"]`))?.focus();
  } catch (error) {
    if (run === listRun) renderListError(error);
  } finally {
    if (run === listRun) queue.removeAttribute('aria-busy');
  }
}

/** @param {RequestPage} page */
function renderRows(page) {
  count.textContent = `${page.total} ${page.total === 1 ? 'request' : 'requests'}`;
  range.textContent = page.total ? `${page.offset + 1}–${page.offset + page.items.length} of ${page.total}` : 'Nothing to show';
  prev.disabled = page.offset === 0;
  next.disabled = page.offset + page.items.length >= page.total;
  if (!page.items.length) { list.replaceChildren(el('li', 'No requests match the filters.', 'empty')); return; }
  list.replaceChildren(...page.items.map(item => {
    const row = button('', 'row'), text = el('span'), badges = el('span', '', 'badges');
    row.dataset['id'] = String(item.id);
    row.setAttribute('aria-pressed', String(item.id === selected));
    text.append(el('small', `SR-${item.id} / ${item.team}`), el('strong', item.title), el('small', `${item.priority} priority · ${item.assignee_name ?? 'Unassigned'}`, 'sub'));
    badges.append(pill(item.status));
    row.append(text, badges);
    row.addEventListener('click', () => {
      selected = item.id;
      for (const other of list.querySelectorAll('button.row')) other.setAttribute('aria-pressed', String(other === row));
      void showDetail(item.id);
    });
    const li = document.createElement('li');
    li.append(row);
    return li;
  }));
}

/** @param {unknown} error */
function renderListError(error) {
  if (error instanceof ApiError && error.status === 401) { failure(error); return; }
  const text = error instanceof Error ? error.message : 'The requests could not be loaded.';
  const item = el('li', text, 'empty'), retry = button('Try again');
  retry.addEventListener('click', () => { note(''); void loadList(); });
  item.append(retry);
  list.replaceChildren(item);
  note(text);
}

/** @param {number | null} id */
async function showDetail(id) {
  const run = ++detailRun;
  if (id === null) { record.replaceChildren(el('p', 'No request selected. Pick one from the queue, or create a request.', 'empty')); return; }
  try {
    /** @type {RequestDetail} */
    const item = await api('/api/requests/' + id);
    if (run !== detailRun) return;
    record.replaceChildren(...renderDetail(item));
  } catch (error) {
    if (run !== detailRun) return;
    if (error instanceof ApiError && error.status === 401) { failure(error); return; }
    record.replaceChildren(el('p', error instanceof ApiError && error.status === 404 ? 'This request is no longer available.' : error instanceof Error ? error.message : 'The request could not be loaded.', 'empty'));
  }
}

/** @param {RequestDetail} item */
function renderDetail(item) {
  const head = el('div', '', 'record-head'), title = el('div'), badges = el('div', '', 'badges');
  title.append(el('div', 'SR-' + item.id, 'record-id'), el('h2', item.title));
  badges.append(pill(item.status), priorityPill(item.priority));
  head.append(title, badges);
  const meta = el('dl', '', 'meta');
  for (const [name, value] of /** @type {[string, string][]} */ ([['Requester', item.requester], ['Team', item.team], ['Assignee', item.assignee_name ?? 'Unassigned'], ['Opened', when(item.created_at)]])) {
    const cell = el('div');
    cell.append(el('dt', name), el('dd', value));
    meta.append(cell);
  }
  const description = el('div', '', 'description');
  description.append(el('h3', 'Description'), el('p', item.description));
  const activity = el('div', '', 'activity'), timeline = el('ol');
  for (const entry of item.history) {
    const li = el('li');
    li.append(el('strong', describe(entry)), el('span', (entry.actor_name ? 'by ' + entry.actor_name + ' · ' : '') + when(entry.at)));
    timeline.append(li);
  }
  activity.append(el('h3', 'Activity'), timeline);
  return [head, meta, description, ...(me && me.role !== 'requester' ? [renderControls(item)] : []), activity, renderComments(item)];
}

/** The update form: only agents and admins ever get one. Only the fields that changed are sent, with the revision that was read. */
function renderControls(/** @type {RequestDetail} */ item) {
  const form = document.createElement('form');
  form.className = 'update';
  form.setAttribute('aria-label', 'Update request');
  const status = choice('Status', [item.status, ...item.next].map(value => [value, value]), item.status);
  const priority = choice('Priority', PRIORITIES.map(value => [value, value]), item.priority);
  const assignee = choice('Assignee', [['', 'Unassigned'], ...assignees.map(person => /** @type {[string, string]} */ ([String(person.id), person.display_name]))], item.assignee === null ? '' : String(item.assignee));
  const save = button('Save changes', 'primary', 'submit');
  form.append(status.wrap, priority.wrap, assignee.wrap, save);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    /** @type {Record<string, unknown>} */
    const changes = {};
    if (status.select.value !== item.status) changes['status'] = status.select.value;
    if (priority.select.value !== item.priority) changes['priority'] = priority.select.value;
    const chosen = assignee.select.value === '' ? null : Number(assignee.select.value);
    if (chosen !== item.assignee) changes['assignee'] = chosen;
    if (!Object.keys(changes).length) { note('Nothing to save: no field was changed.'); return; }
    save.disabled = true;
    try {
      await api('/api/requests/' + item.id, {method: 'PATCH', body: changes, revision: item.revision});
      await loadList();
      note(`SR-${item.id} updated.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) await loadList();   // show what the other person saved
      failure(error);
      save.disabled = false;
    }
  });
  return form;
}

function renderComments(/** @type {RequestDetail} */ item) {
  const box = el('div', '', 'comments');
  box.append(el('h3', 'Comments'));
  if (!item.comments.length) box.append(el('p', 'No comments yet.', 'muted'));
  else {
    const thread = el('ul', '', 'thread');
    for (const comment of item.comments) {
      const li = el('li'), line = el('div', '', 'who-line');
      line.append(el('strong', comment.author_name));
      if (comment.author_role !== 'requester') line.append(el('span', ROLE_NAME[comment.author_role], 'role'));
      line.append(el('span', when(comment.created_at), 'when'));
      li.append(line, el('p', comment.body));
      thread.append(li);
    }
    box.append(thread);
  }
  const form = el('form', '', 'comment-form'), label = document.createElement('label'), text = document.createElement('textarea'), post = button('Post comment', 'primary', 'submit');
  text.rows = 3; text.required = true; text.maxLength = 2000;
  label.append('Add a comment', text);
  form.append(label, post);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    post.disabled = true;
    try {
      await api(`/api/requests/${item.id}/comments`, {method: 'POST', body: {body: text.value}});
      await loadList();
      note(`Comment added to SR-${item.id}.`);
    } catch (error) { failure(error); post.disabled = false; }
  });
  box.append(form);
  return box;
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = /** @type {HTMLButtonElement} */ (loginForm.querySelector('[type=submit]'));
  submit.disabled = true;
  loginError.textContent = '';
  try {
    const session = await api('/api/login', {method: 'POST', body: {username: username.value.trim(), password: password.value}});
    password.value = '';
    await startSession(session, true);
  } catch (error) {
    password.value = '';
    if (error instanceof ApiError && error.status === 429) {
      const minutes = Math.max(1, Math.ceil((error.retryAfter ?? 900) / 60));
      loginError.textContent = `Too many failed sign-ins. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
    } else loginError.textContent = error instanceof Error ? error.message : 'Sign-in failed.';
  } finally { submit.disabled = false; }
});
logoutButton.addEventListener('click', async () => {
  try { await api('/api/logout', {method: 'POST'}); } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) { note(error instanceof Error ? error.message : 'Sign-out failed.'); return; }
  }
  showLogin('');
});
filters.addEventListener('submit', event => { event.preventDefault(); offset = 0; note(''); void loadList(); });
prev.addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); void loadList({focus: true}); });
next.addEventListener('click', () => { offset += PAGE_SIZE; void loadList({focus: true}); });
newButton.addEventListener('click', () => { createForm.reset(); formError.textContent = ''; dialog.showModal(); });
closeButton.addEventListener('click', () => dialog.close());
createForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = /** @type {HTMLButtonElement} */ (createForm.querySelector('[type=submit]'));
  submit.disabled = true;
  formError.textContent = '';
  try {
    const created = await api('/api/requests', {method: 'POST', body: Object.fromEntries(new FormData(createForm))});
    selected = created.id; offset = 0; filters.reset();
    dialog.close();
    await loadList({focus: true});
    note(`SR-${created.id} created.`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { dialog.close(); failure(error); }
    else formError.textContent = error instanceof Error ? error.message : 'The request could not be created.';
  } finally { submit.disabled = false; }
});

try {
  await startSession(await api('/api/session'), false);
} catch (error) {
  if (error instanceof ApiError && error.status === 401) showLogin('', true);
  else showLogin('The service is not available right now. Try again in a moment.', false);
}

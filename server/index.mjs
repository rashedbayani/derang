import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const categories = JSON.parse(readFileSync(new URL('../shared/questions.json', import.meta.url), 'utf8'));
const core = categories.slice(0, 5).map(category => category.id);
const optional = ['style', 'politics'];
const token = () => randomBytes(32).toString('base64url');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function createApi({ file = 'derang.sqlite', email, password, secret, origin = '' }) {
  if (!email || (password?.length ?? 0) < 12 || (secret?.length ?? 0) < 32) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_PASSWORD (12+ chars), and DERANG_SECRET (32+ chars).');
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, deadline INTEGER NOT NULL,
      categories TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE, consent TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS receipts (
      reviewer TEXT REFERENCES members(id), recipient TEXT REFERENCES members(id),
      PRIMARY KEY (reviewer, recipient)
    );
    CREATE TABLE IF NOT EXISTS totals (
      recipient TEXT REFERENCES members(id), question TEXT, sum INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (recipient, question)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, recipient TEXT REFERENCES members(id), kind TEXT NOT NULL, body TEXT NOT NULL
    );
  `);
  const sessions = new Map();
  const attempts = new Map();
  const hash = value => createHmac('sha256', secret).update(value).digest('hex');
  const salt = randomBytes(16);
  const passwordHash = scryptSync(password, salt, 64);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const open = group => !group.closed && group.deadline > Date.now();
  const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const member = id => get('SELECT id, name, group_id, consent FROM members WHERE id=?', id);
  const groupFor = id => get('SELECT * FROM groups WHERE id=?', id);
  const publicGroup = group => ({ id: group.id, name: group.name, deadline: group.deadline, open: open(group) });
  const questionsFor = (group, target) => {
    const enabled = JSON.parse(group.categories);
    const consent = JSON.parse(target.consent);
    return categories.filter(c => enabled.includes(c.id) || (optional.includes(c.id) && consent.includes(c.id)));
  };
  const sessionFor = (role, id = null) => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.until <= now) sessions.delete(key);
    const key = token();
    sessions.set(hash(key), { role, id, until: now + 8 * 60 * 60 * 1000 });
    return { token: key, role };
  };
  function rateLimit(req) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const entry = attempts.get(ip) ?? { count: 0, until: now + 60_000 };
    if (entry.count >= 30) fail(429, 'کمی صبر کن و دوباره تلاش کن.');
    entry.count++;
    attempts.set(ip, entry);
  }
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 32_768) fail(413, 'حجم درخواست بیش از حد مجاز است.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch { fail(400, 'فرمت درخواست معتبر نیست.'); }
  }
  async function route(req, path) {
    const method = req.method;
    if (method === 'GET' && path === '/health') return { ok: true };
    if (method === 'POST' && ['/access/member', '/access/admin'].includes(path)) {
      rateLimit(req);
      const body = await readBody(req);
      if (path.endsWith('/admin')) {
        const valid = timingSafeEqual(scryptSync(clean(body.password, 256), salt, 64), passwordHash);
        if (!valid || clean(body.email, 254).toLowerCase() !== email.toLowerCase()) fail(401, 'ایمیل یا رمز عبور درست نیست.');
        return sessionFor('admin');
      }
      const code = clean(body.code, 64).toUpperCase().replace(/[\s-]/g, '');
      const match = get('SELECT id FROM members WHERE code=?', hash(code));
      if (!match) fail(401, 'کد دعوت معتبر نیست.');
      return sessionFor('member', match.id);
    }
    const key = hash((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const session = sessions.get(key);
    if (!session || session.until <= Date.now()) fail(401, 'دوباره وارد شو.');
    if (method === 'POST' && path === '/logout') {
      sessions.delete(key);
      return {};
    }
    if (session.role === 'admin') {
      if (method === 'GET' && path === '/admin') {
        return {
          categories: categories.filter(c => !core.includes(c.id) && !optional.includes(c.id)).map(({id,title}) => ({id,title})),
          groups: all('SELECT * FROM groups ORDER BY rowid DESC').map(g => ({
            ...publicGroup(g), members: all('SELECT id,name FROM members WHERE group_id=? ORDER BY name', g.id)
          }))
        };
      }
      if (method === 'POST' && path === '/groups') {
        const body = await readBody(req);
        const name = clean(body.name, 80);
        const deadline = body.deadline;
        if (!name || !Number.isSafeInteger(deadline) || deadline <= Date.now()) fail(400, 'نام گروه و مهلت معتبر لازم است.');
        const extra = Array.isArray(body.categories) ? categories.filter(c => !optional.includes(c.id) && body.categories.includes(c.id)).map(c => c.id) : [];
        if (extra.length > 3) fail(400, 'حداکثر سه دستهٔ تکمیلی انتخاب کن.');
        run('INSERT INTO groups (id,name,deadline,categories) VALUES (?,?,?,?)', randomUUID(), name, deadline, JSON.stringify([...core, ...extra]));
        return {};
      }
      const match = path.match(/^\/groups\/([\w-]+)\/(members|close)$/);
      if (method === 'POST' && match) {
        const [, id, action] = match;
        const group = groupFor(id);
        if (!group || !open(group)) fail(409, 'این دوره باز نیست.');
        if (action === 'close') {
          run('UPDATE groups SET closed=1 WHERE id=?', id);
          return {};
        }
        const body = await readBody(req);
        const name = clean(body.name, 80);
        if (!name) fail(400, 'نام عضو را وارد کن.');
        if (!open(groupFor(id))) fail(409, 'این دوره باز نیست.');
        const code = randomBytes(8).toString('hex').toUpperCase();
        run('INSERT INTO members (id,group_id,name,code) VALUES (?,?,?,?)', randomUUID(), id, name, hash(code));
        return { code };
      }
      fail(404, 'صفحه پیدا نشد.');
    }
    const self = member(session.id);
    const group = groupFor(self.group_id);
    if (method === 'GET' && path === '/group') {
      return {
        ...publicGroup(group), me: self.name, consent: JSON.parse(self.consent),
        canChangeConsent: open(group) && !get('SELECT 1 FROM receipts WHERE recipient=? LIMIT 1', self.id),
        friends: all(`SELECT m.id,m.name, EXISTS(SELECT 1 FROM receipts r WHERE r.reviewer=? AND r.recipient=m.id) AS done
          FROM members m WHERE m.group_id=? AND m.id<>? ORDER BY m.name`, self.id, group.id, self.id)
      };
    }
    if (method === 'POST' && path === '/consent') {
      const body = await readBody(req);
      if (!open(groupFor(group.id)) || get('SELECT 1 FROM receipts WHERE recipient=? LIMIT 1', self.id)) fail(409, 'تنظیمات این دوره دیگر قابل تغییر نیست.');
      const consent = ['style','politics','text'].filter(id => Array.isArray(body.options) && body.options.includes(id));
      run('UPDATE members SET consent=? WHERE id=?', JSON.stringify(consent), self.id);
      return {};
    }
    if (method === 'GET' && path === '/report') {
      if (open(group)) fail(409, 'گزارش بعد از پایان دوره منتشر می‌شود.');
      const totals = new Map(all('SELECT question,sum,count FROM totals WHERE recipient=? AND count>=3', self.id).map(row => [row.question, row]));
      const results = questionsFor(group, self).map(c => ({
        ...c, items: c.items.map(q => {
          const row = totals.get(q.id);
          return { ...q, score: row ? Math.round(row.sum * 10 / row.count) / 10 : null, count: row?.count ?? null };
        })
      }));
      const comments = {};
      for (const kind of ['appreciation','change']) {
        const rows = all('SELECT body FROM comments WHERE recipient=? AND kind=? ORDER BY id', self.id, kind);
        comments[kind] = rows.length >= 3 ? rows.map(row => row.body) : [];
      }
      return { name: self.name, report: results, comments };
    }
    const review = path.match(/^\/review\/([\w-]+)$/);
    if (review && ['GET','POST'].includes(method)) {
      let target = member(review[1]);
      if (!target || target.group_id !== group.id || target.id === self.id) fail(404, 'عضو پیدا نشد.');
      const checkOpen = () => {
        if (!open(groupFor(group.id))) fail(409, 'مهلت بازخورد تمام شده است.');
        if (get('SELECT 1 FROM receipts WHERE reviewer=? AND recipient=?', self.id, target.id)) fail(409, 'بازخوردت قبلاً ثبت شده است.');
      };
      checkOpen();
      if (method === 'GET') return { name: target.name, categories: questionsFor(group, target), text: JSON.parse(target.consent).includes('text') };
      const body = await readBody(req);
      db.exec('BEGIN IMMEDIATE');
      try {
        checkOpen();
        target = member(target.id);
        const questions = new Set(questionsFor(group, target).flatMap(c => c.items.map(q => q.id)));
        const answers = Object.entries(body.answers ?? {});
        if (answers.some(([id, value]) => !questions.has(id) || !Number.isInteger(value) || value < 1 || value > 5)) fail(400, 'پاسخ نامعتبر است. فرم را دوباره باز کن.');
        const comments = JSON.parse(target.consent).includes('text') ? ['appreciation','change'].map(kind => [kind, clean(body[kind], 400)]).filter(([, value]) => value) : [];
        if (!answers.length && !comments.length) fail(400, 'حداقل یک پاسخ ثبت کن.');
        run('INSERT INTO receipts VALUES (?,?)', self.id, target.id);
        for (const [id, value] of answers) run(`INSERT INTO totals VALUES (?,?,?,1)
          ON CONFLICT(recipient,question) DO UPDATE SET sum=sum+excluded.sum,count=count+1`, target.id, id, value);
        for (const [kind,value] of comments) run('INSERT INTO comments VALUES (?,?,?,?)', randomUUID(), target.id, kind, value);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return {};
    }
    fail(404, 'صفحه پیدا نشد.');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    if (origin && req.headers.origin === origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      return res.writeHead(204).end();
    }
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!path.startsWith('/api/')) fail(404, 'صفحه پیدا نشد.');
      res.end(JSON.stringify(await route(req, path.slice(4))));
    } catch (error) {
      if (!error.status) console.error(error.message);
      res.writeHead(error.status ?? 500).end(JSON.stringify({ message: error.status ? error.message : 'خطایی رخ داد. دوباره تلاش کن.' }));
    }
  });
  server.on('close', () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApi({ file: process.env.DERANG_DB, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
    secret: process.env.DERANG_SECRET, origin: process.env.APP_ORIGIN }).listen(Number(process.env.PORT ?? 8787));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from './index.mjs';

test('private group, one review per friend, and thresholded report', async t => {
  const credentials = { email: 'admin@example.com', password: 'example-password' };
  const server = createApi({ ...credentials, secret: 'test-secret-not-for-production-12345', file: ':memory:' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(path, body, token) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  async function ok(path, body, token) {
    const result = await request(path, body, token);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  const admin = (await ok('/access/admin', credentials)).token;
  await ok('/groups', { name: 'جمع دوستان', deadline: Date.now() + 60_000, categories: ['learn'] }, admin);
  const group = (await ok('/admin', null, admin)).groups[0];
  const users = [];
  for (const name of ['آوا','سارا','نیما','مینا']) {
    const { code } = await ok('/groups/' + group.id + '/members', { name }, admin);
    users.push((await ok('/access/member', { code })).token);
  }
  const [recipient, first, second, third] = users;
  assert.equal((await ok('/group', null, recipient)).friends.length, 3);
  assert.equal((await request('/report', null, recipient)).status, 409);
  assert.equal((await request('/admin', null, recipient)).status, 404);
  assert.equal((await request('/report', null, admin)).status, 404);
  await ok('/consent', { options: ['politics','text'] }, recipient);
  const id = (await ok('/group', null, first)).friends.find(person => person.name === 'آوا').id;
  const path = '/review/' + id;
  const review = await ok(path, null, first);
  assert.ok(review.categories.some(category => category.id === 'politics'));
  assert.ok(review.categories.some(category => category.id === 'learn'));
  assert.equal((await request(path, null, recipient)).status, 404);
  assert.equal((await request(path, { answers: { first1: 6 } }, first)).status, 400);
  const duplicate = await Promise.all([
    request(path, { answers: { first1: 5, first2: 2 }, appreciation: 'نمونه ۱' }, first),
    request(path, { answers: { first1: 5, first2: 2 }, appreciation: 'نمونه ۱' }, first),
  ]);
  assert.deepEqual(duplicate.map(result => result.status).sort(), [200,409]);
  await ok(path, { answers: { first1: 4 }, appreciation: 'نمونه ۲' }, second);
  await ok(path, { answers: { first1: 3 }, appreciation: 'نمونه ۳' }, third);
  assert.equal((await request('/consent', { options: [] }, recipient)).status, 409);
  await ok('/groups/' + group.id + '/close', {}, admin);
  const report = await ok('/report', null, recipient);
  assert.equal(report.report[0].items[0].score, 4);
  assert.equal(report.report[0].items[0].count, 3);
  assert.equal(report.report[0].items[1].score, null);
  assert.equal(report.comments.appreciation.length, 3);
  assert.equal((await ok('/report', null, first)).report[0].items[0].score, null);
  assert.equal((await request(path, { answers: { first1: 5 } }, third)).status, 409);
});

const express = require('express');
const v = require('../validate');
const { wrap } = require('./helpers');
const { badRequest } = require('../errors');

function memberFields(body, { partial }) {
  const all = {
    name: ['name', () => v.str(body.name, 'name', { required: !partial })],
    email: ['email', () => v.email(body.email, 'email', { required: !partial })],
    phone: ['phone', () => v.phone(body.phone)],
    notify_email: ['notifyEmail', () => v.bool(body.notifyEmail, 'notifyEmail')],
    notify_sms: ['notifySms', () => v.bool(body.notifySms, 'notifySms')],
    status: ['status', () => v.oneOf(body.status, 'status', ['active', 'suspended'])],
  };
  const fields = {};
  for (const [col, [key, read]] of Object.entries(all)) {
    if (partial && !(key in body)) continue;
    const value = read();
    if (value !== null || col === 'phone') fields[col] = value;
  }
  if (!partial) {
    fields.notify_email ??= true;
    fields.notify_sms ??= Boolean(fields.phone);
    if (fields.notify_sms && !fields.phone) throw badRequest('phone is required to enable SMS notifications');
  }
  return fields;
}

function memberRoutes({ members }) {
  const r = express.Router();
  const memberId = (req) => v.id(req.params.id, 'id');

  r.get('/members', wrap(async (req, res) => res.json(await members.list({ q: v.str(req.query.q, 'q'), ...v.paging(req.query) }))));
  r.post('/members', wrap(async (req, res) => res.status(201).json(await members.create(memberFields(req.body, { partial: false })))));
  r.get('/members/:id', wrap(async (req, res) => res.json(await members.get(memberId(req)))));
  r.patch('/members/:id', wrap(async (req, res) => res.json(await members.update(memberId(req), memberFields(req.body, { partial: true })))));
  r.get('/members/:id/account', wrap(async (req, res) => res.json(await members.account(memberId(req)))));
  r.get('/members/:id/history', wrap(async (req, res) => res.json(await members.history(memberId(req), v.paging(req.query)))));
  r.get('/members/:id/notifications', wrap(async (req, res) => res.json(await members.notifications(memberId(req), v.paging(req.query)))));
  r.post('/members/:id/fines/pay', wrap(async (req, res) => res.json(await members.payFines(memberId(req)))));

  return r;
}

module.exports = { memberRoutes };

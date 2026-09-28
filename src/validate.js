const { badRequest } = require('./errors');

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function str(value, field, { required = false, max = 255 } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} must be a string`);
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`);
  return s;
}

function int(value, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) throw badRequest(`${field} must be an integer`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

const id = (value, field) => int(value, field, { required: true, min: 1, max: 4294967295 });

function bool(value, field) {
  if (isBlank(value)) return null;
  if (typeof value === 'boolean') return value;
  if (['true', '1', 1].includes(value)) return true;
  if (['false', '0', 0].includes(value)) return false;
  throw badRequest(`${field} must be true or false`);
}

function email(value, field = 'email', opts = {}) {
  const s = str(value, field, opts);
  if (s === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${field} is not a valid email address`);
  return s.toLowerCase();
}

// Accepts common formatting ("+1 (555) 010-0000") and stores E.164 ("+15550100000").
function phone(value, field = 'phone') {
  const s = str(value, field, { max: 32 });
  if (s === null) return null;
  const digits = s.replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw badRequest(`${field} must be in international format, e.g. +15551234567`);
  return digits;
}

function isbn(value, field = 'isbn') {
  const s = str(value, field, { max: 32 });
  if (s === null) return null;
  const raw = s.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(raw)) {
    const sum = [...raw].reduce((acc, ch, i) => acc + (ch === 'X' ? 10 : Number(ch)) * (10 - i), 0);
    if (sum % 11 === 0) return raw;
  } else if (/^\d{13}$/.test(raw)) {
    const sum = [...raw].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 ? 3 : 1), 0);
    if (sum % 10 === 0) return raw;
  }
  throw badRequest(`${field} is not a valid ISBN-10 or ISBN-13`);
}

function oneOf(value, field, allowed) {
  if (isBlank(value)) return null;
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function paging(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = int(query.page, 'page', { min: 1 }) || 1;
  const limit = int(query.limit, 'limit', { min: 1, max: maxLimit }) || defaultLimit;
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = { str, int, id, bool, email, phone, isbn, oneOf, paging };

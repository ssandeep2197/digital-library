const express = require('express');
const v = require('../validate');
const { wrap } = require('./helpers');

function bookFields(body, { partial }) {
  const fields = {
    isbn: v.isbn(body.isbn),
    title: v.str(body.title, 'title', { required: !partial }),
    author: v.str(body.author, 'author', { required: !partial }),
    publisher: v.str(body.publisher, 'publisher'),
    published_year: v.int(body.publishedYear, 'publishedYear', { min: 0, max: new Date().getFullYear() + 1 }),
    genre: v.str(body.genre, 'genre', { max: 100 }),
    description: v.str(body.description, 'description', { max: 5000 }),
  };
  // On PATCH, only touch fields the client sent (null clears a field).
  if (partial) {
    const keys = { isbn: 'isbn', title: 'title', author: 'author', publisher: 'publisher', published_year: 'publishedYear', genre: 'genre', description: 'description' };
    for (const [col, key] of Object.entries(keys)) if (!(key in body)) delete fields[col];
    for (const col of ['title', 'author']) if (col in fields && fields[col] === null) delete fields[col];
  }
  return fields;
}

// Public, read-only catalog browsing.
function publicCatalogRoutes({ catalog }) {
  const r = express.Router();

  r.get('/books', wrap(async (req, res) => {
    res.json(await catalog.listBooks({
      q: v.str(req.query.q, 'q'),
      author: v.str(req.query.author, 'author'),
      genre: v.str(req.query.genre, 'genre'),
      available: v.bool(req.query.available, 'available'),
      ...v.paging(req.query),
    }));
  }));

  r.get('/books/:id', wrap(async (req, res) => res.json(await catalog.getBook(v.id(req.params.id, 'id')))));

  r.get('/books/:id/availability', wrap(async (req, res) => res.json(await catalog.availability(v.id(req.params.id, 'id')))));

  return r;
}

// Staff inventory management.
function inventoryRoutes({ catalog, circulation }) {
  const r = express.Router();

  r.post('/books', wrap(async (req, res) => res.status(201).json(await catalog.createBook(bookFields(req.body, { partial: false })))));

  r.patch('/books/:id', wrap(async (req, res) =>
    res.json(await catalog.updateBook(v.id(req.params.id, 'id'), bookFields(req.body, { partial: true })))));

  r.delete('/books/:id', wrap(async (req, res) => {
    await catalog.deleteBook(v.id(req.params.id, 'id'));
    res.status(204).end();
  }));

  r.get('/books/:id/copies', wrap(async (req, res) => res.json({ items: await catalog.listCopies(v.id(req.params.id, 'id')) })));

  r.post('/books/:id/copies', wrap(async (req, res) => {
    const copy = await catalog.addCopy(v.id(req.params.id, 'id'), {
      barcode: v.str(req.body.barcode, 'barcode', { required: true, max: 64 }),
      location: v.str(req.body.location, 'location', { max: 100 }),
    });
    res.status(201).json(copy);
  }));

  r.patch('/copies/:id', wrap(async (req, res) => {
    const copyId = v.id(req.params.id, 'id');
    const status = v.oneOf(req.body.status, 'status', ['available', 'lost', 'maintenance']);
    let result = {};
    if ('location' in req.body) await catalog.updateCopyLocation(copyId, v.str(req.body.location, 'location', { max: 100 }));
    if (status) result = await circulation.setCopyStatus(copyId, status);
    res.json({ ...(await catalog.getCopy(copyId)), heldFor: result.heldFor || null });
  }));

  return r;
}

module.exports = { publicCatalogRoutes, inventoryRoutes };

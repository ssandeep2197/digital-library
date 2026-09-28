class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message, code = 'bad_request') => new HttpError(400, message, code);
const notFound = (message, code = 'not_found') => new HttpError(404, message, code);
const conflict = (message, code = 'conflict') => new HttpError(409, message, code);

module.exports = { HttpError, badRequest, notFound, conflict };

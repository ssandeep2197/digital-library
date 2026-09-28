CREATE TABLE IF NOT EXISTS books (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  isbn           VARCHAR(17)  NULL UNIQUE,
  title          VARCHAR(255) NOT NULL,
  author         VARCHAR(255) NOT NULL,
  publisher      VARCHAR(255) NULL,
  published_year SMALLINT     NULL,
  genre          VARCHAR(100) NULL,
  description    TEXT         NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FULLTEXT KEY ft_books (title, author),
  KEY idx_books_genre (genre)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Physical copies of a book. A copy's status is the source of truth for availability.
CREATE TABLE IF NOT EXISTS copies (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  book_id    INT UNSIGNED NOT NULL,
  barcode    VARCHAR(64)  NOT NULL UNIQUE,
  status     ENUM('available','on_loan','on_hold','lost','maintenance') NOT NULL DEFAULT 'available',
  location   VARCHAR(100) NULL,
  created_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_copies_book FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE RESTRICT,
  KEY idx_copies_book_status (book_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS members (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  email        VARCHAR(255) NOT NULL UNIQUE,
  phone        VARCHAR(20)  NULL,
  notify_email TINYINT(1)   NOT NULL DEFAULT 1,
  notify_sms   TINYINT(1)   NOT NULL DEFAULT 0,
  status       ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS loans (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  copy_id             INT UNSIGNED NOT NULL,
  member_id           INT UNSIGNED NOT NULL,
  checked_out_at      DATETIME(3)     NOT NULL,
  due_at              DATETIME(3)     NOT NULL,
  returned_at         DATETIME(3)     NULL,
  renewals            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  fine_cents          INT UNSIGNED NOT NULL DEFAULT 0,
  fine_paid           TINYINT(1)   NOT NULL DEFAULT 0,
  due_soon_notified   TINYINT(1)   NOT NULL DEFAULT 0,
  overdue_notices     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_overdue_notice DATETIME(3)     NULL,
  CONSTRAINT fk_loans_copy   FOREIGN KEY (copy_id)   REFERENCES copies(id),
  CONSTRAINT fk_loans_member FOREIGN KEY (member_id) REFERENCES members(id),
  KEY idx_loans_open (returned_at, due_at),
  KEY idx_loans_member (member_id, returned_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reservation queue per book (FIFO by id). A 'ready' reservation holds a specific copy until expires_at.
CREATE TABLE IF NOT EXISTS reservations (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  book_id      INT UNSIGNED NOT NULL,
  member_id    INT UNSIGNED NOT NULL,
  copy_id      INT UNSIGNED NULL,
  status       ENUM('waiting','ready','fulfilled','cancelled','expired') NOT NULL DEFAULT 'waiting',
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ready_at     DATETIME(3)     NULL,
  expires_at   DATETIME(3)     NULL,
  closed_at    DATETIME(3)     NULL,
  CONSTRAINT fk_res_book   FOREIGN KEY (book_id)   REFERENCES books(id),
  CONSTRAINT fk_res_member FOREIGN KEY (member_id) REFERENCES members(id),
  CONSTRAINT fk_res_copy   FOREIGN KEY (copy_id)   REFERENCES copies(id),
  KEY idx_res_queue (book_id, status, id),
  KEY idx_res_member (member_id, status),
  KEY idx_res_expiry (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Notification outbox. Rows are written in the same transaction as the event that
-- causes them and delivered asynchronously by the dispatcher, with retries.
CREATE TABLE IF NOT EXISTS notifications (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  member_id    INT UNSIGNED NOT NULL,
  channel      ENUM('email','sms') NOT NULL,
  type         VARCHAR(40)  NOT NULL,
  recipient    VARCHAR(255) NOT NULL,
  subject      VARCHAR(255) NULL,
  body         TEXT         NOT NULL,
  status       ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error   VARCHAR(500) NULL,
  provider_id  VARCHAR(255) NULL,
  dedupe_key   VARCHAR(191) NULL UNIQUE,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at      DATETIME(3)     NULL,
  CONSTRAINT fk_notif_member FOREIGN KEY (member_id) REFERENCES members(id),
  KEY idx_notif_due (status, next_attempt_at),
  KEY idx_notif_member (member_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

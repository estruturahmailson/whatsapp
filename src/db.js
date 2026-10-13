import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'followup.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Contatos acompanhados pelo agente
  CREATE TABLE IF NOT EXISTS contacts (
    phone        TEXT PRIMARY KEY,
    name         TEXT,
    in_followup  INTEGER NOT NULL DEFAULT 0,  -- tem a etiqueta "Acompanhamento"
    source       TEXT,                        -- 'zapi' (etiqueta) ou 'manual' (painel)
    status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'cold'
    updated_at   INTEGER
  );

  -- Histórico das conversas, alimentado pelo webhook da Z-API
  CREATE TABLE IF NOT EXISTS messages (
    id       TEXT PRIMARY KEY,
    phone    TEXT NOT NULL,
    from_me  INTEGER NOT NULL,
    text     TEXT,
    ts       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone_ts ON messages (phone, ts);

  -- Mensagens geradas pelo agente (fila de aprovação)
  CREATE TABLE IF NOT EXISTS drafts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT NOT NULL,
    kind            TEXT NOT NULL,           -- 'followup' | 'closing'
    attempt         INTEGER NOT NULL,
    message         TEXT,
    ai_reason       TEXT,
    status          TEXT NOT NULL,           -- 'pending' | 'queued' | 'sent' | 'rejected' | 'skipped' | 'error'
    error           TEXT,
    zapi_message_id TEXT,
    created_at      INTEGER NOT NULL,
    decided_at      INTEGER,
    sent_at         INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_phone ON drafts (phone, status);

  -- Execuções do agente
  CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger     TEXT,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    summary     TEXT,
    log         TEXT
  );
`);

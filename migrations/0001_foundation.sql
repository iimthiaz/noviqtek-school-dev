-- Noviqtek School Management — Milestone 1 foundation schema (Cloudflare D1 / SQLite)
-- Every school-owned row carries tenant_id. Internal IDs are immutable random text IDs.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_ar TEXT,
  logo_data TEXT,
  primary_color TEXT DEFAULT '#1d4e89',
  accent_color TEXT DEFAULT '#0f8b8d',
  timezone TEXT NOT NULL DEFAULT 'Asia/Qatar',
  currency TEXT NOT NULL DEFAULT 'QAR',
  country TEXT NOT NULL DEFAULT 'QA',
  working_days TEXT NOT NULL DEFAULT '0,1,2,3,4',
  address TEXT, phone TEXT, email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE campuses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
  address TEXT, phone TEXT, email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  preferred_language TEXT DEFAULT 'en',
  mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  last_login_at TEXT, permissions_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
  is_preset INTEGER NOT NULL DEFAULT 0, requires_mfa INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);
CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  campus_id TEXT REFERENCES campuses(id),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, role_id, campus_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, ip TEXT, user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE one_time_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('school_setup','invite','password_reset')),
  tenant_id TEXT, user_id TEXT, email TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_user_id TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  reason TEXT, details TEXT,
  ip TEXT, correlation_id TEXT,
  at TEXT NOT NULL,
  mac TEXT NOT NULL                   -- HMAC over the row using the AUDIT_KEY secret
);
CREATE INDEX idx_audit_tenant_at ON audit_log(tenant_id, at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Academic master data
CREATE TABLE academic_years (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, label TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE TABLE terms (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id),
  code TEXT NOT NULL, name_en TEXT, name_ar TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, academic_year_id, code)
);
CREATE TABLE timing_groups (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
  day_start TEXT, day_end TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE TABLE year_groups (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT, sort_order INTEGER DEFAULT 0,
  timing_group_id TEXT REFERENCES timing_groups(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE TABLE departments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT, campus_id TEXT REFERENCES campuses(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE TABLE subjects (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  code TEXT NOT NULL, name_en TEXT NOT NULL, name_ar TEXT,
  department_id TEXT REFERENCES departments(id), policy_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE TABLE staff (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  staff_code TEXT NOT NULL, official_name_en TEXT NOT NULL, official_name_ar TEXT,
  work_email TEXT, job_title TEXT,
  department_id TEXT REFERENCES departments(id), campus_id TEXT REFERENCES campuses(id),
  employment_start TEXT, employment_end TEXT,
  status TEXT NOT NULL DEFAULT 'active', user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, staff_code)
);
CREATE INDEX idx_staff_user ON staff(user_id);
CREATE TABLE classes (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id),
  campus_id TEXT NOT NULL REFERENCES campuses(id),
  year_group_id TEXT REFERENCES year_groups(id),
  code TEXT NOT NULL, name_en TEXT, name_ar TEXT, room_code TEXT, capacity INTEGER,
  class_teacher_staff_id TEXT REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, academic_year_id, code)
);
CREATE TABLE teaching_assignments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  staff_id TEXT NOT NULL REFERENCES staff(id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  valid_from TEXT, valid_to TEXT, weekly_load INTEGER, lead_teacher INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, staff_id, class_id, subject_id)
);

-- Students and families
CREATE TABLE students (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  admission_no TEXT NOT NULL,
  official_name_en TEXT NOT NULL, official_name_ar TEXT, preferred_name TEXT,
  date_of_birth TEXT NOT NULL, gender_code TEXT, nationality_code TEXT,
  school_email TEXT, joined_date TEXT, legacy_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, admission_no)
);
CREATE INDEX idx_students_name ON students(tenant_id, official_name_en);
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  academic_year_id TEXT NOT NULL REFERENCES academic_years(id),
  campus_id TEXT NOT NULL REFERENCES campuses(id),
  class_id TEXT NOT NULL REFERENCES classes(id),
  start_date TEXT NOT NULL, end_date TEXT,
  enrollment_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, student_id, academic_year_id, start_date)
);
CREATE INDEX idx_enroll_class ON enrollments(class_id, enrollment_status);
CREATE TABLE families (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  family_code TEXT NOT NULL, family_label TEXT, preferred_language TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, family_code)
);
CREATE TABLE guardians (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  guardian_code TEXT NOT NULL, official_name_en TEXT NOT NULL, official_name_ar TEXT,
  email TEXT, phone TEXT, preferred_language TEXT, address TEXT,
  verified_contact_status TEXT DEFAULT 'unverified',
  user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, guardian_code)
);
CREATE INDEX idx_guardians_user ON guardians(user_id);
CREATE TABLE student_guardians (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  guardian_id TEXT NOT NULL REFERENCES guardians(id),
  family_id TEXT REFERENCES families(id),
  relationship_code TEXT NOT NULL,
  portal_access INTEGER NOT NULL DEFAULT 0, billing_contact INTEGER NOT NULL DEFAULT 0,
  emergency_priority INTEGER, pickup_authorized INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT, valid_to TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, student_id, guardian_id)
);
CREATE INDEX idx_sg_family ON student_guardians(family_id);

-- Family QR check-in credentials (only the hash of the opaque token is stored)
CREATE TABLE family_credentials (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  family_id TEXT NOT NULL REFERENCES families(id),
  token_hash TEXT NOT NULL UNIQUE, reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by TEXT, created_at TEXT NOT NULL, revoked_at TEXT, revoked_reason TEXT
);

-- Attendance
CREATE TABLE attendance (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT REFERENCES classes(id),
  attendance_date TEXT NOT NULL, session_code TEXT NOT NULL DEFAULT 'DAY',
  status_code TEXT NOT NULL CHECK (status_code IN ('present','absent','late','excused')),
  minutes_late INTEGER, reason_code TEXT, note TEXT,
  recorded_by TEXT, recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, student_id, attendance_date, session_code)
);
CREATE INDEX idx_att_date ON attendance(tenant_id, attendance_date);

-- Dismissal: one record per student per session. Status only 'called' or 'dismissed';
-- absence of a record = neutral "not called".
CREATE TABLE dismissal_records (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  dismissal_date TEXT NOT NULL, session_code TEXT NOT NULL DEFAULT 'PM',
  student_id TEXT NOT NULL REFERENCES students(id),
  class_id TEXT REFERENCES classes(id),
  status TEXT NOT NULL CHECK (status IN ('called','dismissed')),
  called_at TEXT NOT NULL, called_by TEXT, channel TEXT NOT NULL,
  family_credential_id TEXT,
  dismissed_at TEXT, dismissed_by TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, dismissal_date, session_code, student_id)
);
CREATE INDEX idx_dis_date ON dismissal_records(tenant_id, dismissal_date, session_code);
CREATE TABLE dismissal_events (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_user_id TEXT, channel TEXT,
  reason TEXT, at TEXT NOT NULL
);
CREATE TABLE idempotency_keys (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

-- Import center
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id),
  module TEXT NOT NULL, mode TEXT NOT NULL, file_name TEXT, file_hash TEXT NOT NULL,
  schema_version TEXT, status TEXT NOT NULL,
  total_rows INTEGER, valid_rows INTEGER, error_rows INTEGER,
  created_count INTEGER DEFAULT 0, updated_count INTEGER DEFAULT 0, unchanged_count INTEGER DEFAULT 0,
  result TEXT, created_by TEXT, created_at TEXT NOT NULL, committed_at TEXT
);
CREATE INDEX idx_import_hash ON import_jobs(tenant_id, module, file_hash, status);

CREATE TABLE sequences (
  tenant_id TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

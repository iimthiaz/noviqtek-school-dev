// Declarative import template definitions. The same definitions drive template
// downloads (XLSX/CSV + dictionary), validation, and commit.
export const SCHEMA_VERSION = '1.0';

const STATUS = ['active', 'archived'];
const LANG = ['en', 'ar'];
const f = (key, label_en, label_ar, type, opts = {}) => ({ key, label_en, label_ar, type, required: false, max: 200, sensitivity: 'standard', ...opts });

export const IMPORT_DEFS = {
  campuses: {
    title: 'Campuses', table: 'campuses', key: ['code'], order: 1,
    fields: [
      f('campus_code', 'Campus code', 'رمز الحرم', 'code', { required: true, col: 'code', unique: true, example: 'MAIN' }),
      f('campus_name_en', 'Campus name (English)', 'اسم الحرم (إنجليزي)', 'text', { required: true, col: 'name_en', example: 'Main Campus' }),
      f('campus_name_ar', 'Campus name (Arabic)', 'اسم الحرم (عربي)', 'text', { col: 'name_ar', example: 'الحرم الرئيسي' }),
      f('address', 'Address', 'العنوان', 'text', { col: 'address', max: 400 }),
      f('phone', 'Phone', 'الهاتف', 'phone', { col: 'phone', example: '+974 4000 0000' }),
      f('email', 'Email', 'البريد الإلكتروني', 'email', { col: 'email' }),
      f('status', 'Status', 'الحالة', 'enum', { col: 'status', values: STATUS, example: 'active', default: 'active' }),
    ],
  },
  academic_years: {
    title: 'Academic years', table: 'academic_years', key: ['code'], order: 2,
    fields: [
      f('academic_year_code', 'Academic year code', 'رمز العام الدراسي', 'code', { required: true, col: 'code', unique: true, example: 'AY2026' }),
      f('year_label', 'Label', 'التسمية', 'text', { col: 'label', example: '2026–2027' }),
      f('start_date', 'Start date', 'تاريخ البداية', 'date', { required: true, col: 'start_date', example: '2026-08-23' }),
      f('end_date', 'End date', 'تاريخ النهاية', 'date', { required: true, col: 'end_date', example: '2027-06-24' }),
      f('is_current', 'Current year', 'العام الحالي', 'bool', { col: 'is_current', example: 'true' }),
    ],
    validate: (r) => r.start_date && r.end_date && r.start_date > r.end_date ? 'end_date must be on or after start_date' : null,
  },
  terms: {
    title: 'Terms', table: 'terms', key: ['academic_year_id', 'code'], order: 3,
    fields: [
      f('academic_year_code', 'Academic year code', 'رمز العام الدراسي', 'code', { required: true, ref: 'ay', col: 'academic_year_id', example: 'AY2026' }),
      f('term_code', 'Term code', 'رمز الفصل الدراسي', 'code', { required: true, col: 'code', example: 'T1' }),
      f('term_name_en', 'Term name (English)', 'اسم الفصل (إنجليزي)', 'text', { col: 'name_en', example: 'Term 1' }),
      f('term_name_ar', 'Term name (Arabic)', 'اسم الفصل (عربي)', 'text', { col: 'name_ar', example: 'الفصل الأول' }),
      f('start_date', 'Start date', 'تاريخ البداية', 'date', { required: true, col: 'start_date', example: '2026-08-23' }),
      f('end_date', 'End date', 'تاريخ النهاية', 'date', { required: true, col: 'end_date', example: '2026-12-10' }),
    ],
    validate: (r) => r.start_date > r.end_date ? 'end_date must be on or after start_date' : null,
  },
  timing_groups: {
    title: 'Timing groups', table: 'timing_groups', key: ['code'], order: 4,
    fields: [
      f('timing_group_code', 'Timing group code', 'رمز مجموعة التوقيت', 'code', { required: true, col: 'code', example: 'Y1-2' }),
      f('timing_group_name_en', 'Name (English)', 'الاسم (إنجليزي)', 'text', { required: true, col: 'name_en', example: 'Year 1–2 timings' }),
      f('timing_group_name_ar', 'Name (Arabic)', 'الاسم (عربي)', 'text', { col: 'name_ar' }),
      f('day_start', 'Day start (HH:MM)', 'بداية اليوم', 'time', { col: 'day_start', example: '07:00' }),
      f('day_end', 'Day end (HH:MM)', 'نهاية اليوم', 'time', { col: 'day_end', example: '13:00' }),
    ],
  },
  year_groups: {
    title: 'Year groups', table: 'year_groups', key: ['code'], order: 5,
    fields: [
      f('year_group_code', 'Year group code', 'رمز المرحلة', 'code', { required: true, col: 'code', example: 'Y1' }),
      f('year_group_name_en', 'Name (English)', 'الاسم (إنجليزي)', 'text', { required: true, col: 'name_en', example: 'Year 1' }),
      f('year_group_name_ar', 'Name (Arabic)', 'الاسم (عربي)', 'text', { col: 'name_ar', example: 'السنة الأولى' }),
      f('sort_order', 'Sort order', 'الترتيب', 'int', { col: 'sort_order', example: '1' }),
      f('timing_group_code', 'Timing group code', 'رمز مجموعة التوقيت', 'code', { ref: 'tg', col: 'timing_group_id', example: 'Y1-2' }),
    ],
  },
  departments: {
    title: 'Departments', table: 'departments', key: ['code'], order: 6,
    fields: [
      f('department_code', 'Department code', 'رمز القسم', 'code', { required: true, col: 'code', example: 'PRIM' }),
      f('department_name_en', 'Name (English)', 'الاسم (إنجليزي)', 'text', { required: true, col: 'name_en', example: 'Primary' }),
      f('department_name_ar', 'Name (Arabic)', 'الاسم (عربي)', 'text', { col: 'name_ar' }),
      f('campus_code', 'Campus code', 'رمز الحرم', 'code', { ref: 'campus', col: 'campus_id', example: 'MAIN' }),
    ],
  },
  subjects: {
    title: 'Subjects', table: 'subjects', key: ['code'], order: 7,
    fields: [
      f('subject_code', 'Subject code', 'رمز المادة', 'code', { required: true, col: 'code', example: 'ENG' }),
      f('subject_name_en', 'Name (English)', 'الاسم (إنجليزي)', 'text', { required: true, col: 'name_en', example: 'English' }),
      f('subject_name_ar', 'Name (Arabic)', 'الاسم (عربي)', 'text', { col: 'name_ar', example: 'اللغة الإنجليزية' }),
      f('department_code', 'Department code', 'رمز القسم', 'code', { ref: 'dept', col: 'department_id' }),
      f('policy_reference', 'Policy reference', 'مرجع السياسة', 'text', { col: 'policy_reference' }),
    ],
  },
  staff: {
    title: 'Staff', table: 'staff', key: ['staff_code'], order: 8,
    fields: [
      f('staff_code', 'Staff code', 'رمز الموظف', 'code', { required: true, col: 'staff_code', example: 'S0001' }),
      f('official_name_en', 'Official name (English)', 'الاسم الرسمي (إنجليزي)', 'text', { required: true, col: 'official_name_en', example: 'Demo Teacher One' }),
      f('official_name_ar', 'Official name (Arabic)', 'الاسم الرسمي (عربي)', 'text', { col: 'official_name_ar' }),
      f('work_email', 'Work email', 'البريد الوظيفي', 'email', { required: true, col: 'work_email', example: 'teacher.one@example.invalid' }),
      f('department_code', 'Department code', 'رمز القسم', 'code', { required: true, ref: 'dept', col: 'department_id', example: 'PRIM' }),
      f('job_title', 'Job title', 'المسمى الوظيفي', 'text', { col: 'job_title', example: 'Class Teacher' }),
      f('campus_code', 'Campus code', 'رمز الحرم', 'code', { ref: 'campus', col: 'campus_id', example: 'MAIN' }),
      f('employment_start', 'Employment start', 'بداية العمل', 'date', { col: 'employment_start' }),
      f('employment_end', 'Employment end', 'نهاية العمل', 'date', { col: 'employment_end' }),
      f('employment_status', 'Status', 'الحالة', 'enum', { col: 'status', values: ['active', 'on_leave', 'left', 'archived'], default: 'active' }),
    ],
  },
  classes: {
    title: 'Classes', table: 'classes', key: ['academic_year_id', 'code'], order: 9,
    fields: [
      f('academic_year_code', 'Academic year code', 'رمز العام الدراسي', 'code', { required: true, ref: 'ay', col: 'academic_year_id', example: 'AY2026' }),
      f('campus_code', 'Campus code', 'رمز الحرم', 'code', { required: true, ref: 'campus', col: 'campus_id', example: 'MAIN' }),
      f('year_group_code', 'Year group code', 'رمز المرحلة', 'code', { required: true, ref: 'yg', col: 'year_group_id', example: 'Y1' }),
      f('class_code', 'Class code', 'رمز الفصل', 'code', { required: true, col: 'code', example: 'Y1A' }),
      f('class_name_en', 'Class name (English)', 'اسم الفصل (إنجليزي)', 'text', { col: 'name_en', example: 'Year 1A' }),
      f('class_name_ar', 'Class name (Arabic)', 'اسم الفصل (عربي)', 'text', { col: 'name_ar' }),
      f('room_code', 'Room code', 'رمز الغرفة', 'code', { col: 'room_code' }),
      f('capacity', 'Capacity', 'السعة', 'int', { col: 'capacity', example: '24' }),
      f('class_teacher_staff_code', 'Class teacher staff code', 'رمز معلم الفصل', 'code', { ref: 'staff', col: 'class_teacher_staff_id' }),
    ],
  },
  teaching_assignments: {
    title: 'Teaching assignments', table: 'teaching_assignments', key: ['staff_id', 'class_id', 'subject_id'], order: 10,
    fields: [
      f('staff_code', 'Staff code', 'رمز الموظف', 'code', { required: true, ref: 'staff', col: 'staff_id', example: 'S0001' }),
      f('academic_year_code', 'Academic year code', 'رمز العام الدراسي', 'code', { required: true, ref: 'ay', col: 'academic_year_id', example: 'AY2026' }),
      f('class_code', 'Class code', 'رمز الفصل', 'code', { required: true, ref: 'class', col: 'class_id', example: 'Y1A' }),
      f('subject_code', 'Subject code', 'رمز المادة', 'code', { required: true, ref: 'subject', col: 'subject_id', example: 'ENG' }),
      f('valid_from', 'Valid from', 'ساري من', 'date', { col: 'valid_from' }),
      f('valid_to', 'Valid to', 'ساري حتى', 'date', { col: 'valid_to' }),
      f('weekly_load', 'Weekly periods', 'الحصص الأسبوعية', 'int', { col: 'weekly_load' }),
      f('lead_teacher', 'Lead teacher', 'المعلم الرئيسي', 'bool', { col: 'lead_teacher' }),
    ],
  },
  students: {
    title: 'Students', table: 'students', key: ['admission_no'], order: 11,
    fields: [
      f('admission_no', 'Admission number', 'رقم القبول', 'code', { required: true, col: 'admission_no', unique: true, example: '000101', desc: 'Kept as text; leading zeros preserved.' }),
      f('official_name_en', 'Official name (English)', 'الاسم الرسمي (إنجليزي)', 'text', { required: true, col: 'official_name_en', example: 'Demo Learner One', sensitivity: 'personal' }),
      f('date_of_birth', 'Date of birth', 'تاريخ الميلاد', 'date', { required: true, col: 'date_of_birth', example: '2018-02-14', sensitivity: 'personal' }),
      f('official_name_ar', 'Official name (Arabic)', 'الاسم الرسمي (عربي)', 'text', { col: 'official_name_ar', sensitivity: 'personal' }),
      f('gender_code', 'Gender code', 'رمز الجنس', 'enum', { col: 'gender_code', values: ['M', 'F'] }),
      f('nationality_code', 'Nationality (ISO 3166 alpha-2)', 'الجنسية', 'code', { col: 'nationality_code', max: 3, example: 'QA' }),
      f('preferred_name', 'Preferred name', 'الاسم المفضل', 'text', { col: 'preferred_name' }),
      f('school_email', 'School email', 'البريد المدرسي', 'email', { col: 'school_email', example: 'learner.one@example.invalid' }),
      f('joined_date', 'Joined date', 'تاريخ الالتحاق', 'date', { col: 'joined_date' }),
      f('status', 'Status', 'الحالة', 'enum', { col: 'status', values: ['active', 'withdrawn', 'graduated', 'archived'], example: 'active', default: 'active' }),
      f('legacy_id', 'Legacy ID', 'المعرف السابق', 'text', { col: 'legacy_id', max: 60 }),
    ],
  },
  enrollments: {
    title: 'Enrollments', table: 'enrollments', key: ['student_id', 'academic_year_id', 'start_date'], order: 12,
    fields: [
      f('admission_no', 'Admission number', 'رقم القبول', 'code', { required: true, ref: 'student', col: 'student_id', example: '000101' }),
      f('academic_year_code', 'Academic year code', 'رمز العام الدراسي', 'code', { required: true, ref: 'ay', col: 'academic_year_id', example: 'AY2026' }),
      f('campus_code', 'Campus code', 'رمز الحرم', 'code', { required: true, ref: 'campus', col: 'campus_id', example: 'MAIN' }),
      f('class_code', 'Class code', 'رمز الفصل', 'code', { required: true, ref: 'class', col: 'class_id', example: 'Y1A' }),
      f('start_date', 'Start date', 'تاريخ البداية', 'date', { required: true, col: 'start_date', example: '2026-09-01' }),
      f('end_date', 'End date', 'تاريخ النهاية', 'date', { col: 'end_date' }),
      f('enrollment_status', 'Enrollment status', 'حالة التسجيل', 'enum', { col: 'enrollment_status', values: ['active', 'ended', 'transferred', 'withdrawn'], example: 'active', default: 'active' }),
    ],
    validate: (r, _raw, meta) => {
      if (meta.classCampus && r.campus_id && meta.classCampus !== r.campus_id) return 'class_code does not belong to campus_code';
      if (r.end_date && r.start_date > r.end_date) return 'end_date must be on or after start_date';
      return null;
    },
  },
  families: {
    title: 'Families', table: 'families', key: ['family_code'], order: 13,
    fields: [
      f('family_code', 'Family code', 'رمز العائلة', 'code', { required: true, col: 'family_code', example: 'F001' }),
      f('family_label', 'Family label', 'تسمية العائلة', 'text', { col: 'family_label', example: 'Demo Family' }),
      f('preferred_language', 'Preferred language', 'اللغة المفضلة', 'enum', { col: 'preferred_language', values: LANG }),
    ],
    note: 'A family groups siblings for pickup. It grants no legal or portal permissions on its own.',
  },
  guardians: {
    title: 'Guardians', table: 'guardians', key: ['guardian_code'], order: 14,
    fields: [
      f('guardian_code', 'Guardian code', 'رمز ولي الأمر', 'code', { required: true, col: 'guardian_code', example: 'G001' }),
      f('official_name_en', 'Official name (English)', 'الاسم الرسمي (إنجليزي)', 'text', { required: true, col: 'official_name_en', example: 'Demo Guardian One', sensitivity: 'personal' }),
      f('official_name_ar', 'Official name (Arabic)', 'الاسم الرسمي (عربي)', 'text', { col: 'official_name_ar', sensitivity: 'personal' }),
      f('email', 'Email', 'البريد الإلكتروني', 'email', { col: 'email', sensitivity: 'personal' }),
      f('phone', 'Phone', 'الهاتف', 'phone', { col: 'phone', sensitivity: 'personal', example: '+974 5000 0000' }),
      f('preferred_language', 'Preferred language', 'اللغة المفضلة', 'enum', { col: 'preferred_language', values: LANG }),
      f('address', 'Address', 'العنوان', 'text', { col: 'address', max: 400, sensitivity: 'personal' }),
      f('verified_contact_status', 'Contact verification', 'حالة التحقق', 'enum', { col: 'verified_contact_status', values: ['unverified', 'verified'], default: 'unverified' }),
    ],
  },
  student_guardians: {
    title: 'Student–guardian links', table: 'student_guardians', key: ['student_id', 'guardian_id'], order: 15,
    fields: [
      f('admission_no', 'Admission number', 'رقم القبول', 'code', { required: true, ref: 'student', col: 'student_id', example: '000101' }),
      f('guardian_code', 'Guardian code', 'رمز ولي الأمر', 'code', { required: true, ref: 'guardian', col: 'guardian_id', example: 'G001' }),
      f('relationship_code', 'Relationship', 'صلة القرابة', 'enum', { required: true, col: 'relationship_code', values: ['mother', 'father', 'parent', 'legal_guardian', 'grandparent', 'sibling', 'other'], example: 'parent' }),
      f('family_code', 'Family code', 'رمز العائلة', 'code', { ref: 'family', col: 'family_id', example: 'F001' }),
      f('portal_access', 'Portal access', 'الوصول للبوابة', 'bool', { col: 'portal_access', example: 'true' }),
      f('billing_contact', 'Billing contact', 'جهة الفواتير', 'bool', { col: 'billing_contact' }),
      f('emergency_priority', 'Emergency priority', 'أولوية الطوارئ', 'int', { col: 'emergency_priority' }),
      f('pickup_authorized', 'Pickup authorized', 'مصرح بالاستلام', 'bool', { col: 'pickup_authorized', example: 'true' }),
      f('valid_from', 'Valid from', 'ساري من', 'date', { col: 'valid_from' }),
      f('valid_to', 'Valid to', 'ساري حتى', 'date', { col: 'valid_to' }),
    ],
    note: 'Access is granted only through explicit links. A shared surname, email or address never grants access.',
  },
  attendance_history: {
    title: 'Attendance history', table: 'attendance', key: ['student_id', 'attendance_date', 'session_code'], order: 16, allowValidOnly: true,
    fields: [
      f('admission_no', 'Admission number', 'رقم القبول', 'code', { required: true, ref: 'student', col: 'student_id', example: '000101' }),
      f('attendance_date', 'Attendance date', 'تاريخ الحضور', 'date', { required: true, col: 'attendance_date', example: '2026-09-14' }),
      f('session_code', 'Session code', 'رمز الجلسة', 'code', { required: true, col: 'session_code', example: 'DAY' }),
      f('status_code', 'Status', 'الحالة', 'enum', { required: true, col: 'status_code', values: ['present', 'absent', 'late', 'excused'], example: 'present' }),
      f('minutes_late', 'Minutes late', 'دقائق التأخير', 'int', { col: 'minutes_late' }),
      f('reason_code', 'Reason code', 'رمز السبب', 'code', { col: 'reason_code' }),
      f('note', 'Note', 'ملاحظة', 'text', { col: 'note', max: 500 }),
      f('recorded_by_staff_code', 'Recorded by (staff code)', 'سجله (رمز الموظف)', 'code', { ref: 'staff', col: 'recorded_by' }),
    ],
    derive: 'attendance_class',
  },
};

export function publicDefs() {
  return Object.entries(IMPORT_DEFS).sort((a, b) => a[1].order - b[1].order).map(([module, d]) => ({
    module, title: d.title, order: d.order, allowValidOnly: !!d.allowValidOnly, note: d.note || null, schema_version: SCHEMA_VERSION,
    fields: d.fields.map(({ col, ...rest }) => ({ ...rest, update_behavior: rest.required ? 'required on create; blank on update keeps existing' : 'blank keeps existing; __CLEAR__ empties the value' })),
  }));
}

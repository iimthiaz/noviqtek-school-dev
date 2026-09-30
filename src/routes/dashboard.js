import { json, localDate, nowIso } from '../lib/util.js';
import { can, classScope, require } from '../lib/auth.js';

// Every metric is computed from committed, permission-scoped data, with its definition.
export default [
  ['GET', '/api/dashboard', async ({ env, ctx }) => {
    require(ctx, 'dashboard.view');
    const date = localDate(ctx.tenant.timezone);
    const scope = await classScope(env, ctx);
    const sc = scope ? ' AND e.class_id IN (SELECT value FROM json_each(?3))' : '';
    const args = [ctx.tenantId, date, ...(scope ? [JSON.stringify(scope)] : [])];
    const metrics = [];
    if (can(ctx, 'student.view')) {
      const r = await env.DB.prepare(
        `SELECT COUNT(DISTINCT e.student_id) AS c FROM enrollments e JOIN students s ON s.id = e.student_id
          WHERE e.tenant_id = ?1 AND s.status = 'active' AND e.enrollment_status = 'active' AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2)${sc}`
      ).bind(...args).first();
      metrics.push({ key: 'enrolled_students', label_en: 'Enrolled students', label_ar: 'الطلاب المسجلون', value: r.c, link: '#/students', definition: 'Active students with an enrollment covering today' + (scope ? ' in your assigned classes.' : '.') });
    }
    if (can(ctx, 'academic.view')) {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS c, SUM(c.capacity) AS cap FROM classes c JOIN academic_years ay ON ay.id = c.academic_year_id
          WHERE c.tenant_id = ?1 AND c.status = 'active' AND ay.is_current = 1 ${scope ? 'AND c.id IN (SELECT value FROM json_each(?2))' : ''}`
      ).bind(ctx.tenantId, ...(scope ? [JSON.stringify(scope)] : [])).first();
      metrics.push({ key: 'classes', label_en: 'Classes (current year)', label_ar: 'الفصول (العام الحالي)', value: r.c, link: '#/classes', definition: 'Active classes in the academic year marked current.' });
    }
    if (can(ctx, 'attendance.view')) {
      const r = await env.DB.prepare(
        `SELECT COUNT(e.id) AS enrolled, SUM(a.status_code IN ('present','late')) AS present, SUM(a.status_code = 'absent') AS absent,
                SUM(a.status_code = 'late') AS late, SUM(a.id IS NULL) AS unmarked
          FROM enrollments e JOIN students s ON s.id = e.student_id
          LEFT JOIN attendance a ON a.student_id = e.student_id AND a.attendance_date = ?2 AND a.session_code = 'DAY'
          WHERE e.tenant_id = ?1 AND s.status = 'active' AND e.enrollment_status = 'active' AND e.start_date <= ?2 AND (e.end_date IS NULL OR e.end_date >= ?2)${sc}`
      ).bind(...args).first();
      const marked = (r.enrolled || 0) - (r.unmarked || 0);
      metrics.push({ key: 'attendance_rate', label_en: 'Attendance today', label_ar: 'الحضور اليوم', value: marked ? `${Math.round(((r.present || 0) / marked) * 1000) / 10}%` : '—', sub: `${marked}/${r.enrolled || 0} marked`, link: '#/attendance', definition: '(present + late) ÷ students marked today. Unmarked students are excluded, never counted as present.' });
      metrics.push({ key: 'absent_today', label_en: 'Absent today', label_ar: 'الغياب اليوم', value: r.absent || 0, sub: `${r.late || 0} late`, link: '#/attendance', definition: 'Students marked absent for the DAY session today.', tone: (r.absent || 0) ? 'warn' : '' });
      metrics.push({ key: 'unmarked_today', label_en: 'Not yet marked', label_ar: 'غير مسجل بعد', value: r.unmarked || 0, link: '#/attendance', definition: 'Enrolled students with no attendance record today.', tone: (r.unmarked || 0) ? 'info' : '' });
    }
    if (can(ctx, 'dismissal.view')) {
      const r = await env.DB.prepare(
        `SELECT SUM(status = 'called') AS called, SUM(status = 'dismissed') AS dismissed FROM dismissal_records e
          WHERE e.tenant_id = ?1 AND e.dismissal_date = ?2${sc}`
      ).bind(...args).first();
      metrics.push({ key: 'dismissal', label_en: 'Dismissal today', label_ar: 'الانصراف اليوم', value: `${r.dismissed || 0} dismissed`, sub: `${r.called || 0} waiting`, link: '#/dismissal', definition: 'Called = requested for pickup, awaiting teacher release. Dismissed = release confirmed.' });
    }
    if (can(ctx, 'staff.view')) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM staff WHERE tenant_id = ? AND status IN ('active','on_leave')").bind(ctx.tenantId).first();
      metrics.push({ key: 'staff', label_en: 'Staff records', label_ar: 'سجلات الموظفين', value: r.c, link: '#/staff', definition: 'Staff with status active or on leave. Headcount, not full-time equivalent.' });
    }
    let setup = null;
    if (can(ctx, 'tenant.configure')) {
      const c = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM students WHERE tenant_id = ?1) AS students, (SELECT COUNT(*) FROM staff WHERE tenant_id = ?1) AS staff,
                (SELECT COUNT(*) FROM guardians WHERE tenant_id = ?1) AS guardians, (SELECT COUNT(*) FROM users WHERE tenant_id = ?1) AS users,
                (SELECT COUNT(*) FROM academic_years WHERE tenant_id = ?1 AND label LIKE '%confirm dates%') AS unconfirmed_years`
      ).bind(ctx.tenantId).first();
      setup = [
        { done: !c.unconfirmed_years, en: 'Confirm academic year dates (Academics)', ar: 'تأكيد تواريخ العام الدراسي' },
        { done: !!ctx.tenant.logo_data, en: 'Upload school logo and Arabic name (Settings)', ar: 'رفع شعار المدرسة والاسم العربي' },
        { done: c.staff > 0, en: 'Import staff (Import Center)', ar: 'استيراد الموظفين' },
        { done: c.students > 0, en: 'Import students and enrollments', ar: 'استيراد الطلاب والتسجيل' },
        { done: c.guardians > 0, en: 'Import guardians, families and links', ar: 'استيراد أولياء الأمور والعائلات' },
        { done: c.users > 1, en: 'Invite staff users and assign roles', ar: 'دعوة المستخدمين وتعيين الأدوار' },
      ];
    }
    return json({ date, metrics, setup, generated_at: nowIso(), scope: scope ? 'assigned classes' : 'whole school' });
  }],
];

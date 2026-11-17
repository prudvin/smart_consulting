// Designation and department are recorded on each customer assignment. An employee's current values (and customer)
// come from their latest assignment that has started by the given date; if none has started yet, their first upcoming
// one; and for designation/department, if they have no assignments, the values stored on the employee before
// assignments carried them.
// Returns an SQL expression. `alias` is the employees table alias, `dateSql` an SQL expression for the date.
const VALUES = {
  designation: "NULLIF(TRIM(x.designation), '')",
  department: "NULLIF(TRIM(x.department), '')",
  customer: '(SELECT c.name FROM customers c WHERE c.id = x.customer_id)',
};
function currentAssignmentValue(field, alias = 'e', dateSql = "date('now', 'localtime')") {
  if (!VALUES[field]) throw new Error(`Unknown assignment field: ${field}`);
  const value = VALUES[field];
  const stored = field === 'customer' ? 'NULL' : `NULLIF(TRIM(${alias}.${field}), '')`;
  return `COALESCE(
    (SELECT ${value} FROM assignments x WHERE x.employee_id = ${alias}.id AND ${value} IS NOT NULL AND x.start_date <= ${dateSql}
      ORDER BY x.start_date DESC, x.id DESC LIMIT 1),
    (SELECT ${value} FROM assignments x WHERE x.employee_id = ${alias}.id AND ${value} IS NOT NULL ORDER BY x.start_date, x.id LIMIT 1),
    ${stored})`;
}

module.exports = { currentAssignmentValue };
